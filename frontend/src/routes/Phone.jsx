import { useEffect, useMemo, useState } from "react";

import { ApiError, postJoin, postVote } from "../lib/api.js";
import { findOption, optionsOf, sharesOf, someOptionHas, totalVotes } from "../lib/choices.js";
import { useQuestions } from "../lib/content.js";
import { useCountdown, useGameState } from "../lib/hooks.js";
import { canEditName, checkName } from "../lib/name.js";
import { ChatNote, PixelIcon, Shares } from "../lib/ui.jsx";
import {
  clearAll,
  getChoices,
  getName,
  getVoterId,
  hasJoined,
  markJoined,
  saveName,
  setChoice,
  syncEpoch,
} from "../lib/storage.js";
import NameEntry, { NAME_TEXT } from "./NameEntry.jsx";

const POLL_MS = 2000;
// A join that fails is tried once more, this long afterwards: time enough for
// a dropped connection to have come back, and still before anybody has looked
// up at the count on the wall.
const JOIN_RETRY_MS = 2000;

// Rehearsal phones keep a voterId and a set of choices that would make them
// look "already voted" during the real thing. /?reset=1 wipes this device —
// the only self-service recovery available to someone in the audience.
if (new URLSearchParams(window.location.search).has("reset")) {
  clearAll();
  window.location.replace("/");
}

// Whatever is stored goes through the same check as what is typed, so a value
// that is no longer a usable name asks again instead of greeting somebody with
// it.
function rememberedName() {
  const checked = checkName(getName());
  return checked.ok ? checked.name : null;
}

