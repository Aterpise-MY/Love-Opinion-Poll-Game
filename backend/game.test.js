import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_DURATION_MS,
  JOIN_DURATION_MS,
  JOIN_MAX_MS,
  JOIN_MIN_MS,
  PHASES,
  initialState,
  reduce,
  tallyVisible,
  validateVote,
} from "./game.js";

const QUESTIONS = [
  { id: "q1", duration: 40 },
  { id: "q2", duration: 50 },
];

const NOW = 1_700_000_000_000;
const step = (state, action, now = NOW, extra = {}) =>
  reduce(state, action, { questions: QUESTIONS, now, ...extra });

function run(actions, now = NOW) {
  let state = initialState();
  for (const action of actions) {
    const result = step(state, action, now);
    assert.ok(result.ok, `${action} failed: ${result.code}`);
    state = { ...result.state, updatedAt: now };
  }
  return state;
}

test("START opens voting with a server-side deadline", () => {
  const state = run(["START"]);
  assert.equal(state.phase, "VOTING");
  assert.equal(state.phaseEndsAt, NOW + 40_000);
});

test("EXTEND adds 10s, and extends from now if the clock already ran out", () => {
  const voting = run(["START"]);
  assert.equal(step(voting, "EXTEND").state.phaseEndsAt, voting.phaseEndsAt + 10_000);

  const late = NOW + 60_000;
  assert.equal(step(voting, "EXTEND", late).state.phaseEndsAt, late + 10_000);
});

test("REVEAL is allowed from LOCKED, and from an expired VOTING", () => {
  const voting = run(["START"]);
  assert.equal(step(voting, "REVEAL").ok, false, "cannot reveal while the clock is still running");
  assert.equal(step(voting, "REVEAL", NOW + 41_000).ok, true, "expired voting can be revealed");
  assert.equal(step(run(["START", "LOCK"]), "REVEAL").ok, true);
});

test("NEXT walks to the next question, then to FINAL after the last", () => {
  const afterQ1 = run(["START", "LOCK", "REVEAL", "NEXT"]);
  assert.equal(afterQ1.phase, "LOBBY");
  assert.equal(afterQ1.qIndex, 1);

  const end = run(["START", "LOCK", "REVEAL", "NEXT", "START", "LOCK", "REVEAL", "NEXT"]);
  assert.equal(end.phase, "FINAL");
});

test("START from REVEAL skips the lobby beat and opens the next question", () => {
  const state = run(["START", "LOCK", "REVEAL", "START"]);
  assert.equal(state.phase, "VOTING");
  assert.equal(state.qIndex, 1);
  assert.equal(state.phaseEndsAt, NOW + 50_000, "uses q2's own duration");
});

test("BACK undoes one step at a time, including across a question boundary", () => {
  let state = run(["START", "LOCK", "REVEAL", "NEXT"]);
  assert.deepEqual([state.phase, state.qIndex], ["LOBBY", 1]);

  state = step(state, "BACK").state;
  assert.deepEqual([state.phase, state.qIndex], ["REVEAL", 0]);

  state = step(state, "BACK").state;
  assert.deepEqual([state.phase, state.qIndex], ["LOCKED", 0]);

  state = step(state, "BACK").state;
  assert.equal(state.phase, "VOTING");
  assert.equal(state.phaseEndsAt, NOW + 40_000, "the original deadline comes back with it");

  state = step(state, "BACK").state;
  assert.equal(state.phase, "LOBBY");
  assert.equal(step(state, "BACK").code, "NOTHING_TO_UNDO");
});

test("NEXT from LOBBY skips the question without putting it on screen", () => {
  const lobby = initialState();
  const skipped = step(lobby, "NEXT").state;
  assert.deepEqual([skipped.phase, skipped.qIndex], ["LOBBY", 1]);

  // Back must undo a skip — the operator has to be able to change their mind.
  assert.deepEqual(
    [step(skipped, "BACK").state.phase, step(skipped, "BACK").state.qIndex],
    ["LOBBY", 0],
  );
});

