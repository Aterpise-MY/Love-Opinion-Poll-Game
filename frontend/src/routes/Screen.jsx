import { useEffect, useRef, useState } from "react";

import { optionsOf, sharesOf, totalVotes } from "../lib/choices.js";
import { bodyLayoutOf, useQuestions } from "../lib/content.js";
import { useCountdown, useGameState, useRampUp } from "../lib/hooks.js";
import { Deco, PixelIcon, Shares } from "../lib/ui.jsx";
import { JoinBoard } from "./JoinBoard.jsx";
import VoteBubbles from "./VoteBubbles.jsx";

const POLL_MS = 1000;
const URGENT_MS = 10_000;

export default function Screen() {
  const { state, offline, stale, offset } = useGameState(POLL_MS);
  const [questions] = useQuestions(state?.contentVersion);
  const remaining = useCountdown(state?.phase === "VOTING" ? state.phaseEndsAt : null, offset);

  // The countdown running out is a render decision, not a server transition —
  // the phase stays VOTING until the operator presses Reveal.
  const expired = state?.phase === "VOTING" && remaining === 0;

  // Derived before the early return below, because the sound hook cannot be
  // called conditionally. `enabled` is what keeps the lobby silent.
  const playing = ["VOTING", "LOCKED", "REVEAL"].includes(state?.phase);
  const question = questions[state?.qIndex ?? 0];
  const options = optionsOf(question);
  const sound = useQuestionAudio(question, options, {
    qIndex: state?.qIndex ?? 0,
    replayAt: state?.replayAt,
    enabled: playing,
  });

  if (!state) {
    return (
      <main className="screen screen--center">
        <p className="muted">连接中…</p>
      </main>
    );
  }

  // The panel holds the thing being judged. When the question is only a headline
  // — no body, no picture, no clip — there is nothing on it to judge, and the
  // empty white box is exactly the wall the option pictures need. Not rendered
  // rather than rendered flat: an empty .stage still costs its padding, its
  // background and its share of the column.
  //
  // `sound.total > 0` rather than `question?.audio`: the audio widget also
  // carries the playlist position and the unlock button, so a question whose
  // only sound is on its options still needs the panel to put it in. It is the
  // same expression that gates the widget below, so the two cannot disagree.
  const hasStageContent = Boolean(
    question?.body || question?.image || question?.video || sound.total > 0,
  );

  // Offline mode: the host is running the room by show of hands and the phones
  // are not part of it, so this wall drops everything that only means
  // something with phones — the QR, the percentages, the reveal, the recap.
  // Called `noPhones` here because `offline` in this file is already taken: it
  // is the hook's word for "the connection to the server is down".
  const noPhones = Boolean(state.offline);

  return (
    <main className="screen" data-stage={playing ? (hasStageContent ? "on" : "off") : undefined}>
      {/* A dot, not a banner. Three hundred people reading "connection lost"
          in unison is worse than the disconnection — the operator needs to
          know, the audience does not. */}
      {offline && <div className="screen__offline" title="与服务器失去连接" />}

      {/* showRules survives phase transitions server-side (see game.js) so it
          can arrive true while a question is live — the LOBBY check here is
          the guard that stops rules from ever covering one. The join clock
          rides the same guard for the same reason: joinEndsAt also survives
          into VOTING, and a countdown drawn over a live question would be the
          second clock on the wall disagreeing with the first. */}
      {state.phase === "LOBBY" &&
        (state.showRules ? (
          <Rules noPhones={noPhones} />
        ) : (
          <JoinBoard
            joined={state.joined}
            endsAt={state.joinEndsAt ?? null}
            offset={offset}
            noPhones={noPhones}
          />
        ))}

      {playing && (
        <>
          <div className="ticks">
            {Array.from({ length: state.questionCount }, (_, i) => (
              <span
                key={i}
                className={`tick ${i < state.qIndex ? "is-done" : ""} ${
                  i === state.qIndex ? "is-current" : ""
                }`}
              />
            ))}
          </div>

          <header className="screen__head">
            {/* Game-progress wording, in the pixel face: the design language
                counts stages, not question numbers. */}
            <span className="screen__index badge">
              STAGE {state.qIndex + 1}/{state.questionCount}
            </span>
            <h1 className="screen__title">{question?.title ?? "这样恋爱可不可以？"}</h1>
          </header>

          {hasStageContent && (
            <Stage question={question}>
              {question?.image && <img className="stage__image" src={question.image} alt="" />}
              {question?.video && (
                <QuestionVideo
                  src={question.video}
                  replayAt={state.replayAt}
                  live={state.phase === "VOTING"}
                />
              )}
              {sound.total > 0 && <QuestionAudio sound={sound} />}
            </Stage>
          )}

          <OptionCards
            options={options}
            playingKey={sound.playing ? sound.track?.key : null}
            tally={state.tally}
            qIndex={state.qIndex}
            plain={noPhones}
          />

          {/* Who just voted, in the strip between the ballot and the clock. */}
          <VoteBubbles state={state} questions={questions} />

          {state.phase === "VOTING" && !expired && (
            <Countdown remaining={remaining} duration={question?.duration} stale={stale} />
          )}
          {/* Offline nobody was voting, so what has ended is the time. And it
              stays ended: the host has no reveal to press, but if the phase
              is ever pushed to REVEAL anyway this wall still has nothing to
              publish, and says the same thing. */}
          {(state.phase === "LOCKED" || expired || (noPhones && state.phase === "REVEAL")) && (
            <div className="screen__closed">{noPhones ? "时间到" : "投票结束"}</div>
          )}
          {/* No corner QR: the join code has its own projector now. */}
          {state.phase === "REVEAL" && !noPhones && (
            <RevealSplit tally={state.tally} qIndex={state.qIndex} options={options} />
          )}
        </>
      )}

      {state.phase === "FINAL" &&
        (noPhones ? <Closing /> : <Final results={state.results} questions={questions} />)}
    </main>
  );
}

