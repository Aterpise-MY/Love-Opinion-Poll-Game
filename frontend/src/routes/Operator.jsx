import { useEffect, useState } from "react";

import { ApiError, postAdmin } from "../lib/api.js";
import { optionsOf, sharesOf, someOptionHas, totalVotes } from "../lib/choices.js";
import { hasPlaceholder, useQuestions } from "../lib/content.js";
import { useCountdown, useGameState } from "../lib/hooks.js";
import { PixelIcon } from "../lib/ui.jsx";
import KeyPrompt from "./KeyPrompt.jsx";

const POLL_MS = 1000;

// m:ss. useCountdown clamps at zero, so an overrun cannot be a negative number
// without changing a hook three surfaces share — and it should not be one
// anyway: the tile says 超时 instead, because a stopped clock and a clock that
// has just run out look identical and only one of them is information.
const clock = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Mirrors backend/game.js's GAME_DURATION_MS. Only used before the first
// /state response lands with a real gameDurationMs on it, or against an old
// server mid-rollout that has not started writing the attribute yet — the
// same mixed window #34 calls out for the backend's own `?? GAME_DURATION_MS`.
const GAME_DURATION_DEFAULT_MS = 15 * 60_000;

// 10 / 15 / 20 / 30 minutes, the lengths a run actually needs. ±1 分 covers
// the rest without a keyboard.
const TIMER_PRESETS_MIN = [10, 15, 20, 30];

// Mirrors backend/game.js's JOIN_DURATION_MS, for the same mid-rollout reason
// as GAME_DURATION_DEFAULT_MS above.
const JOIN_DURATION_DEFAULT_MS = 5 * 60_000;
const JOIN_MIN_MINUTES = 1;
const JOIN_MAX_MINUTES = 120;

// Short, because a join window is not a segment. 全场 needs 10-30 minutes and
// gets chips for them; the doors are open for one, three or five, and anything
// else is what the custom field beside them is for.
const JOIN_PRESETS_MIN = [1, 3, 5];

// Fixed positions, always. The operator is standing in the dark holding a
// phone; a button that moves between phases is a button they will mis-hit.
//
// Each of these means exactly one thing. Advancing the show is the primary
// button's job alone — the skip here is only ever "drop this question without
// showing it", which is why it is live in LOBBY and nowhere else.
//
// The icons are transport marks typed in the pixel face — pause, add, skip —
// or one of the pixel icons. No emoji: on a phone they are drawn by whatever
// colour font the handset has, and this console has to look the same, and be
// readable in the dark, on all of them.
const ADJUSTMENTS = [
  { action: "LOCK", icon: "||", label: "提前结束", live: (s) => s.phase === "VOTING" },
  { action: "EXTEND", icon: "+10", label: "+10 秒", live: (s) => s.phase === "VOTING" },
  {
    action: "NEXT",
    icon: ">>",
    label: "跳过本题",
    live: (s) => s.phase === "LOBBY" && s.qIndex + 1 < s.questionCount,
  },
];

// TOGGLE_RULES is LOBBY-only server-side (409 WRONG_PHASE otherwise), and the
// label has to say which way it is about to flip — "显示" while hidden,
// "收起" once shown — or the operator is guessing what one more tap does to
// a screen they cannot see from the stage.
const RULES_TOGGLE = {
  action: "TOGGLE_RULES",
  icon: <PixelIcon name="lightbulb" />,
  label: (s) => (s?.showRules ? "收起规则" : "显示游戏规则"),
  live: (s) => s.phase === "LOBBY",
};

// Only shown when the current question has audio. The projector is not
// somewhere the operator can reach mid-talk, and a clip nobody heard twice is
// a question nobody could answer.
const REPLAY = {
  action: "REPLAY",
  icon: <PixelIcon name="sound" />,
  label: "重放音频",
  live: (s) => ["VOTING", "LOCKED", "REVEAL"].includes(s.phase),
};