test("NEXT from the last question's LOBBY is refused, so one mis-click cannot end the show", () => {
  const lastLobby = run(["START", "LOCK", "REVEAL", "NEXT"]);
  assert.deepEqual([lastLobby.phase, lastLobby.qIndex], ["LOBBY", 1]);
  assert.equal(step(lastLobby, "NEXT").code, "WRONG_PHASE");
});

test("actions are rejected outside their phase", () => {
  const lobby = initialState();
  // NEXT is deliberately absent — in LOBBY it now means "skip this question",
  // covered by its own tests above.
  for (const action of ["LOCK", "EXTEND", "REVEAL"]) {
    assert.equal(step(lobby, action).code, "WRONG_PHASE", action);
  }
  assert.equal(step(run(["START"]), "START").code, "WRONG_PHASE");
  assert.equal(step(lobby, "NOPE").code, "UNKNOWN_ACTION");
});

test("the tally is visible from the moment a question opens, and not in the lobby", () => {
  // The whole visibility rule is this one predicate, so every phase is named.
  // The poll is shown in real time, so an open question and a locked one are
  // as public as a revealed one; the lobby has nothing yet to count.
  assert.equal(tallyVisible("LOBBY"), false, "LOBBY");
  for (const phase of ["VOTING", "LOCKED", "REVEAL", "FINAL"]) {
    assert.equal(tallyVisible(phase), true, phase);
  }
  // And those five are every phase there is — a sixth one added to PHASES has
  // to be put on one side or the other here, deliberately.
  assert.deepEqual(PHASES, ["LOBBY", "VOTING", "LOCKED", "REVEAL", "FINAL"]);
});

test("START and NEXT never arm the segment clock — the auto-start is gone", () => {
  assert.equal(initialState().gameEndsAt, null, "nothing is running before the show does");

  // Every phase-changing action, run back to back, leaves the clock exactly
  // where it started: idle. This used to be the action that armed it the
  // moment the first question opened — before the lobby's rules explanation
  // even happened — which is the bug this whole change exists to fix.
  let state = initialState();
  for (const [action, at] of [
    ["START", NOW + 1000],
    ["LOCK", NOW + 2000],
    ["REVEAL", NOW + 3000],
    ["START", NOW + 4000],
    ["EXTEND", NOW + 5000],
    ["REPLAY", NOW + 6000],
    ["LOCK", NOW + 7000],
    ["REVEAL", NOW + 8000],
    ["NEXT", NOW + 9000],
  ]) {
    const result = step(state, action, at);
    assert.ok(result.ok, `${action}: ${result.code}`);
    state = { ...result.state, updatedAt: at };
    assert.equal(state.gameEndsAt, null, `after ${action}`);
    assert.equal(state.gamePausedMs, null, `after ${action}`);
    assert.equal(state.gameDurationMs, GAME_DURATION_MS, `after ${action}`);
  }
});

test("TIMER_START arms the clock from idle, and only from idle", () => {
  const lobby = initialState();
  const started = step(lobby, "TIMER_START", NOW).state;
  assert.equal(started.gameEndsAt, NOW + GAME_DURATION_MS);
  assert.equal(started.gamePausedMs, null);

  // Pressing it again while it is already running is refused, not restarted —
  // a second click must not give the room a fresh fifteen minutes.
  const again = step(started, "TIMER_START", NOW + 1000);
  assert.equal(again.ok, false);
  assert.equal(again.code, "TIMER_RUNNING");
});

test("TIMER_PAUSE freezes the remainder; TIMER_START resumes from it, not from the top", () => {
  const started = step(initialState(), "TIMER_START", NOW).state;

  const elapsed = 90_000;
  const paused = step(started, "TIMER_PAUSE", NOW + elapsed).state;
  assert.equal(paused.gameEndsAt, null);
  assert.equal(paused.gamePausedMs, GAME_DURATION_MS - elapsed);

  // Pausing again is refused — there is nothing running to freeze.
  const doublePause = step(paused, "TIMER_PAUSE", NOW + elapsed + 1000);
  assert.equal(doublePause.ok, false);
  assert.equal(doublePause.code, "TIMER_NOT_RUNNING");

  const resumedAt = NOW + 500_000;
  const resumed = step(paused, "TIMER_START", resumedAt).state;
  assert.equal(
    resumed.gameEndsAt,
    resumedAt + (GAME_DURATION_MS - elapsed),
    "resumes from the frozen value, not from a fresh gameDurationMs",
  );
  assert.equal(resumed.gamePausedMs, null);
});

