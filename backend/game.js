// Pure game logic. No I/O, no storage, no clock of its own — `now` is always
// passed in. This is the file to unit-test and the file to trust during the show.

export const EXTEND_MS = 10_000;
// A late voter can see how the room is splitting — the percentages are on the
// wall, live, in front of everybody holding a phone. So can a punctual one, and
// that is the point: this is a poll the room watches itself take, with no right
// option behind it to protect. A vote cast three seconds late saw nothing that
// had not been on the wall for the whole of the countdown.
//
// What rejecting a late vote costs is unchanged: a visible "you were too slow"
// and a depressed number on the projector, and the number is the show. So the
// window stays generous.
export const LATE_VOTE_GRACE_MS = 5000;
export const HISTORY_LIMIT = 20;
// The segment's slot in the run of show, and the default length of it — the
// operator can change the length from the console, but this is what a fresh
// game or a RESET comes back to. Display only: no phase reads the clock built
// from it and no vote is gated on it. An operator running two minutes over is
// making a judgement call, not committing a fault the server should correct
// for them.
export const GAME_DURATION_MS = 15 * 60_000;

// How long the doors stay open, and the step the operator moves that in.
//
// A second clock, not a second view of the one above. They differ in every way
// that matters: the segment clock paces the whole slot and is the operator's
// business alone, while this one is on the wall in front of the room, telling
// three hundred people how long they have to scan. Sharing one clock between
// those two jobs would mean the segment length and the join window could never
// disagree, and they are never the same number.
//
// Display only, exactly like the segment clock: no phase reads it and no vote
// is gated on it. Reaching zero closes nothing — the doors shut when the
// operator presses 开始本题, which is the only thing that ever ends LOBBY.
export const JOIN_DURATION_MS = 5 * 60_000;
export const JOIN_ADJUST_MS = 60_000;
// The same 1..120 minute band the console's segment presets live in, so the
// two clocks cannot be configured into shapes the other could not hold.
export const JOIN_MIN_MS = 60_000;
export const JOIN_MAX_MS = 120 * 60_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const PHASES = ["LOBBY", "VOTING", "LOCKED", "REVEAL", "FINAL"];

// The wire format for a choice: six opaque keys, of which a question offers the
// first N. The state machine, the tally, the dedup records and the DynamoDB
// transactions are all built on the key and none of them know what it means —
// the labels live in the question's authored content, where the setup page can
// rewrite them without touching any of this.
export const OPTION_KEYS = ["a", "b", "c", "d", "e", "f"];
// Two is the floor a poll needs to be a poll, and it is what deleting stops at.
export const MIN_OPTIONS = 2;

export function initialState(epoch = 0) {
  // `epoch` identifies one run of the game. It changes only on RESET, and it is
  // how a phone knows the choices it remembers belong to a previous round. The
  // in-memory store starts each process on a fresh one for the same reason —
  // see server.js.
  return {
    phase: "LOBBY",
    qIndex: 0,
    phaseEndsAt: null,
    // The segment clock, driven entirely by the operator's TIMER_* actions
    // below — nothing else in this file ever sets these. Three mutually
    // exclusive modes and no extra flag: idle (both null), running
    // (`gameEndsAt` set), paused (`gamePausedMs` set). RESET goes through
    // this function, so a rehearsal reset also forgets a custom length and
    // returns to the default — that is intended, not an oversight.
    gameEndsAt: null,
    gamePausedMs: null,
    gameDurationMs: GAME_DURATION_MS,
    // The join clock, driven entirely by the operator's JOIN_* actions below.
    // Two modes rather than the segment clock's three, and no `joinPausedMs`
    // to hold the third: a join window is open or it is shut. Pausing the
    // countdown the room is reading, while the room keeps reading it, is not a
    // thing an operator ever means to do.
    joinEndsAt: null,
    joinDurationMs: JOIN_DURATION_MS,
    replayAt: 0,
    epoch,
    updatedAt: 0,
    history: [],
    // Operator-controlled, projector-only. Off by default so a fresh room
    // never opens on a wall of rules text.
    showRules: false,
    // Offline mode: the host runs the activity in the room, by show of hands,
    // and the phones are not part of it. While this is on no vote is taken,
    // and every surface drops what only makes sense with phones — the QR, the
    // percentages, the reveal. Set from the setup page, in a lobby only.
    //
    // It is a setting, not progress through the show, so it is the one field
    // here that RESET does not put back: the router carries it across (see
    // POST /admin there). It lives in memory with the rest of this state; the
    // DynamoDB adapter names each attribute it persists and does not know
    // this one.
    offline: false,
  };
}