/**
 * The one action they almost certainly want next, big enough to hit without
 * looking down. Everything else stays reachable in the grid below.
 */
function primaryFor(state, expired) {
  if (!state) return null;
  const last = state.qIndex + 1 >= state.questionCount;

  // Offline mode has no results step: nothing was collected, so there is
  // nothing to publish and no 公布结果 to offer. Once the question is over —
  // locked, or its countdown run out — the next thing is the next question,
  // or after the last one the end screen. Same rule as below while the
  // countdown is still running: the big button waits, 提前结束 is in the grid.
  if (state.offline && (state.phase === "VOTING" || state.phase === "LOCKED")) {
    const over = state.phase === "LOCKED" || expired;
    const wait = "等倒计时走完，或用下面的提前结束";
    return last
      ? { action: "NEXT", label: "结束本场", hint: over ? "大屏显示「谢谢参与」" : wait }
      : { action: "NEXT", label: "下一题", hint: over ? `进入第 ${state.qIndex + 2} 题` : wait };
  }

  switch (state.phase) {
    case "LOBBY":
      return { action: "START", label: "开始本题", hint: `第 ${state.qIndex + 1} 题，开始计时` };
    case "VOTING":
      // Always "advance", never "cut voting short". Making the biggest, most
      // thumb-reachable button end voting early would invite exactly the
      // mis-hit that costs a question its votes; it stays dim until the
      // countdown has actually run out. 提前结束 remains in the grid.
      return {
        action: "REVEAL",
        label: "公布结果",
        hint: expired ? "倒计时已结束" : "等倒计时走完，或用下面的提前结束",
      };
    case "LOCKED":
      return { action: "REVEAL", label: "公布结果", hint: "大屏和手机显示全场怎么选" };
    case "REVEAL":
      return last
        ? { action: "NEXT", label: "看全场回顾", hint: "结束这一轮" }
        : { action: "NEXT", label: "下一题", hint: `进入第 ${state.qIndex + 2} 题` };
    default:
      return null;
  }
}