test("TIMER_PAUSE clamps at zero rather than freezing a negative number", () => {
  const started = step(initialState(), "TIMER_START", NOW).state;
  const pastZero = step(started, "TIMER_PAUSE", NOW + GAME_DURATION_MS + 30_000).state;
  assert.equal(pastZero.gamePausedMs, 0);
});

test("TIMER_RESET clears the clock from idle, running or paused, and touches nothing else", () => {
  for (const state of [
    initialState(),
    step(initialState(), "TIMER_START", NOW).state,
    step(step(initialState(), "TIMER_START", NOW).state, "TIMER_PAUSE", NOW + 1000).state,
  ]) {
    const reset = step(state, "TIMER_RESET", NOW + 2000);
    assert.ok(reset.ok);
    assert.equal(reset.state.gameEndsAt, null);
    assert.equal(reset.state.gamePausedMs, null);
    // The face returns to the configured length, not to GAME_DURATION_MS
    // specifically — a custom TIMER_SET length must survive a plain reset.
    assert.equal(reset.state.gameDurationMs, state.gameDurationMs);
    assert.equal(reset.state.phase, state.phase, "no phase moves");
  }
});

test("TIMER_SET changes the configured length from idle, and is refused while running or paused", () => {
  const idle = initialState();
  const tenMin = step(idle, "TIMER_SET", NOW, { minutes: 10 }).state;
  assert.equal(tenMin.gameDurationMs, 10 * 60_000);

  // A later start uses the new length.
  assert.equal(step(tenMin, "TIMER_START", NOW).state.gameEndsAt, NOW + 10 * 60_000);

  const running = step(tenMin, "TIMER_START", NOW).state;
  const whileRunning = step(running, "TIMER_SET", NOW + 1000, { minutes: 20 });
  assert.equal(whileRunning.ok, false);
  assert.equal(whileRunning.code, "TIMER_RUNNING");

  const paused = step(running, "TIMER_PAUSE", NOW + 1000).state;
  const whilePaused = step(paused, "TIMER_SET", NOW + 2000, { minutes: 20 });
  assert.equal(whilePaused.ok, false);
  assert.equal(whilePaused.code, "TIMER_RUNNING");
});

test("timer actions never touch the undo stack, the way REPLAY doesn't", () => {
  const lobby = initialState();
  assert.equal(lobby.history.length, 0);

  let state = step(lobby, "TIMER_START", NOW).state;
  state = step(state, "TIMER_PAUSE", NOW + 1000).state;
  state = step(state, "TIMER_RESET", NOW + 2000).state;
  state = step(state, "TIMER_SET", NOW + 3000, { minutes: 20 }).state;
  assert.equal(state.history.length, 0, "no timer action is a step BACK can undo");
});

test("undo puts the phase back and nothing else — it does not rewind the clock or replay the clip", () => {
  // The regression this guards: `snap` only ever encoded phase|qIndex|
  // phaseEndsAt, so everything else came back as a default. replayAt reset to 0
  // is a change the projector notices, and what it does about it is replay the
  // question's audio and video in front of the room.
  const played = run(["START", "REPLAY"]);
  assert.ok(played.replayAt > 0);

  const back = step({ ...played, epoch: 77 }, "BACK", NOW + 9000);
  assert.ok(back.ok);
  assert.equal(back.state.phase, "LOBBY", "the phase is what undo is for");
  assert.equal(back.state.replayAt, played.replayAt, "not rewound to 0");
  assert.equal(back.state.epoch, 77, "phones stay in the run they are in");
});