export default function Phone() {
  const voterId = useMemo(getVoterId, []);
  const { state, offline, stale, offset } = useGameState(POLL_MS);
  const [questions] = useQuestions(state?.contentVersion);
  const [choices, setChoices] = useState(getChoices);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const [name, setName] = useState(rememberedName);
  const [renaming, setRenaming] = useState(false);

  // A phone is not in the room until it has a name: no lobby, no question, no
  // vote, and no join either — the count on the wall is of people who got in.
  // Both joins below wait on this, and neither is sent again when the name is
  // only changed.
  const named = name !== null;

  // On load for a phone that is remembered, and at the moment a name is
  // entered for one that is not.
  useEffect(() => {
    if (!named || hasJoined()) return undefined;

    let cancelled = false;
    let retry;
    postJoin(voterId)
      .then(markJoined)
      .catch(() => {
        if (cancelled) return;
        // Once more and then no further. A failed join only costs a number on
        // the lobby screen; voting is unaffected, so there is nothing worth
        // showing the audience and nothing worth a queue of retries either.
        retry = setTimeout(() => {
          if (hasJoined()) return;
          postJoin(voterId)
            .then(markJoined)
            .catch(() => {});
        }, JOIN_RETRY_MS);
      });

    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [voterId, named]);

  // A RESET starts a new run. Everything this phone remembers belongs to the
  // previous one, and keeping it would show "already voted" on questions
  // nobody has answered yet. The name is the exception — it is the person's,
  // not the run's — so a phone that has one joins the new run under it.
  useEffect(() => {
    if (!state?.epoch) return;
    if (!syncEpoch(state.epoch)) return;
    setChoices({});
    // Still at the form: the effect above joins once there is a name.
    if (!named) return;
    postJoin(voterId)
      .then(markJoined)
      .catch(() => {
        // Same as the first join: a missed count is not worth a message.
      });
  }, [state?.epoch, voterId, named]);

  // The name can be changed until the first question opens, and what says so
  // is the state as last polled — the phone follows the room by a poll.
  const canRename = canEditName(state);

  // Leaving the first lobby drops an edit that was still open, and keeps it
  // dropped: when the operator undoes back into that lobby the phone shows the
  // button again, not a form nobody asked for a second time.
  useEffect(() => {
    if (!canRename) setRenaming(false);
  }, [canRename]);

  function keepName(next) {
    saveName(next);
    setName(next);
    setRenaming(false);
  }

  const qIndex = state?.qIndex ?? 0;
  const question = questions[qIndex];
  const options = optionsOf(question);
  const myChoice = choices[qIndex];

  // No clock runs behind the form. It would redraw this page twenty times a
  // second under a field somebody is typing in, for a countdown they cannot
  // see.
  const remaining = useCountdown(
    named && state?.phase === "VOTING" ? state.phaseEndsAt : null,
    offset,
  );
  const expired = remaining === 0;

  useEffect(() => setNotice(null), [qIndex, state?.phase]);

  async function vote(choice) {
    setPending(choice);
    setNotice(null);
    try {
      await postVote(voterId, qIndex, choice);
      setChoices(setChoice(qIndex, choice));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === "ALREADY_VOTED") {
        setChoices(setChoice(qIndex, choice));
      } else if (code === "EXPIRED") {
        setNotice("慢了一步，这题的投票已经结束了");
      } else if (code === "WRONG_PHASE") {
        // The same code means two opposite things — the question has not
        // opened yet, or it has already moved on.
        setNotice(
          (state?.qIndex ?? 0) > qIndex ? "这题已经过了，看大屏幕" : "这题还没开始，等一下大屏幕",
        );
      } else {
        setNotice(code === "TIMEOUT" ? "网络有点慢，再点一次" : "网络不太顺，再点一次");
      }
    } finally {
      setPending(null);
    }
  }

  if (!state) {
    return (
      <main className="phone">
        <section className="phone__center">
          <p className="muted">连接中…</p>
        </section>
      </main>
    );
  }

  // Offline mode: the host is running the room by show of hands, and this
  // phone has no part to play. One screen, the same in every phase — no
  // buttons, no countdown, no result, no recap — so that nobody keeps looking
  // down at it for something to happen. (`state.offline` is the mode; the
  // `offline` from the hook above is this phone's own connection.)
  //
  // Nothing else stops: the poll keeps running, and a phone that has a name
  // has already sent its join, so the moment the host switches the mode off it
  // is back in the normal flow without being touched.
  //
  // A phone without a name is not asked for one here. The form is something
  // to do, on the one screen whose whole point is that there is nothing to do;
  // it comes up when the mode is switched off, which only happens in a lobby.
  if (state.offline) {
    return (
      <main className="phone">
        <header className="phone__bar">
          {offline && <span className="pill pill--warn">网络断了</span>}
        </header>
        <ChatNote title="本场不用手机投票">请看大屏幕，听主持人的指示</ChatNote>
      </main>
    );
  }

  // The gate. Below this line the phone is in the room; above it nothing of
  // the room is drawn — no ticks, no lobby, no question, not the reveal that
  // would otherwise cover the whole screen. Somebody who scans late gets the
  // form first as well, whatever the wall is showing.
  //
  // The same form comes back from the first lobby for a change of name. It
  // needs both halves of the condition: `renaming` alone would hold the form
  // up for the one render between the game moving on and the effect above
  // noticing.
  if (!named || (renaming && canRename)) {
    return (
      <main className="phone">
        <header className="phone__bar">
          {offline && <span className="pill pill--warn">网络断了</span>}
        </header>
        <NameEntry
          current={name}
          canChangeLater={canRename}
          onSubmit={keepName}
          onCancel={() => setRenaming(false)}
        />
      </main>
    );
  }

  const voting = state.phase === "VOTING";
  const canAnswer = voting && !myChoice && !expired;

  return (
    <main className="phone">
      <header className="phone__bar">
        {state.phase !== "FINAL" && (
          <div className="ticks phone__ticks">
            {Array.from({ length: state.questionCount }, (_, i) => (
              <span
                key={i}
                className={`tick ${i < qIndex ? "is-done" : ""} ${i === qIndex ? "is-current" : ""}`}
              />
            ))}
          </div>
        )}
        {offline && <span className="pill pill--warn">网络断了</span>}
      </header>

      {state.phase === "LOBBY" && (
        <>
          {/* A conversation, the way the poster draws one: the room says it is
              ready, by name, and the other side is still typing. The name is
              in a span of its own so that twenty letters with no space among
              them wrap inside the bubble instead of running out of it. */}
          <ChatNote
            title={
              <>
                {NAME_TEXT.greeting.before}
                <span className="phone__name-shown">{name}</span>
                {NAME_TEXT.greeting.after}
              </>
            }
            typing
          >
            看大屏幕，马上开始
          </ChatNote>
          {/* Offered in the first lobby only. Every later lobby greets by the
              same name and has no button, which is all "fixed" needs to look
              like. */}
          {canRename && (
            <button type="button" className="phone__rename" onClick={() => setRenaming(true)}>
              {NAME_TEXT.rename.open}
            </button>
          )}
        </>
      )}

      {/* Voting, locked and reveal all keep the content mounted — the reveal
          lays the split over it rather than replacing it, so the scenario is
          still there the moment the overlay goes. */}
      {["VOTING", "LOCKED", "REVEAL"].includes(state.phase) && (
        <>
          <section className="quiz">
            {question?.image && <img className="quiz__image" src={question.image} alt="" />}
            <div className="quiz__panel">
              <p className="quiz__prompt">{question?.title ?? "这样恋爱可不可以？"}</p>
              {/* Pointed at the projector, never played here. Three hundred
                  phones pulling the same clip over venue wifi is the one way
                  to take the room's network down mid-question. */}
              {question?.audio && (
                <p className="quiz__media-hint">
                  <PixelIcon name="sound" /> 声音在大屏幕上播放
                </p>
              )}
              {question?.video && (
                <p className="quiz__media-hint">
                  <PixelIcon name="play" /> 视频在大屏幕上播放
                </p>
              )}
              {someOptionHas(options, "audio") && (
                <p className="quiz__media-hint">
                  <PixelIcon name="sound" /> 选项的声音在大屏幕上依次播放
                </p>
              )}
              {someOptionHas(options, "video") && (
                <p className="quiz__media-hint">
                  <PixelIcon name="play" /> 选项的视频在大屏幕上播放
                </p>
              )}
              {question?.body && <p className="quiz__body">{question.body}</p>}
            </div>
          </section>

          {canAnswer && (
            // Still two per row past two options — the odd one out spanning the
            // full width reads as deliberate, where a three-across grid makes
            // every button too small to hit without looking.
            <div className={`quiz__choices ${options.length > 2 ? "quiz__choices--many" : ""}`}>
              {options.map((option) => (
                <button
                  key={option.key}
                  className={`tile key--${option.key} tile--press choice ${
                    option.image ? "choice--pictured" : ""
                  }`}
                  onClick={() => vote(option.key)}
                  disabled={pending !== null}
                >
                  {/* The picture comes to the phone even though the clips do
                      not: it is already compressed to a couple of hundred KB,
                      and a button that means "the third photograph" cannot be
                      pressed by someone who cannot see the photograph. */}
                  {option.image && <img className="choice__image" src={option.image} alt="" />}
                  {option.icon && <span className="choice__icon glyph">{option.icon}</span>}
                  <span className="choice__label">{option.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* In the colour of what was chosen, so the phone keeps saying which
              side it is on in the same colour the button was. */}
          {voting && myChoice && (
            <p className={`quiz__status quiz__status--voted key--${myChoice}`}>
              <PixelIcon name="check" />
              <span>
                已投票 · 你选了「{findOption(options, myChoice)?.label ?? "已删除的选项"}」
              </span>
            </p>
          )}
          {voting && !myChoice && expired && <p className="quiz__status">本题已截止，看大屏幕</p>}
          {state.phase === "LOCKED" && <p className="quiz__status">投票结束，看大屏幕</p>}

          {notice && <p className="phone__notice">{notice}</p>}

          {voting && remaining != null && (
            <PhoneCountdown remaining={remaining} duration={question?.duration} stale={stale} />
          )}
        </>
      )}

      {state.phase === "REVEAL" && (
        <Split tally={state.tally} myChoice={myChoice} options={options} />
      )}

      {state.phase === "FINAL" && (
        <Recap results={state.results} choices={choices} questions={questions} />
      )}
    </main>
  );
}

function PhoneCountdown({ remaining, duration, stale }) {
  const seconds = Math.ceil(remaining / 1000);
  const fraction = duration ? Math.max(0, Math.min(1, remaining / (duration * 1000))) : 0;
  const urgent = !stale && remaining <= 10_000;

  return (
    <div className={`phone__countdown ${urgent ? "is-urgent" : ""}`}>
      <div className="phone__countdown-track">
        <div className="phone__countdown-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="phone__countdown-number num">{stale ? "—" : seconds}</span>
    </div>
  );
}

/**
 * The payoff. Deliberately full-bleed and animated: three hundred phones
 * flipping to the colour of whatever each one chose, at the same instant, is
 * visible from the stage — the room sees its own split in the air, in the
 * colours it has been watching on the wall — and it is the moment the whole
 * segment is built around.
 *
 * Nobody is told they were right or wrong, because nobody was. What the phone
 * says is where its owner stands: what they chose, and how much of the room
 * chose it with them.
 *
 * This is also the first time a phone prints a percentage. The live ones
 * are on the projector while the question is open and deliberately not here:
 * under a countdown a phone is for deciding, and the room watching itself is
 * the wall's job.
 */
function Split({ tally, myChoice, options }) {
  const shares = sharesOf(tally);

  if (!shares) {
    return (
      <section className="verdict verdict--missed">
        <h1 className="verdict__title">这题没有人投票</h1>
      </section>
    );
  }

  const room = (
    <p className="verdict__room">
      全场：
      <Shares options={options} shares={shares} />
    </p>
  );

  if (!myChoice) {
    return (
      <section className="verdict verdict--missed">
        <h1 className="verdict__title">这题你没投</h1>
        {room}
      </section>
    );
  }

  const label = findOption(options, myChoice)?.label ?? "已删除的选项";

  // A choice this phone remembers and the tally has no vote under. It happens:
  // a vote that reached the server but whose reply was lost leaves the buttons
  // up, and tapping the other one is then answered ALREADY_VOTED — at which
  // point `vote` above records the tap, not the vote that was counted. Claiming
  // a share of the room for a side nobody is counted on would be a lie in a
  // very large font, so this says what was chosen, shows the room, and stays
  // neutral.
  if (!(tally?.[myChoice] > 0)) {
    return (
      <section className="verdict verdict--missed">
        <h1 className="verdict__title">你选了「{label}」</h1>
        {room}
      </section>
    );
  }

  return (
    <section className={`verdict verdict--mine key--${myChoice}`}>
      <h1 className="verdict__title">你选了「{label}」</h1>
      <span className="verdict__pct num">{shares[myChoice]}%</span>
      <p className="verdict__room">
        全场 <b className="num">{shares[myChoice]}%</b> 和你一样
      </p>
    </section>
  );
}

/**
 * The recap: one row for every question the room voted on, saying what this
 * phone chose and how much of the room chose the same.
 *
 * No score and no fraction, on purpose. A number out of five at the top of this
 * page would be read as marks, and there is nothing here to have been marked
 * against.
 */
function Recap({ results, choices, questions }) {
  // Skipped questions had no votes at all; listing them would tell people
  // they missed a question that never happened.
  const played = (results ?? []).filter((r) => totalVotes(r) > 0);

  return (
    <section className="phone__center">
      <h1 className="big">投票结束，谢谢参与</h1>
      <ol className="recap">
        {played.map((r) => {
          const question = questions[r.qIndex];
          const mine = choices[r.qIndex];
          return (
            <li key={r.qIndex} className={`recap__row ${mine ? `key--${mine}` : ""}`}>
              <span className="recap__index badge">{String(r.qIndex + 1).padStart(2, "0")}</span>
              {question?.topic && <span className="recap__topic">{question.topic}</span>}
              {mine && (
                <span className="recap__mine">
                  {findOption(optionsOf(question), mine)?.label ?? "已删除的选项"}
                </span>
              )}
              {/* Same rule as the reveal: no share is claimed for a choice the
                  tally has no vote under. */}
              {mine ? (
                r[mine] > 0 && (
                  <span className="recap__share">
                    <b className="num">{sharesOf(r)[mine]}%</b> 和你一样
                  </span>
                )
              ) : (
                <span className="recap__share">没投</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