// History entries are compact strings so the whole undo stack stays small enough
// to ride along on the single DynamoDB state item.
function snap(s) {
  return `${s.phase}|${s.qIndex}|${s.phaseEndsAt ?? ""}`;
}

function unsnap(str) {
  const [phase, qIndex, endsAt] = str.split("|");
  return { phase, qIndex: Number(qIndex), phaseEndsAt: endsAt === "" ? null : Number(endsAt) };
}

/**
 * Apply an operator action.
 * @returns {{ok: true, state: object} | {ok: false, code: string}}
 */
export function reduce(state, action, { questions, now, minutes }) {
  const total = questions.length;
  const fail = (code) => ({ ok: false, code });
  const openVoting = (i) => ({
    phase: "VOTING",
    qIndex: i,
    phaseEndsAt: now + (questions[i].duration ?? 45) * 1000,
  });
  const final = () => ({ phase: "FINAL", qIndex: state.qIndex, phaseEndsAt: null });

  let next;
  switch (action) {
    case "START":
      if (state.phase === "LOBBY") {
        next = openVoting(state.qIndex);
      } else if (state.phase === "REVEAL") {
        // Shortcut out of REVEAL: skip the LOBBY beat and open the next question
        // in one click. See README "Operator console" for why this exists.
        next = state.qIndex + 1 >= total ? final() : openVoting(state.qIndex + 1);
      } else {
        return fail("WRONG_PHASE");
      }
      break;

    case "LOCK":
      if (state.phase !== "VOTING") return fail("WRONG_PHASE");
      next = { phase: "LOCKED", qIndex: state.qIndex, phaseEndsAt: null };
      break;

    case "EXTEND":
      if (state.phase !== "VOTING") return fail("WRONG_PHASE");
      // If the countdown already ran out, extend from now — that is what the
      // operator means when they hit +10s on a dead clock.
      next = {
        phase: "VOTING",
        qIndex: state.qIndex,
        phaseEndsAt: Math.max(state.phaseEndsAt ?? now, now) + EXTEND_MS,
      };
      break;

    case "REVEAL":
      // Valid from LOCKED, and from VOTING once the countdown has expired —
      // the server never auto-closes voting, so an expired VOTING is the normal
      // state to reveal from.
      if (votingIsOver(state, now)) {
        next = { phase: "REVEAL", qIndex: state.qIndex, phaseEndsAt: null };
      } else {
        return fail("WRONG_PHASE");
      }
      break;

    case "NEXT":
      // From LOBBY this means "skip this question". The run of show says to
      // drop a question when running long, but every path from one lobby to
      // the next went through VOTING and REVEAL — so skipping required putting
      // the question on the projector and publishing a split nobody had voted
      // on first.
      //
      // LOBBY -> FINAL is refused deliberately: from the last question's lobby
      // one mis-click would otherwise end the segment.
      if (state.phase === "LOBBY") {
        if (state.qIndex + 1 >= total) return fail("WRONG_PHASE");
        next = { phase: "LOBBY", qIndex: state.qIndex + 1, phaseEndsAt: null };
        break;
      }
      // Offline there is no split to publish, so there is no REVEAL to pass
      // through: the question is over when the host says so, and NEXT leaves
      // from exactly where REVEAL would have been allowed — LOCKED, or VOTING
      // once the countdown has run out. Online that same press is still
      // refused, which is what keeps a question from being walked past with
      // its votes unpublished.
      if (state.phase !== "REVEAL" && !(state.offline && votingIsOver(state, now))) {
        return fail("WRONG_PHASE");
      }
      next =
        state.qIndex + 1 >= total
          ? final()
          : { phase: "LOBBY", qIndex: state.qIndex + 1, phaseEndsAt: null };
      break;

    // Audio questions need to be heard more than once inside a 45-second
    // window, and the projector is not somewhere the operator can reach
    // mid-talk. This nudges a timestamp the screen watches; it changes no
    // phase, so it deliberately does not go on the undo stack.
    case "REPLAY":
      if (state.phase !== "VOTING" && state.phase !== "LOCKED" && state.phase !== "REVEAL") {
        return fail("WRONG_PHASE");
      }
      return { ok: true, state: { ...state, replayAt: now } };

    // Rules are the whole screen (see Screen.jsx), so they must never be able
    // to cover a live question — LOBBY only, refused elsewhere rather than a
    // silent no-op, so a stray click surfaces instead of appearing to do
    // nothing. Same treatment as REPLAY above: a flag flip is not a phase
    // change, so it skips the phase/qIndex/phaseEndsAt fields entirely and
    // deliberately does not go on the undo stack.
    case "TOGGLE_RULES":
      if (state.phase !== "LOBBY") return fail("WRONG_PHASE");
      return { ok: true, state: { ...state, showRules: !state.showRules } };

    // Offline mode on, and off. Two actions that each say where to end up, not
    // one toggle: the switch is on the setup page, which can sit open on a
    // laptop for an hour, and a toggle pressed from a stale page flips the
    // room the wrong way. Pressing either twice changes nothing.
    //
    // LOBBY only, like the rules above and for a sharper reason. Switching
    // while a question is open would take the buttons off three hundred phones
    // mid-vote, or put them on half-way through a show of hands. A lobby —
    // the first one or any between two questions — is the one moment nobody
    // is in the middle of anything. A setting, not a step in the show, so it
    // stays off the undo stack: BACK must not switch the mode.
    case "OFFLINE_ON":
    case "OFFLINE_OFF":
      if (state.phase !== "LOBBY") return fail("WRONG_PHASE");
      return { ok: true, state: { ...state, offline: action === "OFFLINE_ON" } };

    // The segment clock. Deliberately not a phase field: it moves independent
    // of START/LOCK/REVEAL/NEXT, and a switch on `state.gameEndsAt` /
    // `state.gamePausedMs` alone is enough to tell idle, running and paused
    // apart, so no fourth "mode" flag exists to drift out of sync with them.
    // Same shape as REPLAY above and for the same reason: this is a stopwatch,
    // not a step in the run of show, so it returns early rather than going
    // through the tail block and does not land on the undo stack. BACK is for
    // giving the projector back a step, not for giving the room back minutes.
    case "TIMER_START":
      if (state.gameEndsAt != null) return fail("TIMER_RUNNING");
      return {
        ok: true,
        state: {
          ...state,
          // From idle this arms the full configured length; from paused it
          // resumes from exactly what was frozen, not from the top.
          gameEndsAt: now + (state.gamePausedMs ?? state.gameDurationMs ?? GAME_DURATION_MS),
          gamePausedMs: null,
        },
      };

    case "TIMER_PAUSE":
      if (state.gameEndsAt == null) return fail("TIMER_NOT_RUNNING");
      return {
        ok: true,
        state: {
          ...state,
          // Clamped at zero rather than going negative — a pause pressed after
          // the face already reads 0:00 freezes at 0:00, not at some negative
          // number nothing on the console is built to show.
          gamePausedMs: Math.max(0, state.gameEndsAt - now),
          gameEndsAt: null,
        },
      };

    // Valid from any mode — idle, running or paused — because "stop and go
    // back to the configured length" is a sensible thing to press from all
    // three, and refusing it from one of them would just be a click the
    // operator has to route around mid-show.
    case "TIMER_RESET":
      return { ok: true, state: { ...state, gameEndsAt: null, gamePausedMs: null } };

    // Idle only: changing the length of a clock that is already counting down
    // would silently move the finish line out from under whoever is watching
    // it. Out of scope on purpose — see #34 — which is also why there is no
    // "add 10s while running" here.
    case "TIMER_SET":
      if (state.gameEndsAt != null || state.gamePausedMs != null) return fail("TIMER_RUNNING");
      return { ok: true, state: { ...state, gameDurationMs: minutes * 60_000 } };

    // The join clock. Same early-return shape as the TIMER_* actions above and
    // for the same reasons: a stopwatch is not a step in the run of show, so it
    // skips the phase fields and stays off the undo stack.
    //
    // Not gated on LOBBY, unlike TOGGLE_RULES. The render guard on /screen
    // already stops it reaching the wall outside LOBBY, and refusing the action
    // here would mean an operator who starts a question with the clock running
    // cannot then stop it — the state would be stuck running, invisible, until
    // the next lobby.
    case "JOIN_START":
      if (state.joinEndsAt != null) return fail("JOIN_RUNNING");
      return {
        ok: true,
        state: { ...state, joinEndsAt: now + (state.joinDurationMs ?? JOIN_DURATION_MS) },
      };

    // Valid from either mode, like TIMER_RESET: "shut the doors" is a sensible
    // thing to press when they are already shut, and refusing it would just be
    // a click the operator has to route around mid-show.
    case "JOIN_STOP":
      return { ok: true, state: { ...state, joinEndsAt: null } };

    // One action for ±1 分钟, and what it moves depends on whether the clock is
    // running. This is the deliberate difference from TIMER_SET, which is idle
    // only: moving the finish line under a segment clock nobody can see is a
    // silent surprise, but stretching a join window while the count is still
    // climbing is the entire reason this clock exists. `minutes` is a signed
    // delta here, not the absolute length TIMER_SET takes.
    case "JOIN_ADJUST": {
      const delta = minutes * JOIN_ADJUST_MS;
      // Stopped: move the length the next start will use.
      if (state.joinEndsAt == null) {
        const length = clamp(
          (state.joinDurationMs ?? JOIN_DURATION_MS) + delta,
          JOIN_MIN_MS,
          JOIN_MAX_MS,
        );
        return { ok: true, state: { ...state, joinDurationMs: length } };
      }
      // Running: move the deadline itself, without restarting it. Floored at
      // `now` so −1 分 on a nearly-dead clock lands on 0:00 rather than a
      // negative the projector has no way to render.
      return {
        ok: true,
        state: { ...state, joinEndsAt: clamp(state.joinEndsAt + delta, now, now + JOIN_MAX_MS) },
      };
    }

    // Jump straight to a length, from the console's 1/3/5 chips or its custom
    // field. Stopped only, exactly like TIMER_SET and for the same reason:
    // JOIN_ADJUST nudges by a minute and is safe to hit at any time, but this
    // one replaces the number outright, and doing that to a window the room is
    // already watching count down is the mis-hit worth designing out. The
    // console hides these controls while running; this is the server half of
    // the same rule, so a stale tab cannot get round it.
    case "JOIN_SET":
      if (state.joinEndsAt != null) return fail("JOIN_RUNNING");
      return { ok: true, state: { ...state, joinDurationMs: minutes * 60_000 } };

    case "BACK": {
      const history = state.history ?? [];
      if (history.length === 0) return fail("NOTHING_TO_UNDO");
      return {
        ok: true,
        state: {
          ...unsnap(history[history.length - 1]),
          // Everything that is not a phase: carried, never rewound. `snap` only
          // ever encoded phase|qIndex|phaseEndsAt, so anything not named here
          // came back as a default — which is how undo used to reset replayAt
          // to 0 and make the projector replay the clip it had just finished,
          // and how it dropped the epoch that tells phones which run they are
          // in. The segment clock goes the same way, all three fields of it:
          // undo puts the projector back a step, it does not give the room
          // back the minutes, and it does not stop a clock that is running.
          replayAt: state.replayAt ?? 0,
          epoch: state.epoch ?? 0,
          showRules: state.showRules ?? false,
          // The mode the room is in is not something undo steps back through.
          offline: state.offline ?? false,
          gameEndsAt: state.gameEndsAt ?? null,
          gamePausedMs: state.gamePausedMs ?? null,
          gameDurationMs: state.gameDurationMs ?? GAME_DURATION_MS,
          // And the join clock the same way, for the same reason: undo is for
          // the projector's last step, not for reopening a door the operator
          // has already shut, nor for shutting one they left open.
          joinEndsAt: state.joinEndsAt ?? null,
          joinDurationMs: state.joinDurationMs ?? JOIN_DURATION_MS,
          history: history.slice(0, -1),
        },
      };
    }

    default:
      return fail("UNKNOWN_ACTION");
  }

  return {
    ok: true,
    state: {
      ...next,
      // Carried, not reset: a phase change is not a reason to replay audio,
      // and the projector plays on mount anyway. Same logic for showRules —
      // starting the next question hides it via the LOBBY-only render guard
      // on /screen, not by the flag being cleared out from under the operator.
      replayAt: state.replayAt ?? 0,
      epoch: state.epoch ?? 0,
      showRules: state.showRules ?? false,
      // Carried, and only ever changed by OFFLINE_ON / OFFLINE_OFF above: a
      // show that starts offline stays offline through every question.
      offline: state.offline ?? false,
      // Carried, never armed here: the segment clock used to start itself the
      // instant the first question opened, which was already wrong by the
      // time it started — the fifteen minutes has to cover the lobby's rules
      // explanation, before anything is on the wall. Starting it is now
      // TIMER_START's job alone, above, so no phase branch may set it. Named
      // here rather than in each branch because a field one branch adds to
      // `next` is a field every other branch silently drops.
      gameEndsAt: state.gameEndsAt ?? null,
      gamePausedMs: state.gamePausedMs ?? null,
      gameDurationMs: state.gameDurationMs ?? GAME_DURATION_MS,
      // Carried, never armed and never cleared here. Starting a question does
      // not stop the join clock — /screen simply stops drawing it, the same way
      // showRules above survives the transition rather than being reset out
      // from under the operator. Coming BACK to LOBBY finds it where it was.
      joinEndsAt: state.joinEndsAt ?? null,
      joinDurationMs: state.joinDurationMs ?? JOIN_DURATION_MS,
      history: [...(state.history ?? []), snap(state)].slice(-HISTORY_LIMIT),
    },
  };
}