test("BACK preserves a running segment clock — undo rewinds the projector, not the room's minutes", () => {
  const running = step(run(["START"]), "TIMER_START", NOW).state;
  assert.ok(running.gameEndsAt != null, "sanity: the clock really is running");

  const back = step(running, "BACK", NOW + 5000);
  assert.ok(back.ok);
  assert.equal(back.state.phase, "LOBBY", "the phase did rewind");
  assert.equal(back.state.gameEndsAt, running.gameEndsAt, "the running clock did not");
  assert.equal(back.state.gamePausedMs, null);
  assert.equal(back.state.gameDurationMs, running.gameDurationMs);
});

test("BACK preserves a paused segment clock and a custom configured length", () => {
  // The clock is idle whenever START hasn't been paired with TIMER_START, so
  // the game phase can be anywhere — VOTING here — while TIMER_SET is legal.
  const idle = run(["START"]);
  const withLength = step(idle, "TIMER_SET", NOW, { minutes: 25 }).state;
  const started = step(withLength, "TIMER_START", NOW).state;
  const paused = step(started, "TIMER_PAUSE", NOW + 10_000).state;

  const back = step(paused, "BACK", NOW + 11_000);
  assert.ok(back.ok);
  assert.equal(back.state.gamePausedMs, paused.gamePausedMs, "the frozen value survives undo");
  assert.equal(back.state.gameEndsAt, null);
  assert.equal(back.state.gameDurationMs, 25 * 60_000, "the configured length survives undo too");
});

test("a fresh state starts with rules hidden", () => {
  assert.equal(initialState().showRules, false);
});

test("TOGGLE_RULES flips the flag from LOBBY, touching nothing else", () => {
  const lobby = initialState();
  const shown = step(lobby, "TOGGLE_RULES");
  assert.equal(shown.ok, true);
  assert.equal(shown.state.showRules, true);
  assert.equal(shown.state.phase, "LOBBY");
  assert.equal(shown.state.qIndex, 0);
  assert.equal(shown.state.phaseEndsAt, null);

  const hidden = step(shown.state, "TOGGLE_RULES");
  assert.equal(hidden.state.showRules, false);
});

test("TOGGLE_RULES is refused outside LOBBY — a flag flip must never black out a live question", () => {
  assert.equal(step(run(["START"]), "TOGGLE_RULES").code, "WRONG_PHASE");
  assert.equal(step(run(["START", "LOCK"]), "TOGGLE_RULES").code, "WRONG_PHASE");
  assert.equal(step(run(["START", "LOCK", "REVEAL"]), "TOGGLE_RULES").code, "WRONG_PHASE");
});

test("TOGGLE_RULES never touches the undo stack, the way REPLAY doesn't", () => {
  const lobby = initialState();
  assert.equal(lobby.history.length, 0);
  const shown = step(lobby, "TOGGLE_RULES").state;
  assert.equal(shown.history.length, 0, "a flag flip is not a step BACK can undo");
});

// ---------------------------------------------------------------------------
// The join clock (#47). A second clock, deliberately not a second view of the
// segment clock above: five minutes rather than fifteen, on the wall rather
// than on the console, and open/shut rather than idle/running/paused.
// ---------------------------------------------------------------------------

test("a fresh state starts with the join clock stopped, at five minutes", () => {
  const fresh = initialState();
  assert.equal(fresh.joinEndsAt, null, "stopped means invisible on /screen");
  assert.equal(fresh.joinDurationMs, JOIN_DURATION_MS);
  assert.equal(JOIN_DURATION_MS, 5 * 60_000, "five minutes is the documented default");
});

test("JOIN_START arms the clock from stopped, and only from stopped", () => {
  const started = step(initialState(), "JOIN_START", NOW).state;
  assert.equal(started.joinEndsAt, NOW + JOIN_DURATION_MS);

  const again = step(started, "JOIN_START", NOW + 1000);
  assert.equal(again.ok, false);
  assert.equal(again.code, "JOIN_RUNNING", "a second press must not silently restart the window");
});