// What the operator reads out and what the room sees, so the two have to stay
// the same sentences. The fourth is the one the game depends on: said before
// the first question, it is what lets people vote for what they think rather
// than for what they expect to be marked right — and it tells them the numbers
// moving on the wall are the room, not a score.
const RULES_TEXT = [
  "每题会出现一个恋爱情境，请凭第一直觉判断：这样恋爱，可不可以？",
  "用手机选「可以」、「不可以」，或者其他题目的选项。一题只能选一次，选了不能改。",
  "每题都有倒计时，时间到就截止，没选视为弃权。",
  "没有标准答案。投票期间，大屏会实时显示全场的选择比例。",
  "我们会随机选一个会众来发表意见。",
  "全部结束后，我们一起回顾：每一题全场是怎么选的。",
];

// The same slide for a room that is not using its phones. The rules above
// tell people to pick on a phone and promise them percentages and a recap,
// none of which is going to happen — so offline mode has its own four.
const RULES_TEXT_OFFLINE = [
  "每题会出现一个恋爱情境，请凭第一直觉判断：这样恋爱，可不可以？",
  "主持人说开始后，请举手表态：「可以」还是「不可以」。",
  "每题都有倒计时，时间到就停。",
  "没有标准答案，看看全场怎么选，也听听不同的理由。",
];

/**
 * Toggled from the operator console, LOBBY only — see the guard where this is
 * rendered. Replaces the join screen entirely rather than sharing space with
 * it: the QR and the joined count are exactly what a room reading rules does
 * not need to also be looking at.
 */