export default function Admin() {
  const [key] = useState(() => new URLSearchParams(window.location.search).get("k") ?? "");
  const { state, setState, offline, offset } = useGameState(POLL_MS, key || undefined);
  const [questions, , contentFailed] = useQuestions(state?.contentVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joinInput, setJoinInput] = useState("");

  const remaining = useCountdown(state?.phase === "VOTING" ? state.phaseEndsAt : null, offset);
  const expired = state?.phase === "VOTING" && remaining === 0;

  // Three mutually exclusive modes, derived from the two clock fields alone —
  // no separate flag the server and this console could disagree about. Both
  // null is idle; gameEndsAt set is running; gamePausedMs set is paused. See
  // #34 for the wire contract.
  const gameMode =
    state?.gamePausedMs != null ? "paused" : state?.gameEndsAt != null ? "running" : "idle";

  // The whole segment, not this question. Server-authoritative, so it survives
  // a reload and reads the same on a second console; display only, so nothing
  // transitions on it here or on the server — the clock reaching zero changes
  // nothing about the poll game, only what this tile says.
  const left = useCountdown(gameMode === "running" ? state.gameEndsAt : null, offset);
  const overrun = gameMode === "running" && left === 0;
  const gameDurationMs = state?.gameDurationMs ?? GAME_DURATION_DEFAULT_MS;
  const durationMinutes = Math.round(gameDurationMs / 60_000);

  // The join clock: two modes, not three. This is the one clock here the room
  // can see — it is drawn on /screen next to the QR during LOBBY — so the tile
  // below is a mirror of what is on the wall, not a private note like 全场.
  const joinRunning = state?.joinEndsAt != null;
  const joinLeft = useCountdown(joinRunning ? state.joinEndsAt : null, offset);
  const joinDurationMs = state?.joinDurationMs ?? JOIN_DURATION_DEFAULT_MS;
  const joinMinutes = Math.round(joinDurationMs / 60_000);
  // ±1 分钟 moves the live deadline while running and the configured length
  // while stopped, so the bound to check against differs by mode. Running is
  // bounded only at the bottom: the server floors it at now.
  const joinAtFloor = joinRunning ? joinLeft === 0 : joinMinutes <= JOIN_MIN_MINUTES;
  const joinAtCeiling = joinRunning ? false : joinMinutes >= JOIN_MAX_MINUTES;
  // Dim while stopped (this is what it will run for), plain while running, and
  // alert once it hits 0:00 — which is the operator's cue to press 显示游戏规则.
  const joinFaceClass = !joinRunning ? "is-dim" : joinLeft === 0 ? "is-urgent" : "";
  // Held locally, not derived from state: while the operator is mid-keystroke
  // on "1" of "15", a value driven off joinDurationMs would fight the typing.
  // It commits on 确定 (or Enter) and clears, so the field is never a stale
  // number sitting next to a length it no longer describes.
  const joinTyped = Number.parseInt(joinInput, 10);
  const joinTypedOk =
    Number.isInteger(joinTyped) && joinTyped >= JOIN_MIN_MINUTES && joinTyped <= JOIN_MAX_MINUTES;

  // Keep the key out of the address bar: it lands in browser history and is
  // exposed the moment this screen is ever mirrored. It stays in memory.
  useEffect(() => {
    if (key && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [key]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  if (!key) return <KeyPrompt label="操作台密钥" />;

  // Nothing has come back yet. This used to fall through to the page below,
  // where a null state renders the primary button as "已结束 · 按重置开始新一轮"
  // — so a slow first poll told the operator the show was over before it had
  // started. Say what is actually happening instead, the way /screen does.
  if (!state) {
    return (
      <main className="admin admin--prompt">
        <p className="muted">连接中…</p>
      </main>
    );
  }

  // /state answers unauthenticated too, so a wrong key still returns a phase
  // and a question count — the console would look completely normal and then
  // refuse every button press. `admin` is the part only a correct key gets.
  if (!state.admin) {
    return (
      <KeyPrompt
        label="操作台密钥"
        error="这个密钥不对。密钥是启动容器时的 ADMIN_KEY（见 .env，默认 dev）。"
      />
    );
  }

  async function run(action, extra = {}) {
    if (action === "RESET" && !window.confirm("清空所有投票和加入人数，回到第 1 题？")) return;
    // Same reasoning as RESET's guard: this discards a frozen remaining time
    // (or a running one) with a single tap, so it gets the same speed bump.
    if (action === "TIMER_RESET" && !window.confirm("把全场计时清零，回到设定时长？")) return;
    // In LOBBY, Next means "skip this question entirely" — it never reaches
    // the projector and no split is ever published for it.
    if (action === "NEXT" && state?.phase === "LOBBY") {
      if (!window.confirm(`跳过第 ${state.qIndex + 1} 题，直接进入第 ${state.qIndex + 2} 题？`)) {
        return;
      }
    }

    setBusy(true);
    try {
      setState(await postAdmin(key, action, extra));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "网络错误");
    } finally {
      setBusy(false);
    }
  }

  // Offline mode: the room is being run by show of hands. Named `noPhones`
  // because `offline` on this page already means the console has lost the
  // server — see the pill in the footer.
  const noPhones = Boolean(state.offline);

  const enabled = (action) => {
    if (!state) return false;
    switch (action) {
      case "START":
        return state.phase === "LOBBY" || state.phase === "REVEAL";
      case "LOCK":
      case "EXTEND":
        return state.phase === "VOTING";
      case "REVEAL":
        return state.phase === "LOCKED" || expired;
      case "NEXT":
        return (
          state.phase === "REVEAL" ||
          (state.phase === "LOBBY" && state.qIndex + 1 < state.questionCount) ||
          // Offline, straight on from a question that is over — the server
          // allows exactly this and refuses it online.
          (noPhones && (state.phase === "LOCKED" || expired))
        );
      case "BACK":
        return Boolean(state.admin?.canUndo);
      // The segment clock is a separate state machine from the poll — see the
      // gameMode derivation above. TIMER_START covers both idle's "开始计时"
      // and paused's "继续", exactly as the server's action table does.
      case "TIMER_START":
        return gameMode === "idle" || gameMode === "paused";
      case "TIMER_PAUSE":
        return gameMode === "running";
      case "TIMER_SET":
        return gameMode === "idle";
      case "TIMER_RESET":
        return true;
      // The join clock is a third state machine, independent of both the poll
      // and the segment clock. Open or shut — no paused mode to guard against.
      case "JOIN_START":
        return !joinRunning;
      case "JOIN_STOP":
        return joinRunning;
      // Live in both modes on purpose: this is the one control the operator
      // reaches for while the room is still filling, and refusing it when the
      // clock happens to be stopped would just mean pressing start first.
      case "JOIN_ADJUST":
        return true;
      // Stopped only, matching the server. The controls are hidden rather than
      // disabled while running, the way 全场时长's chips are — an absent button
      // cannot be mis-hit onto a countdown the room is reading.
      case "JOIN_SET":
        return !joinRunning;
      default:
        return true;
    }
  };

  const primary = primaryFor(state, expired);
  // The same live tally the wall is drawing, plus the raw counts the wall does
  // not show — whoever decides when to close a question has to be able to see
  // how many have voted, not only how they split.
  const tally = state?.tally;
  const votes = totalVotes(tally);
  // The same function the phones and the wall use, so a percentage read off
  // this console is the percentage on the projector.
  const shares = sharesOf(tally);
  const question = questions[state?.qIndex ?? 0];
  const options = optionsOf(question);
  const hasSound = Boolean(question?.audio) || someOptionHas(options, "audio");
  const placeholders = hasPlaceholder(questions);

  return (
    <main className="admin">
      {/* Operator only — never rendered on /screen. */}
      {placeholders && (
        <div className="admin__alarm">
          {contentFailed
            ? "题目内容没能从服务端加载，大屏上会是占位文案。刷新页面重试。"
            : "有题目仍是【占位】文案 —— 去 /admin 填内容。"}
        </div>
      )}

      {/* Always here while the mode is on, above everything the host reads:
          which mode the room is in decides what every button below is about
          to do. There is no switch on this page — it is on the setup page,
          where it cannot be hit by a thumb reaching for 下一题. */}
      {noPhones && (
        <div className="admin__mode">
          <strong>离线模式</strong>
          <span>不用手机投票 · 在准备页 /admin 切换</span>
        </div>
      )}

      <header className="admin__status">
        <div className="admin__stat">
          <span className="admin__stat-label">阶段</span>
          <strong className={`admin__phase--${state?.phase ?? "none"}`}>
            {state?.phase ?? "…"}
            {expired ? " 到时" : ""}
          </strong>
        </div>
        <div className="admin__stat">
          <span className="admin__stat-label">题目</span>
          <strong>
            {(state?.qIndex ?? 0) + 1} / {state?.questionCount ?? "?"}
          </strong>
        </div>
        <div className="admin__stat">
          <span className="admin__stat-label">剩余</span>
          <strong className={remaining != null && remaining <= 10_000 ? "is-urgent" : ""}>
            {remaining == null ? "—" : `${Math.ceil(remaining / 1000)}s`}
          </strong>
        </div>
        <div className="admin__stat">
          <span className="admin__stat-label">加入</span>
          <strong>{state?.joined ?? 0}</strong>
        </div>
        {/* Appended rather than slotted in next to 剩余, so the four tiles the
            operator already reads by position do not move. Three faces for
            three modes: dimmed while idle (this is what it will run for, not
            what it is doing), live while running, static and labelled while
            paused so a glance can't mistake a frozen clock for a stopped one. */}
        <div className="admin__stat">
          <span className="admin__stat-label">{gameMode === "paused" ? "全场·暂停" : "全场"}</span>
          <strong className={overrun ? "is-urgent" : gameMode === "idle" ? "is-dim" : ""}>
            {gameMode === "running"
              ? overrun
                ? "超时"
                : clock(left)
              : gameMode === "paused"
                ? clock(state.gamePausedMs)
                : state
                  ? clock(gameDurationMs)
                  : "—"}
          </strong>
        </div>
        {/* Appended after 全场 for the same reason 全场 was appended after 加入:
            the tiles the operator reads by position never move. Two faces for
            two modes, and the dimmed one is the length the next start will use
            — which is also the only state in which /screen shows no clock at
            all, so a dim tile here means a clean wall out there. */}
        {/* Gone in offline mode along with the clock it mirrors. It is the
            last tile, so its going moves none of the others. */}
        {!noPhones && (
          <div className="admin__stat">
            <span className="admin__stat-label">入场</span>
            <strong className={joinFaceClass}>
              {joinRunning ? clock(joinLeft ?? 0) : state ? clock(joinDurationMs) : "—"}
            </strong>
          </div>
        )}
      </header>

      {/* Which question is actually loaded, before the operator commits to
          starting it. topic is the question's short name. The room does see it
          — but only on the final recap, never while a question is live — so
          mid-question it is still this console's alone. */}
      {["LOBBY", "VOTING", "LOCKED", "REVEAL"].includes(state?.phase) && question?.title && (
        <section className="admin__question">
          {question.topic && <span className="admin__question-topic">{question.topic}</span>}
          <strong className="admin__question-title">{question.title}</strong>
        </section>
      )}

      {/* Offline there is no tally: a row of bars stuck at zero would read as
          "nobody has voted yet", when nobody is going to. */}
      {noPhones ? (
        <section className="admin__tally">
          <p className="admin__tally-note">离线模式：不收集投票，请现场带大家举手表态。</p>
        </section>
      ) : (
        <section className="admin__tally">
          {options.map((option) => {
            const count = tally?.[option.key] ?? 0;
            const pct = shares?.[option.key] ?? 0;
            return (
              <div key={option.key} className={`admin__tally-row key--${option.key}`}>
                <span className="admin__tally-label">{option.label}</span>
                <div className="admin__tally-bar">
                  <div className="admin__tally-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="admin__tally-count num">
                  {count} · {pct}%
                </span>
              </div>
            );
          })}
          <p className="admin__tally-total">
            共 <b className="num">{votes}</b> 票
          </p>
        </section>
      )}

      {/* The host's own prompt for what to say once a question is over. Online
          that moment is the reveal. Offline there is no reveal, and the moment
          is when time is called — which is exactly when the room starts
          talking and the host needs the note. */}
      {(state?.phase === "REVEAL" || (noPhones && (state?.phase === "LOCKED" || expired))) &&
        question?.note && (
          <section className="admin__note">
            <span className="admin__stat-label">点评提示</span>
            <p>{question.note}</p>
          </section>
        )}

      <div className="admin__controls">
        <button
          className="admin__primary"
          onClick={() => primary && run(primary.action)}
          disabled={busy || !primary || !enabled(primary.action)}
        >
          <span className="admin__primary-label">{primary?.label ?? "已结束"}</span>
          <span className="admin__primary-hint">{primary?.hint ?? "按重置开始新一轮"}</span>
        </button>

        <div className="admin__grid">
          {/* Replay covers the option clips too — on a question whose options
              are recordings, they are the only sound there is. */}
          {[...ADJUSTMENTS, RULES_TOGGLE, ...(hasSound ? [REPLAY] : [])].map((button) => (
            <button
              key={button.action}
              className="admin__button"
              onClick={() => run(button.action)}
              disabled={busy || !state || !button.live(state)}
            >
              <span className="admin__button-icon">{button.icon}</span>
              <span className="admin__button-label">
                {typeof button.label === "function" ? button.label(state) : button.label}
              </span>
            </button>
          ))}
        </div>

        {/* Below the grid, not among it: the six show buttons above keep the
            fixed positions the operator reads by touch alone, and this
            section changes shape as the segment clock changes mode. The
            length picker only exists while idle — not disabled, absent — so
            there is no chip left on screen to mis-hit and discard a frozen
            8:42 mid-run. The server enforces the same rule; this is the UI
            half of it. */}
        <section className="admin__timer">
          {gameMode === "idle" && (
            <>
              <div className="answer__row">
                <span className="admin__stat-label">全场时长</span>
                <div className="answer__durations">
                  {TIMER_PRESETS_MIN.map((minutes) => (
                    <button
                      key={minutes}
                      className={`answer__pick ${durationMinutes === minutes ? "is-set" : ""}`}
                      disabled={busy || !enabled("TIMER_SET")}
                      onClick={() => run("TIMER_SET", { minutes })}
                    >
                      {minutes}
                    </button>
                  ))}
                  <button
                    className="answer__pick"
                    disabled={busy || !enabled("TIMER_SET") || durationMinutes <= 1}
                    onClick={() => run("TIMER_SET", { minutes: durationMinutes - 1 })}
                  >
                    −1 分
                  </button>
                  <button
                    className="answer__pick"
                    disabled={busy || !enabled("TIMER_SET") || durationMinutes >= 120}
                    onClick={() => run("TIMER_SET", { minutes: durationMinutes + 1 })}
                  >
                    +1 分
                  </button>
                </div>
              </div>
              <button
                className="admin__timer-action"
                onClick={() => run("TIMER_START")}
                disabled={busy || !enabled("TIMER_START")}
              >
                开始计时
              </button>
            </>
          )}

          {gameMode === "running" && (
            <div className="admin__timer-row">
              <button
                className="admin__timer-action"
                onClick={() => run("TIMER_PAUSE")}
                disabled={busy || !enabled("TIMER_PAUSE")}
              >
                暂停
              </button>
              <button
                className="admin__timer-action admin__timer-action--ghost"
                onClick={() => run("TIMER_RESET")}
                disabled={busy || !enabled("TIMER_RESET")}
              >
                重置计时
              </button>
            </div>
          )}

          {gameMode === "paused" && (
            <div className="admin__timer-row">
              <button
                className="admin__timer-action"
                onClick={() => run("TIMER_START")}
                disabled={busy || !enabled("TIMER_START")}
              >
                继续
              </button>
              <button
                className="admin__timer-action admin__timer-action--ghost"
                onClick={() => run("TIMER_RESET")}
                disabled={busy || !enabled("TIMER_RESET")}
              >
                重置计时
              </button>
            </div>
          )}
        </section>

        {/* The join clock, in its own block below the segment clock's. Both
            are stopwatches, but only this one is on the wall, so it gets its
            own heading rather than a fifth mode in the section above — the
            operator has to be able to tell at a glance which clock a button
            is about to move.

            Unlike 全场时长, the ±1 分钟 pair is present in both modes. It is
            the same control either way: while stopped it sets the length the
            next start uses, while running it stretches the window the room is
            already watching. That is the difference from TIMER_SET, and it is
            deliberate — see #47.

            Not offered in offline mode. The clock it runs is drawn beside the
            join QR, and offline there is no QR and nobody being asked to
            scan: a button here would start a countdown no wall is showing. */}
        {!noPhones && (
          <section className="admin__timer admin__timer--join">
            <div className="answer__row">
              <span className="admin__stat-label">
                {joinRunning ? "入场倒计时 · 进行中" : "入场倒计时"}
              </span>
              <div className="answer__durations">
                {/* Absent while running, not disabled — see the enabled() case.
                  ±1 分钟 below stays in both modes because a nudge is safe on
                  a live window; these jump to a number and are not. */}
                {!joinRunning &&
                  JOIN_PRESETS_MIN.map((minutes) => (
                    <button
                      key={minutes}
                      className={`answer__pick ${joinMinutes === minutes ? "is-set" : ""}`}
                      disabled={busy || !enabled("JOIN_SET")}
                      onClick={() => run("JOIN_SET", { minutes })}
                    >
                      {minutes}
                    </button>
                  ))}
                <button
                  className="answer__pick"
                  disabled={busy || !enabled("JOIN_ADJUST") || joinAtFloor}
                  onClick={() => run("JOIN_ADJUST", { minutes: -1 })}
                >
                  −1 分钟
                </button>
                <button
                  className="answer__pick"
                  disabled={busy || !enabled("JOIN_ADJUST") || joinAtCeiling}
                  onClick={() => run("JOIN_ADJUST", { minutes: 1 })}
                >
                  +1 分钟
                </button>
              </div>
            </div>

            {/* A form, so the phone keyboard's own return key commits it — the
              operator should not have to find 确定 with a thumb after typing.
              Hidden while running for the same reason the chips are. */}
            {!joinRunning && (
              <form
                className="admin__timer-custom"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!joinTypedOk) return;
                  run("JOIN_SET", { minutes: joinTyped });
                  setJoinInput("");
                }}
              >
                <input
                  className="admin__timer-input"
                  type="number"
                  inputMode="numeric"
                  min={JOIN_MIN_MINUTES}
                  max={JOIN_MAX_MINUTES}
                  step="1"
                  placeholder="自定义"
                  aria-label="自定义入场倒计时分钟数"
                  value={joinInput}
                  onChange={(event) => setJoinInput(event.target.value)}
                />
                <span className="admin__timer-unit">分钟</span>
                <button
                  type="submit"
                  className="answer__pick"
                  disabled={busy || !enabled("JOIN_SET") || !joinTypedOk}
                >
                  确定
                </button>
              </form>
            )}

            {joinRunning ? (
              <button
                className="admin__timer-action admin__timer-action--ghost"
                onClick={() => run("JOIN_STOP")}
                disabled={busy || !enabled("JOIN_STOP")}
              >
                关闭入场计时
              </button>
            ) : (
              <button
                className="admin__timer-action"
                onClick={() => run("JOIN_START")}
                disabled={busy || !enabled("JOIN_START")}
              >
                {/* Named, not just "开始计时": the segment block above ends in a
                  button of exactly that name, and the two sit a thumb's width
                  apart on a phone held in the dark. The section headings tell
                  them apart on a screen you are looking at; the button labels
                  have to tell them apart on one you are not. */}
                开始入场计时
              </button>
            )}
          </section>
        )}

        {/* Its own row, away from the irreversible ones. Back cannot un-show
            what the room already saw, so the guard that matters is distance
            from Reveal and Next, not the undo stack. */}
        <button
          className="admin__back"
          onClick={() => run("BACK")}
          disabled={busy || !enabled("BACK")}
        >
          返回上一步
        </button>
      </div>

      <footer className="admin__foot">
        <button className="admin__reset" onClick={() => run("RESET")} disabled={busy}>
          重置（彩排用）
        </button>
        {offline && <span className="pill pill--warn">与服务器失去连接</span>}
        {/* This used to mean the bundle and the server's deck had drifted apart
            at build time. With the question list living on the server it means
            this console's copy is stale — transient, because adding or deleting
            a question bumps contentVersion and the next poll refetches — or
            that /content never loaded at all, which is worth saying plainly. */}
        {state && state.questionCount !== questions.length && (
          <span className="pill pill--warn">
            {contentFailed
              ? `题目没能加载：服务端 ${state.questionCount} 题，这里显示的是打包内容 ${questions.length} 题`
              : `题目刚改过，这里还是 ${questions.length} 题（服务端 ${state.questionCount}），稍等或刷新`}
          </span>
        )}
      </footer>

      {error && <div className="admin__error">{error}</div>}
    </main>
  );
}