test("JOIN_STOP shuts the window from either mode, and leaves the length alone", () => {
  const running = step(initialState(), "JOIN_START", NOW).state;
  const stopped = step(running, "JOIN_STOP", NOW + 5000).state;
  assert.equal(stopped.joinEndsAt, null);
  assert.equal(stopped.joinDurationMs, JOIN_DURATION_MS, "the next start still has a length");

  // Pressing stop on an already-stopped clock is a no-op, not a refusal — the
  // operator should never have to route around a button mid-show.
  const again = step(stopped, "JOIN_STOP", NOW + 6000);
  assert.equal(again.ok, true);
  assert.equal(again.state.joinEndsAt, null);
});

test("JOIN_ADJUST moves the live deadline while running, without restarting it", () => {
  const running = step(initialState(), "JOIN_START", NOW).state;

  const plus = step(running, "JOIN_ADJUST", NOW + 30_000, { minutes: 1 }).state;
  assert.equal(plus.joinEndsAt, running.joinEndsAt + 60_000, "exactly one minute later");
  assert.equal(
    plus.joinDurationMs,
    JOIN_DURATION_MS,
    "stretching the live window does not redefine the configured length",
  );

  const minus = step(plus, "JOIN_ADJUST", NOW + 31_000, { minutes: -1 }).state;
  assert.equal(minus.joinEndsAt, running.joinEndsAt, "back where it started");
});

test("JOIN_ADJUST floors a running clock at now, never at a negative face", () => {
  const running = step(initialState(), "JOIN_START", NOW).state;
  // Ten minutes off a five-minute window: the deadline lands in the past.
  const at = NOW + 10_000;
  const shrunk = step(running, "JOIN_ADJUST", at, { minutes: -10 }).state;
  assert.equal(shrunk.joinEndsAt, at, "0:00, which is what the projector can draw");
  assert.ok(shrunk.joinEndsAt >= at, "never behind the clock reading it");
});

test("JOIN_ADJUST moves the configured length while stopped, and /screen still shows nothing", () => {
  const stopped = initialState();
  const longer = step(stopped, "JOIN_ADJUST", NOW, { minutes: 1 }).state;
  assert.equal(longer.joinDurationMs, JOIN_DURATION_MS + 60_000);
  assert.equal(longer.joinEndsAt, null, "adjusting a stopped clock does not start it");

  // And that new length is what the next start actually arms.
  assert.equal(step(longer, "JOIN_START", NOW).state.joinEndsAt, NOW + 6 * 60_000);
});

test("JOIN_ADJUST clamps the configured length to the 1..120 minute band", () => {
  const floor = step(initialState(), "JOIN_ADJUST", NOW, { minutes: -60 }).state;
  assert.equal(floor.joinDurationMs, JOIN_MIN_MS, "one minute is as short as it goes");

  let state = initialState();
  for (let i = 0; i < 4; i += 1) {
    state = step(state, "JOIN_ADJUST", NOW, { minutes: 60 }).state;
  }
  assert.equal(state.joinDurationMs, JOIN_MAX_MS, "two hours is as long as it goes");
});

test("JOIN_SET jumps straight to a length while stopped, and is refused while running", () => {
  const threeMin = step(initialState(), "JOIN_SET", NOW, { minutes: 3 }).state;
  assert.equal(threeMin.joinDurationMs, 3 * 60_000);
  assert.equal(threeMin.joinEndsAt, null, "setting a length does not start the clock");

  // And that length is what the next start arms.
  const running = step(threeMin, "JOIN_START", NOW).state;
  assert.equal(running.joinEndsAt, NOW + 3 * 60_000);

  // Refused on a live window: unlike ±1 分钟, this replaces the number
  // outright, and the room is already watching it count down.
  const whileRunning = step(running, "JOIN_SET", NOW + 1000, { minutes: 1 });
  assert.equal(whileRunning.ok, false);
  assert.equal(whileRunning.code, "JOIN_RUNNING");
});