/**
 * Has this question stopped taking answers? LOCKED says so outright; VOTING
 * says so once its countdown has run out, because the server never closes a
 * question by itself. This is the moment REVEAL is allowed from, and — offline,
 * where there is nothing to reveal — the moment NEXT is.
 */
function votingIsOver(state, now) {
  return state.phase === "LOCKED" || (state.phase === "VOTING" && now > (state.phaseEndsAt ?? 0));
}

/**
 * Gate a single vote. Order matters: the mode, then phase, then cutoff. Dedup
 * happens in the store because only the database can decide it atomically.
 */
export function validateVote(state, { qIndex, choice }, now) {
  // Only the key space is checked, not the question's current option list.
  // Checking against the labels would mean reading the content record on the
  // one path that has to survive three hundred people voting in the same
  // second, to defend against a hand-crafted request whose only effect is a
  // count on a key nothing renders.
  if (!OPTION_KEYS.includes(choice)) return { ok: false, code: "BAD_CHOICE", status: 400 };
  // Offline mode: nothing is being collected, whatever the phase. Its own code
  // rather than WRONG_PHASE, so a phone that still has buttons on screen from
  // a moment ago is told the truth — this is not a question it was too early
  // or too late for.
  if (state.offline) return { ok: false, code: "OFFLINE", status: 409 };
  if (state.phase !== "VOTING" || qIndex !== state.qIndex) {
    return { ok: false, code: "WRONG_PHASE", status: 409 };
  }
  if (now > (state.phaseEndsAt ?? 0) + LATE_VOTE_GRACE_MS) {
    return { ok: false, code: "EXPIRED", status: 409 };
  }
  return { ok: true };
}

/**
 * When the room can see how it is splitting, and the whole of the visibility
 * rule: from the moment a question opens.
 *
 * The poll is shown in real time — the percentages move on the wall while the
 * countdown runs — so VOTING and LOCKED are public, and REVEAL and FINAL after
 * them. There is no answer behind the counts to keep back, which is the only
 * thing that ever made a later phase different from an earlier one. LOBBY is
 * the one phase with nothing to show: no question has opened, so there is
 * nothing yet to count.
 */
export function tallyVisible(phase) {
  return phase === "VOTING" || phase === "LOCKED" || phase === "REVEAL" || phase === "FINAL";
}