function Rules({ noPhones }) {
  return (
    <section className="rules">
      <Deco of="rules" />
      <h1 className="rules__title">游戏规则</h1>
      <ol className="rules__list">
        {(noPhones ? RULES_TEXT_OFFLINE : RULES_TEXT).map((text, i) => (
          <li key={i} className="rules__item">
            {text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The white panel: the media, and the body text positioned against it.
 *
 * Exported because the setup page's preview renders this exact component with
 * the draft question. A preview that reimplements the layout drifts from the
 * wall the first time either side is touched, and a preview nobody trusts is
 * worse than none — so there is one implementation and both callers use it.
 *
 * The media arrives as children rather than being rendered here: on the
 * projector a clip has to autoplay, replay on cue and pause when voting closes,
 * and none of that belongs in a still preview.
 */
export function Stage({ question, children }) {
  const { place, align, size } = bodyLayoutOf(question);
  const body = question?.body;

  // `over` lays the text on the media instead of giving it its own row, so the
  // paragraph is out of the flex column entirely and the panel's height budget
  // is spent on the picture alone.
  const text = body && (
    <p className="stage__body" style={{ "--body-size": size }}>
      {body}
    </p>
  );

  return (
    <section className={`stage stage--${place} stage--${align}`}>
      {place === "above" && text}
      {place === "over" ? (
        <div className="stage__over">
          {children}
          <div className="stage__over-text">{text}</div>
        </div>
      ) : (
        children
      )}
      {place === "below" && text}
    </section>
  );
}

/**
 * The reveal: how the room split, as one bar.
 *
 * One bar rather than a chart, because where the seam falls is the whole story
 * and it reads from the back row in a way separate bars do not. One segment per
 * option the question offers, in that option's own colour and in the cards'
 * own order — so the bar is the row of cards above it, redrawn to scale.
 *
 * Nothing announces an answer and nothing is crowned. There is no right side of
 * this seam, and a banner naming the bigger half would be the wall telling the
 * smaller one it was wrong.
 */
function RevealSplit({ tally, qIndex, options }) {
  const shares = sharesOf(tally);
  // One progress for the whole bar, not a ramp per segment. Every width is its
  // final share times the same fraction, so the segments grow in proportion and
  // the seams between them hold still while the bar fills — and the percentages
  // under it land on exactly the numbers sharesOf gave every phone.
  const progress = useRampUp(1, { restartKey: `${qIndex}-reveal` });

  // The same box LOCKED put there a moment ago, so a question nobody voted on
  // changes its words and nothing else.
  if (!shares) return <div className="screen__closed">本题无人投票</div>;

  return (
    <section className="reveal">
      <div className="split">
        <div className="split__bar">
          {options.map((option) => (
            <div
              key={option.key}
              className={`split__seg key--${option.key}`}
              style={{ width: `${shares[option.key] * progress}%` }}
            />
          ))}
        </div>
        {/* Two big numbers have two ends of the bar to sit under. Past two there
            is nowhere to put them that says which segment each belongs to — and
            every card above already carries its own percentage. */}
        {options.length === 2 && (
          <div className="split__legend">
            {options.map((option) => (
              <div key={option.key} className={`split__side key--${option.key}`}>
                <span className="split__pct num">{Math.round(shares[option.key] * progress)}%</span>
                <span className="split__label">
                  {option.icon && <span className="glyph">{option.icon}</span>}
                  {option.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Everything this question has to say, in order: the question's own clip first,
 * then each option's, so the room hears "listen to this" before it hears the
 * things it is choosing between.
 *
 * One element and one playlist, not one player per clip. Two players started on
 * the same replayAt talk over each other, and the autoplay unlock is per
 * element — four elements would be four ways to end up with a silent projector
 * and one button that only fixes one of them.
 *
 * Audio plays here and only here. Three hundred phones playing the same clip a
 * second out of step with each other is unusable, and mobile browsers block
 * autoplay without a gesture anyway — one shared speaker is the only version of
 * this that works in a room. The projector still needs one click before the
 * show to unlock audio, which is why the setup page says so.
 */
function useQuestionAudio(question, options, { qIndex, replayAt, enabled }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);
  const [playing, setPlaying] = useState(false);

  const playlist = enabled
    ? [
        ...(question?.audio ? [{ key: null, src: question.audio }] : []),
        ...options.filter((option) => option.audio).map((o) => ({ key: o.key, src: o.audio })),
      ]
    : [];

  // One string that changes on everything a fresh run should start from: a new
  // question, a new set of clips, or the operator pressing 重放音频.
  const run = `${qIndex}:${replayAt ?? 0}:${playlist.map((track) => track.src).join("|")}`;
  const [at, setAt] = useState({ run, i: 0 });
  // Adjusting state during render rather than in an effect: the alternative
  // plays the old track for one frame before the effect resets the cursor.
  if (at.run !== run) setAt({ run, i: 0 });

  const track = playlist[at.i] ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    el.currentTime = 0;
    el.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
  }, [at, track?.src]);

  return {
    ref,
    track,
    blocked,
    playing,
    position: at.i + 1,
    total: playlist.length,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    // Off the end rather than back to the start: a playlist that loops would
    // have the room listening to option A again under a running countdown.
    onEnded: () => {
      setPlaying(false);
      setAt((prev) => ({ ...prev, i: prev.i + 1 }));
    },
    // Two-argument .then(): a refusal that survives the click is expected and
    // already shown by the button's own label, not an unhandled rejection.
    unlock: () =>
      ref.current?.play().then(
        () => setBlocked(false),
        () => setBlocked(true),
      ),
  };
}

function QuestionAudio({ sound }) {
  const { ref, track, blocked, playing, position, total } = sound;

  return (
    <div className={`audio ${blocked ? "audio--blocked" : ""}`}>
      <audio
        ref={ref}
        src={track?.src}
        preload="auto"
        onPlay={sound.onPlay}
        onPause={sound.onPause}
        onEnded={sound.onEnded}
      />
      <button className="audio__button" onClick={sound.unlock}>
        <span className={`audio__icon ${playing ? "is-playing" : ""}`}>
          <PixelIcon name="sound" />
        </span>
        <span className="audio__label">
          {blocked
            ? "点这里启用声音"
            : playing
              ? total > 1
                ? `正在播放 ${position}/${total}`
                : "正在播放…"
              : "点击重放"}
        </span>
      </button>
    </div>
  );
}

/**
 * The options, on the wall.
 *
 * They are drawn in every playing phase, including after the vote closes: the
 * phone hides its buttons the moment you have answered, so without this the
 * room spends the back half of every question unable to see what it chose
 * between. LOCKED looks identical to VOTING on purpose — "投票结束" is the
 * phase signal, and a second simultaneous change reads as a fault from the
 * back row.
 */
function OptionCards({ options, playingKey, tally, qIndex, plain = false }) {
  const rich = options.some((option) => option.image || option.video);
  // Live: the tally is on every /state from the moment the question opens, so
  // this moves with each poll. null until the first vote lands, because there
  // is nothing yet for a share to be a share of.
  //
  // `plain` is offline mode: the cards are the two things the room is choosing
  // between and nothing more, so there are no shares to show — whatever an
  // earlier, online rehearsal may have left in this question's tally.
  const shares = plain ? null : sharesOf(tally);

  return (
    <section
      className={`choices ${rich ? "choices--media" : "choices--bare"}`}
      data-count={options.length}
    >
      {options.map((option) => (
        <OptionCard
          key={option.key}
          option={option}
          rich={rich}
          isPlaying={playingKey === option.key}
          share={shares ? shares[option.key] : null}
          qIndex={qIndex}
          plain={plain}
        />
      ))}
    </section>
  );
}

/**
 * One option, and the share of the room that has picked it so far.
 *
 * This is the real-time poll: the number moves while the countdown runs. The
 * percentage lives in the label row rather than in a chart of its own: the row
 * already exists, so it costs the wall no height at all, and the colour and
 * the word are already next to it so it needs no legend. The cards keep their
 * authored order and their own key colours in every phase — nothing here is
 * sorted, crowned, dimmed or recoloured by rank, while the vote is open or
 * after it. On an opinion poll no option wins, and a card that stepped back
 * would be the wall calling one side of the room wrong.
 */
function OptionCard({ option, rich, isPlaying, share, qIndex, plain }) {
  // Eased in from zero when the question opens, then tracking. useRampUp reads
  // its target through a ref rather than a dependency, which is exactly the
  // shape a number that changes once a second needs: the poll moves the target
  // without restarting the animation.
  const shown = useRampUp(share ?? 0, {
    restartKey: `${qIndex}:${option.key}`,
  });

  return (
    <article
      className={`choice-card key--${option.key} ${isPlaying ? "is-playing" : ""}`}
      style={{ "--pct": `${shown}%` }}
    >
      {rich && (
        <div className="choice-card__media">
          {/* Muted, looping and never with controls: a silent moving picture.
              Muted autoplay is the one kind browsers allow unconditionally, so
              an option video sidesteps the unlock the question's own video has
              to handle. */}
          {option.video ? (
            <video
              className="choice-card__video"
              src={option.video}
              muted
              loop
              autoPlay
              playsInline
              preload="auto"
            />
          ) : option.image ? (
            <img className="choice-card__image" src={option.image} alt="" />
          ) : null}
        </div>
      )}
      <div className="choice-card__foot">
        {option.icon && <span className="choice-card__icon glyph">{option.icon}</span>}
        <span className="choice-card__label">{option.label}</span>
        {option.audio && (
          <span className="choice-card__sound">
            <PixelIcon name="sound" />
          </span>
        )}
        {/* Nothing to be a percentage of yet. Two cards both reading 0% in the
            first seconds of a question reads as a fault, and 0% of nothing is
            not a fact — the raw counts stay on the operator's phone. */}
        {/* Offline there is no number coming, so there is no dash standing in
            for one either: a dash reads as "waiting for votes". */}
        {!plain && (
          <span className="choice-card__pct num">
            {share == null ? "—" : `${Math.round(shown)}%`}
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * Same rule as the clip above: video plays on the projector and nowhere else.
 * It carries its own soundtrack, so it hits the identical autoplay block, and
 * the one click that unlocks audio before the show unlocks this too.
 *
 * No controls. The projector is not a device anyone touches mid-show, and a
 * control bar fading in over the picture reads as a fault from the back row.
 * The fallback button only appears if autoplay was actually refused.
 */
function QuestionVideo({ src, replayAt, live }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Voting has closed. The clip is the thing being judged, and once the room
    // has stopped judging it its soundtrack is just noise under the reveal —
    // which is what it had been all along, because nothing ever paused it.
    //
    // Paused, not unmounted: the last frame stays on the wall, which is what
    // the room is still looking at while the presenter talks over the reveal.
    if (!live) {
      el.pause();
      return;
    }

    el.currentTime = 0;
    el.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
    // Replays whenever the operator presses 重放音频, which bumps replayAt.
  }, [src, replayAt, live]);

  return (
    <div className={`stage__video ${blocked ? "stage__video--blocked" : ""}`}>
      <video ref={ref} className="stage__video-el" src={src} preload="auto" playsInline />
      {blocked && (
        <button
          className="stage__video-unblock"
          onClick={() =>
            ref.current?.play().then(
              () => setBlocked(false),
              () => setBlocked(true),
            )
          }
        >
          <PixelIcon name="play" /> 点这里播放视频
        </button>
      )}
    </div>
  );
}

function Countdown({ remaining, duration, stale }) {
  const seconds = Math.ceil((remaining ?? 0) / 1000);
  const urgent = !stale && remaining != null && remaining <= URGENT_MS;
  const fraction = duration ? Math.max(0, Math.min(1, (remaining ?? 0) / (duration * 1000))) : 0;

  return (
    <div className={`countdown ${urgent ? "is-urgent" : ""}`}>
      <div className="countdown__track">
        <div className="countdown__fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      {/* While stale we do not know what the clock says, so show the bar
          without digits rather than confidently counting down a dead one. */}
      <div className="countdown__number num">{stale ? "—" : seconds}</div>
    </div>
  );
}

/**
 * The end of an offline show. There is no recap to give — nothing was
 * collected — so the last screen is a thank-you, dressed as the poster.
 */
function Closing() {
  return (
    <section className="closing">
      <Deco of="poster" />
      <span className="ribbon closing__ribbon">感情讲座</span>
      <h1 className="closing__title">
        谢谢<span className="hl">参与</span>
      </h1>
    </section>
  );
}

/**
 * The recap: every question the room voted on, and how it split.
 *
 * No headline number. The game this was cloned from ended on how much of the
 * room had been right, and here there is nothing to have been right about — so
 * the last screen is the questions themselves, each named by its topic because
 * "Q3" means nothing to anybody ten minutes after it was on the wall.
 */
function Final({ results, questions }) {
  // A skipped question has no votes. Left in, it renders an empty bar that the
  // room reads as "nobody had an opinion on that one".
  const played = (results ?? []).filter((r) => totalVotes(r) > 0);

  return (
    <section className="final">
      <p className="final__label">全场回顾</p>
      <div className="final__rows">
        {played.map((r) => {
          const question = questions[r.qIndex];
          const options = optionsOf(question);
          const shares = sharesOf(r);
          return (
            <div key={r.qIndex} className="final__row">
              <span className="final__index badge">{String(r.qIndex + 1).padStart(2, "0")}</span>
              <span className="final__topic">{question?.topic}</span>
              {/* The reveal's bar again, a row high: same segments, same
                  colours, same order as the cards the room voted with. */}
              <div className="final__bar">
                {options.map((option) => (
                  <div
                    key={option.key}
                    className={`final__seg key--${option.key}`}
                    style={{ width: `${shares[option.key]}%` }}
                  />
                ))}
              </div>
              <span className="final__split">
                <Shares options={options} shares={shares} />
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The corner QR used to live here, shrunk into the top right so latecomers
// still had something to scan while a question was up. It has moved to
// /screen2 as a full-size board on its own projector: the same job, done at a
// size the back row can actually read, without stealing a corner of the
// question. The failure it guards against — someone arriving after Start with
// nowhere to join from — is unchanged, so /screen2 must actually be open.