test("the join clock reaching zero changes nothing about the poll game", () => {
  const running = step(initialState(), "JOIN_START", NOW).state;
  const wellPastZero = NOW + JOIN_DURATION_MS + 60_000;

  // The phase has not moved on its own, and START still works from it.
  assert.equal(running.phase, "LOBBY");
  const opened = step(running, "START", wellPastZero);
  assert.equal(opened.ok, true, "an expired join clock never gates the show");
  assert.equal(opened.state.phase, "VOTING");
  assert.equal(
    opened.state.joinEndsAt,
    running.joinEndsAt,
    "starting a question does not stop the clock — /screen just stops drawing it",
  );
});

test("join actions never touch the undo stack, the way REPLAY doesn't", () => {
  const lobby = initialState();
  assert.equal(lobby.history.length, 0);

  let state = step(lobby, "JOIN_START", NOW).state;
  state = step(state, "JOIN_ADJUST", NOW + 1000, { minutes: 1 }).state;
  state = step(state, "JOIN_STOP", NOW + 2000).state;
  state = step(state, "JOIN_ADJUST", NOW + 3000, { minutes: -1 }).state;
  assert.equal(state.history.length, 0, "no join action is a step BACK can undo");
});

test("BACK preserves a running join clock and a custom configured length", () => {
  const withLength = step(initialState(), "JOIN_ADJUST", NOW, { minutes: 2 }).state;
  const running = step(run(["START"]), "JOIN_START", NOW).state;
  assert.ok(running.joinEndsAt != null, "sanity: the clock really is running");

  const back = step(running, "BACK", NOW + 5000);
  assert.ok(back.ok);
  assert.equal(back.state.phase, "LOBBY", "the phase did rewind");
  assert.equal(back.state.joinEndsAt, running.joinEndsAt, "the running clock did not");
  assert.equal(back.state.joinDurationMs, running.joinDurationMs);

  // And a stopped clock's custom length survives the same trip.
  const idleBack = step({ ...run(["START"]), joinDurationMs: withLength.joinDurationMs }, "BACK");
  assert.equal(idleBack.state.joinDurationMs, 7 * 60_000);
  assert.equal(idleBack.state.joinEndsAt, null);
});

test("showRules survives a phase transition and an undo, same as replayAt and epoch", () => {
  const shown = step(initialState(), "TOGGLE_RULES").state;
  assert.equal(shown.showRules, true);

  // NEXT from LOBBY moves the question along without a REPLAY/REVEAL round
  // trip — showRules should ride along exactly like replayAt and epoch do.
  const advanced = step({ ...shown, updatedAt: NOW }, "NEXT", NOW + 1000);
  assert.ok(advanced.ok);
  assert.equal(advanced.state.showRules, true, "carried forward, not auto-cleared");

  const back = step({ ...advanced.state, epoch: 5 }, "BACK", NOW + 2000);
  assert.ok(back.ok);
  assert.equal(back.state.showRules, true, "undo puts the phase back, not the rules flag");
  assert.equal(back.state.epoch, 5, "same treatment as epoch — carried, not rewound");
});

// Offline mode: the host runs the room without phones. A setting the setup
// page switches, in a lobby only, that every phase change has to carry.

test("a fresh state is online", () => {
  assert.equal(initialState().offline, false);
});

test("OFFLINE_ON and OFFLINE_OFF each say where to end up, so pressing one twice changes nothing", () => {
  const on = step(initialState(), "OFFLINE_ON");
  assert.equal(on.ok, true);
  assert.equal(on.state.offline, true);

  // A stale setup page pressing "on" again must not flip the room back.
  const onAgain = step(on.state, "OFFLINE_ON");
  assert.equal(onAgain.ok, true);
  assert.deepEqual(onAgain.state, on.state);

  const off = step(on.state, "OFFLINE_OFF");
  assert.equal(off.state.offline, false);
  assert.deepEqual(step(off.state, "OFFLINE_OFF").state, off.state);

  // Nothing else moved: same phase, same question, same clocks.
  assert.deepEqual({ ...on.state, offline: false }, initialState());
});

test("offline mode is switched in a lobby and nowhere else", () => {
  const phases = {
    VOTING: run(["START"]),
    LOCKED: run(["START", "LOCK"]),
    REVEAL: run(["START", "LOCK", "REVEAL"]),
    FINAL: run(["START", "LOCK", "REVEAL", "NEXT", "START", "LOCK", "REVEAL", "NEXT"]),
  };
  for (const [phase, state] of Object.entries(phases)) {
    assert.equal(state.phase, phase);
    for (const action of ["OFFLINE_ON", "OFFLINE_OFF"]) {
      const refused = step(state, action);
      assert.equal(refused.ok, false, `${action} in ${phase}`);
      assert.equal(refused.code, "WRONG_PHASE", `${action} in ${phase}`);
    }
  }

  // The lobby between two questions is a lobby too.
  const between = run(["START", "LOCK", "REVEAL", "NEXT"]);
  assert.deepEqual([between.phase, between.qIndex], ["LOBBY", 1]);
  assert.equal(step(between, "OFFLINE_ON").state.offline, true);
});

test("offline mode never touches the undo stack, and no phase change or undo drops it", () => {
  const lobby = initialState();
  const on = step(lobby, "OFFLINE_ON").state;
  assert.deepEqual(on.history, lobby.history, "a setting is not a step to undo");

  // Through a whole question and back out of it by BACK.
  let state = on;
  for (const action of ["START", "LOCK", "REVEAL", "NEXT", "START", "EXTEND", "LOCK"]) {
    state = step(state, action).state;
    assert.equal(state.offline, true, `${action} dropped offline mode`);
  }
  for (let i = 0; i < 3; i++) {
    state = step(state, "BACK").state;
    assert.equal(state.offline, true, "undo switched the mode");
  }

  // And the other way: a show that is online stays online.
  assert.equal(run(["START", "LOCK", "REVEAL", "NEXT"]).offline, false);
});

test("NEXT leaves a finished question without a reveal — offline only", () => {
  const offline = (actions, now = NOW) => {
    let state = step(initialState(), "OFFLINE_ON").state;
    for (const action of actions) state = step(state, action, now).state;
    return state;
  };

  // Online, a locked question still has votes to publish, and NEXT is refused.
  assert.equal(step(run(["START", "LOCK"]), "NEXT").code, "WRONG_PHASE");

  // Offline there is nothing to publish: LOCKED goes straight to the next lobby.
  const next = step(offline(["START", "LOCK"]), "NEXT");
  assert.equal(next.ok, true);
  assert.deepEqual([next.state.phase, next.state.qIndex], ["LOBBY", 1]);

  // The same moment REVEAL is allowed from: not while the countdown is still
  // running, but from a VOTING whose countdown has run out.
  const voting = offline(["START"]);
  assert.equal(step(voting, "NEXT").code, "WRONG_PHASE", "the clock is still running");
  const expired = step(voting, "NEXT", NOW + 41_000);
  assert.deepEqual([expired.state.phase, expired.state.qIndex], ["LOBBY", 1]);

  // After the last question it is the end screen, with no reveal on the way.
  const end = step(offline(["START", "LOCK", "NEXT", "START", "LOCK"]), "NEXT");
  assert.equal(end.state.phase, "FINAL");

  // And one step back from there is the locked question, not a reveal that
  // never happened.
  assert.equal(step(end.state, "BACK").state.phase, "LOCKED");
});

test("no vote is taken offline, whatever the phase", () => {
  const offline = step(initialState(), "OFFLINE_ON").state;
  const voting = step(offline, "START").state;

  assert.deepEqual(validateVote(voting, { qIndex: 0, choice: "a" }, NOW), {
    ok: false,
    code: "OFFLINE",
    status: 409,
  });
  // Its own answer in the lobby too, not WRONG_PHASE: the phone is being told
  // which mode the room is in, not that it was early.
  assert.equal(validateVote(offline, { qIndex: 0, choice: "a" }, NOW).code, "OFFLINE");
  // A malformed choice is still malformed first.
  assert.equal(validateVote(voting, { qIndex: 0, choice: "z" }, NOW).code, "BAD_CHOICE");

  // The identical vote, with the mode off, is taken.
  assert.deepEqual(validateVote({ ...voting, offline: false }, { qIndex: 0, choice: "a" }, NOW), {
    ok: true,
  });
});
