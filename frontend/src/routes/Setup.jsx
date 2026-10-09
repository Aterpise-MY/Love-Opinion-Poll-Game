import { useEffect, useState } from "react";
import QRCode from "qrcode";

import {
  ApiError,
  getState,
  postAddQuestion,
  postAdmin,
  postContent,
  postDeleteQuestion,
  postMeta,
  postUpload,
} from "../lib/api.js";
import {
  MAX_OPTIONS,
  MIN_OPTIONS,
  OPTION_MEDIA,
  nextOptionKey,
  optionsOf,
} from "../lib/choices.js";
import {
  BODY_SIZE_MAX,
  BODY_SIZE_MIN,
  bodyLayoutOf,
  hasPlaceholder,
  useQuestions,
} from "../lib/content.js";
import { EMOJI_GROUPS, seedIcon } from "../lib/emoji.js";
import { useGameState } from "../lib/hooks.js";
import { compressImage, toBase64 } from "../lib/image.js";
import { KINDS } from "../lib/media.js";
import { Switch } from "../lib/ui.jsx";
import KeyPrompt from "./KeyPrompt.jsx";
// The projector's own panel component, rendered here with the draft. Sharing it
// is what makes the preview trustworthy — see Stage in Screen.jsx.
import { Stage } from "./Screen.jsx";

/**
 * The page you open before the event. It hands out the three room links,
 * carries the QR the audience scans, and is where the question content is
 * written — text, a picture, an audio clip, or any combination.
 *
 * The options and the countdown are set here too. They override the defaults
 * baked in from content/questions.source.json, and both survive a RESET —
 * though not a restart of the container, which holds all of it in memory.
 *
 * There is no correct option to set. This is an opinion poll, so an option is
 * a key, a label, an icon and its media, all of it public: GET /content, which
 * every phone fetches unauthenticated, carries the whole list, and the server
 * whitelists that response down to those fields so nothing else can ride along.
 * The one thing that travels only over authenticated routes is the countdown —
 * /state?k= to read, /admin/meta to write.
 *
 * It is also where offline mode is switched: one card near the top that turns
 * phone voting off for the whole room. That is the only thing on this page
 * that follows the live game, so it is the only thing here that polls.
 */
export default function Setup() {
  const [key] = useState(() => new URLSearchParams(window.location.search).get("k") ?? "");
  // Bumped whenever this page changes the shape of the deck, which makes
  // useQuestions refetch. Without it the page reads /content exactly once, so a
  // question added here would not appear until a reload — and a second operator
  // with the page open would never see it at all.
  const [refresh, setRefresh] = useState(0);
  const [questions, setQuestions, contentFailed] = useQuestions(refresh);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState(null);
  // Each question's countdown, from /state?k=. The same response is what
  // proves the key below, which is why this is read here and not off /content.
  const [settings, setSettings] = useState(null);
  // null while the first /state is in flight, then "ok", "bad" or "offline".
  const [auth, setAuth] = useState(null);
  // The live game, polled, for the offline-mode card and nothing else. The
  // rest of this page reads the server once and then holds its own drafts;
  // the mode switch cannot, because it shows a setting the room is acting on
  // and can only be pressed in a lobby — and the operator console, on another
  // device, is what moves the game in and out of one.
  const { state: live, setState: setLive } = useGameState(MODE_POLL_MS, key || undefined);
  // Offline mode itself. Not to be confused with `auth === "offline"` above,
  // which is this page failing to reach the server.
  const noPhones = Boolean(live?.offline);

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;

    getState(key)
      .then((s) => {
        if (cancelled) return;
        setSettings(s.admin?.questions ?? null);
        // The same response answers both questions. `admin` is present only for
        // a correct key, so its absence is the key being wrong — and finding
        // that out here, rather than from a 401 after a picture has been
        // chosen, compressed and uploaded, is the whole point of checking.
        setAuth(s.admin ? "ok" : "bad");
      })
      .catch(() => {
        if (cancelled) return;
        setSettings(null);
        setAuth("offline");
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  // Keep the key out of the address bar — it lands in browser history and is
  // exposed the moment this screen is ever mirrored. It stays in memory.
  useEffect(() => {
    if (key && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [key]);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  if (!key) return <KeyPrompt label="管理密钥" />;

  if (auth === null) {
    return (
      <main className="admin admin--prompt">
        <p className="muted">校验密钥…</p>
      </main>
    );
  }

  if (auth === "bad") {
    return (
      <KeyPrompt
        label="管理密钥"
        error="这个密钥不对。密钥是启动容器时的 ADMIN_KEY（见 .env，默认 dev）。"
      />
    );
  }

  const origin = window.location.origin;
  const links = [
    {
      id: "audience",
      title: "观众",
      hint: "投在大屏上让大家扫，或者念出这个地址",
      url: `${origin}/`,
      qr: true,
    },
    {
      id: "projector",
      title: "投影 1 · 题目",
      hint: "主屏。全屏打开在外接显示器上，演出前点一次页面以启用声音",
      url: `${origin}/screen`,
    },
    {
      id: "projector2",
      title: "投影 2 · 加入码",
      hint: "副屏。全程只显示二维码，开演后迟到的人靠它加入。主屏一开始出题就没有二维码了",
      url: `${origin}/screen2`,
    },
    {
      id: "operator",
      title: "操作台",
      hint: "用你的手机打开。绝对不要投到大屏上",
      url: `${origin}/operator?k=${encodeURIComponent(key)}`,
      secret: true,
    },
  ];

  return (
    <main className="setup">
      <header className="setup__head">
        <h1 className="setup__title">
          这样<span className="hl">恋爱</span>
          <em>可不可以</em>
        </h1>
        <p className="muted">开场前的准备页</p>
      </header>

      {/* The key could not be checked at all. Render the page rather than lock
          the operator out over one dropped request, but say so — otherwise a
          wrong key looks identical to a bad minute of venue wifi. */}
      {auth === "offline" && (
        <div className="admin__alarm">
          没能连上服务端，密钥还没验证过。下面的保存和上传可能会失败——刷新页面重试。
        </div>
      )}

      {hasPlaceholder(questions) && (
        <div className="admin__alarm">
          {contentFailed
            ? "题目内容没能从服务端加载，下面显示的是打包时的占位文案。刷新页面重试。"
            : "有题目仍是【占位】文案 —— 大屏上就会是这些字。"}
        </div>
      )}

      <ModeCard adminKey={key} live={live} setLive={setLive} />

      <section className="links">
        {links.map((link) => (
          // Offline, the audience link is the one card nobody needs: there is
          // nothing for a phone to do. It stays, marked, rather than vanishing
          // — the host may be about to switch back.
          <LinkCard key={link.id} {...link} off={link.id === "audience" && noPhones} />
        ))}
      </section>

      <ContentPanel
        adminKey={key}
        questions={questions}
        setQuestions={setQuestions}
        contentFailed={contentFailed}
        settings={settings}
        setSettings={setSettings}
        index={index}
        setIndex={setIndex}
        onStatus={setStatus}
        onDeckChange={() => setRefresh((n) => n + 1)}
      />

      <footer className="setup__foot">
        <button
          className="admin__reset"
          onClick={async () => {
            if (!window.confirm("清空所有投票和加入人数，回到第 1 题？")) return;
            try {
              await postAdmin(key, "RESET");
              setStatus({ tone: "ok", text: "已重置：票数和加入人数归零" });
            } catch (err) {
              setStatus({ tone: "bad", text: describe(err) });
            }
          }}
        >
          重置（开演前按一次）
        </button>
        {status && (
          <span className={`editor__status editor__status--${status.tone}`}>{status.text}</span>
        )}
      </footer>
    </main>
  );
}

// How often the offline-mode card asks the server what is true. One page, one
// host: a request every two seconds is nothing, and it is how long the switch
// can show a lobby that has just stopped being one.
const MODE_POLL_MS = 2000;

const LOBBY_ONLY = "只能在大厅或两题之间切换";

/**
 * Offline mode: run the room by show of hands, with the phones out of it.
 *
 * The switch shows what the server says, never what was last clicked here. It
 * sends "on" or "off" by name rather than "flip", so a copy of this page left
 * open on another laptop cannot turn the room the wrong way round. And it is
 * dead outside a lobby, where the server would refuse it anyway: switching
 * mid-question would take the buttons off three hundred phones in the middle
 * of a vote.
 */
function ModeCard({ adminKey, live, setLive }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const on = Boolean(live?.offline);
  const inLobby = live?.phase === "LOBBY";

  async function set(next) {
    setBusy(true);
    setError(null);
    try {
      setLive(await postAdmin(adminKey, next ? "OFFLINE_ON" : "OFFLINE_OFF"));
    } catch (err) {
      // The game left the lobby between the last poll and the click.
      setError(err instanceof ApiError && err.code === "WRONG_PHASE" ? LOBBY_ONLY : describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`mode ${on ? "is-on" : ""}`}>
      <div className="mode__body">
        <h2 className="mode__title">离线模式</h2>
        <p className="mode__hint">
          打开后不使用手机投票：手机不能投票，大屏不显示二维码和投票结果，由主持人现场带大家表态。
        </p>
        {live && !inLobby && <p className="mode__locked">{LOBBY_ONLY}</p>}
        {error && <p className="mode__error">{error}</p>}
      </div>
      <div className="mode__control">
        <Switch checked={on} disabled={busy || !live || !inLobby} onChange={set} label="离线模式" />
        {/* The word as well as the colour: which way a switch is set should
            not depend on knowing that pink means on. */}
        <span className="mode__state">{!live ? "…" : on ? "已打开" : "已关闭"}</span>
      </div>
    </section>
  );
}

function LinkCard({ title, hint, url, qr, secret, off = false }) {
  const [copied, setCopied] = useState(false);
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!qr) return;
    QRCode.toDataURL(url, { width: 520, margin: 1, errorCorrectionLevel: "M" })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [qr, url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard access needs a secure context; the URL is on screen anyway.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <article className={`link ${qr ? "link--wide" : ""} ${off ? "link--off" : ""}`}>
      <div className="link__body">
        <h2 className="link__title">
          {title}
          {off && <span className="link__off">离线模式下用不到</span>}
        </h2>
        <p className="link__hint">{hint}</p>
        <code className={`link__url ${secret ? "link__url--secret" : ""}`}>{url}</code>
        <div className="link__actions">
          <button className="admin__reset" onClick={copy}>
            {copied ? "已复制" : "复制地址"}
          </button>
          <a className="admin__reset" href={url} target="_blank" rel="noreferrer">
            新窗口打开
          </a>
        </div>
      </div>
      {qr && src && (
        <div className="qr link__qr">
          <img src={src} alt="扫码加入" />
          <span className="qr__url">{url.replace(/^https?:\/\//, "")}</span>
        </div>
      )}
    </article>
  );
}

// One-tap countdowns, and the range the custom box is allowed to reach. The
// bounds are the ones /admin/meta enforces — keep them in step, or the box will
// happily send a number the server throws back.
const DURATIONS = [20, 30, 40, 45, 60];
const MIN_DURATION = 5;
const MAX_DURATION = 600;

function ContentPanel({
  adminKey,
  questions,
  setQuestions,
  contentFailed,
  settings,
  setSettings,
  index,
  setIndex,
  onStatus,
  onDeckChange,
}) {
  const [draft, setDraft] = useState(() => toDraft(questions[index]));
  const [busy, setBusy] = useState(false);
  // Which option has its media drawer open, if any. One at a time: three upload
  // cards per option is a lot of page, and the list is meant to be readable as
  // a list of options.
  const [openMedia, setOpenMedia] = useState(null);
  // What is typed in the custom-seconds box. Kept as a string so a half-typed
  // "1" on the way to "120" does not fire a save.
  const [customDuration, setCustomDuration] = useState("");

  useEffect(() => setDraft(toDraft(questions[index])), [index, questions]);
  useEffect(() => setOpenMedia(null), [index]);

  const current = settings?.[index] ?? null;
  // A duration the presets cannot express lives in the box instead, so switching
  // questions still shows what this one is actually set to.
  const custom = current?.duration != null && !DURATIONS.includes(current.duration);
  useEffect(
    () => setCustomDuration(custom ? String(current.duration) : ""),
    [index, custom, current?.duration],
  );

  // A single value with no ambiguity, so it saves on click — nothing to lose
  // by forgetting to press save.
  async function setMeta(patch) {
    setBusy(true);
    try {
      const next = await postMeta(adminKey, index, patch);
      setSettings(next.admin?.questions ?? null);
      onStatus({ tone: "ok", text: `第 ${index + 1} 题已更新` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  // The typed seconds only reach the server on blur or Enter. Rejecting here
  // rather than clamping matches what /admin/meta does with the same number:
  // a silently-corrected countdown is one you find out about mid-show.
  function commitCustomDuration() {
    // Whatever happens, the box ends up showing what the countdown actually is.
    // Leaving a rejected number sitting there reads as accepted once the status
    // line times out four seconds later.
    const revert = () => setCustomDuration(custom ? String(current.duration) : "");
    const typed = customDuration.trim();
    if (!typed) return revert();

    const seconds = Math.round(Number(typed));
    if (!Number.isFinite(seconds) || seconds < MIN_DURATION || seconds > MAX_DURATION) {
      onStatus({ tone: "bad", text: `倒计时要在 ${MIN_DURATION}–${MAX_DURATION} 秒之间` });
      return revert();
    }

    setCustomDuration(String(seconds));
    if (seconds !== current?.duration) setMeta({ duration: seconds });
  }

  async function save(next = draft) {
    setBusy(true);
    try {
      const res = await postContent(adminKey, index, next);
      setQuestions((prev) =>
        prev.map((q, i) => (i === index ? { ...q, ...nonEmpty(res.question) } : q)),
      );
      onStatus({ tone: "ok", text: `第 ${index + 1} 题已保存` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  // Option edits go through the same content save as the text, because that is
  // where they live — the phones read them from /content. Only the countdown
  // is meta.
  const editOption = (position, patch) =>
    setDraft((prev) => ({
      ...prev,
      options: prev.options.map((option, i) => (i === position ? { ...option, ...patch } : option)),
    }));

  // Saved on blur rather than per keystroke: every save bumps contentVersion,
  // and every client in the room refetches /content when it changes.
  function commitOptions() {
    // Both sides go through optionsOf, so this compares values rather than
    // whichever key order an edit happened to leave behind.
    const norm = (options) => JSON.stringify(optionsOf({ options }));
    if (norm(draft.options) === norm(optionsOf(questions[index]))) return;
    save();
  }

  // Adding and deleting questions. Both are refused by the server outside the
  // lobby and, for deletes, while any question from here on has votes on it —
  // the tally is keyed by position, so cutting question 3 mid-show would hand
  // question 4's votes to question 3.
  async function addQuestion() {
    setBusy(true);
    try {
      const next = await postAddQuestion(adminKey);
      setSettings(next.admin?.questions ?? null);
      onDeckChange();
      setIndex(next.questionCount - 1);
      onStatus({ tone: "ok", text: `已加第 ${next.questionCount} 题，记得写内容` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  async function deleteQuestion() {
    const name = questions[index]?.topic || questions[index]?.title || `第 ${index + 1} 题`;
    if (!window.confirm(`删掉第 ${index + 1} 题「${name}」？它的文字和图片都会一起没有。`)) {
      return;
    }

    setBusy(true);
    try {
      const next = await postDeleteQuestion(adminKey, index);
      setSettings(next.admin?.questions ?? null);
      onDeckChange();
      setIndex(Math.min(index, next.questionCount - 1));
      onStatus({ tone: "ok", text: `已删掉第 ${index + 1} 题` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  // Picking from the palette saves immediately rather than waiting for a blur.
  // A click on an emoji is a finished decision the way a half-typed label is
  // not, and it computes the next options here rather than leaning on
  // commitOptions, which would read a draft React has not applied yet.
  async function pickIcon(position, icon) {
    const options = draft.options.map((option, i) =>
      i === position ? { ...option, icon } : option,
    );
    const next = { ...draft, options };
    setDraft(next);
    await save(next);
  }

  async function addOption() {
    // Keys are handed out from the unused ones and then kept for the life of the
    // option: the tally counts under the key, so renumbering on every edit would
    // move votes from one option to another.
    const key = nextOptionKey(draft.options);
    if (!key) return;
    const position = draft.options.length;
    const next = {
      ...draft,
      options: [...draft.options, { key, icon: seedIcon(position), label: `选项 ${position + 1}` }],
    };
    setDraft(next);
    await save(next);
  }

  async function removeOption(position) {
    if (draft.options.length <= MIN_OPTIONS) return;
    const options = draft.options.filter((_, i) => i !== position);
    const next = { ...draft, options };
    setDraft(next);
    await save(next);
  }

  /**
   * Copy this question's options onto every other question. The usual case is
   * one set of options for the whole deck, and doing that by hand is five
   * chances to leave one question with the old wording.
   *
   * It writes each question's currently displayed text back to the server along
   * with the options, so it is refused outright when /content failed to load:
   * what is displayed then is the bundle, and saving it would overwrite the real
   * text with 【占位】 placeholders.
   */
  async function applyOptionsToAll() {
    if (contentFailed) return;
    if (
      !window.confirm(`把这 ${draft.options.length} 个选项复制到全部 ${questions.length} 道题？`)
    ) {
      return;
    }

    setBusy(true);
    try {
      const options = draft.options;

      for (let i = 0; i < questions.length; i++) {
        if (i !== index) {
          await postContent(adminKey, i, { ...toDraft(questions[i]), options });
        }
      }

      setQuestions((prev) => prev.map((question) => ({ ...question, options })));
      onStatus({ tone: "ok", text: `选项已复制到全部 ${questions.length} 题` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Compress if it is a picture, check it against the same table the server
   * uses, send it, and hand back the url. Written once and called from both
   * levels: the question's own media and each option's go up the same way, and
   * the only difference is which field the url is then saved into.
   */
  async function uploadFile(kind, file, option) {
    let blob = file;
    let contentType = file.type;

    // Pictures get re-encoded to something small; audio and video go up as
    // they are, so they are checked here and rejected before a long upload
    // rather than after one.
    if (kind === "image") {
      const compressed = await compressImage(file);
      blob = compressed.blob;
      contentType = compressed.contentType;
    } else if (!KINDS[kind].types[contentType]) {
      throw new ApiError(400, "BAD_CONTENT_TYPE");
    } else if (blob.size > KINDS[kind].maxBytes) {
      throw new ApiError(400, "MEDIA_TOO_LARGE");
    }

    const data = await toBase64(blob);
    const { url } = await postUpload(adminKey, index, kind, contentType, data, option);
    return { url, bytes: blob.size };
  }

  async function upload(kind, file) {
    if (!file) return;
    setBusy(true);
    onStatus({ tone: "ok", text: kind === "image" ? "压缩中…" : "上传中…" });
    try {
      const { url, bytes } = await uploadFile(kind, file);

      // Save straight away: an upload that needs a second click to stick is an
      // upload you will lose.
      const next = { ...draft, [kind]: url };
      setDraft(next);
      await save(next);
      onStatus({ tone: "ok", text: `已上传并保存 · ${size(bytes)}` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
      setBusy(false);
    }
  }

  async function uploadToOption(position, kind, file) {
    if (!file) return;
    setBusy(true);
    onStatus({ tone: "ok", text: kind === "image" ? "压缩中…" : "上传中…" });
    try {
      const { url, bytes } = await uploadFile(kind, file, draft.options[position].key);
      await setOptionMedia(position, kind, url);
      onStatus({ tone: "ok", text: `已上传并保存 · ${size(bytes)}` });
    } catch (err) {
      onStatus({ tone: "bad", text: describe(err) });
      setBusy(false);
    }
  }

  // Both attaching and clearing go through here, so 移除 is a save with one
  // field emptied — which is exactly what the server's delete sweep looks for.
  async function setOptionMedia(position, kind, url) {
    const options = draft.options.map((option, i) =>
      i === position ? { ...option, [kind]: url } : option,
    );
    const next = { ...draft, options };
    setDraft(next);
    await save(next);
  }

  return (
    <section className="editor">
      <header className="editor__head">
        <strong>题目内容</strong>
        <div className="editor__tabs">
          {questions.map((q, i) => (
            <button
              key={q.id ?? i}
              className={`editor__tab ${i === index ? "is-active" : ""}`}
              onClick={() => setIndex(i)}
              title={q.topic}
            >
              {i + 1}
            </button>
          ))}
          {/* Shaped like a tab because that is what it makes. */}
          <button
            className="editor__tab editor__tab--add"
            title="加一题（只能在开演前或重置后）"
            disabled={busy}
            onClick={addQuestion}
          >
            ＋
          </button>
        </div>
      </header>

      <div className="editor__pair">
        <label className="editor__field">
          <span className="admin__stat-label">短标题（操作台和最后的回顾页会显示）</span>
          <input
            value={draft.topic}
            onChange={(event) => setDraft({ ...draft, topic: event.target.value })}
            placeholder="偷看对方手机"
          />
        </label>
        <label className="editor__field">
          <span className="admin__stat-label">题干（大屏和手机上都会显示）</span>
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="这样恋爱可不可以？"
          />
        </label>
      </div>

      <label className="editor__field">
        <span className="admin__stat-label">正文</span>
        <textarea
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          rows={5}
          placeholder="要让大家表态的恋爱情境"
        />
      </label>

      {/* Only worth showing once there is something to position. The controls
          are meaningless without body text, and the preview would be an empty
          white panel. */}
      {draft.body && (
        <BodyLayout
          draft={draft}
          busy={busy}
          // Redraws the preview without touching the server — what the slider
          // does while it is being dragged.
          onPreview={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          // Saved on click like the countdown rather than behind a separate
          // press: there is nothing half-typed about a radio button,
          // and the preview beside it has already shown what the change does.
          onCommit={(patch) => {
            const next = { ...draft, ...patch };
            setDraft(next);
            save(next);
          }}
        />
      )}

      <div className="editor__sides">
        <MediaSlot
          kind="image"
          label="图片"
          hint="自动压到 200KB 以内"
          value={draft.image}
          busy={busy}
          accept="image/*"
          onPick={(file) => upload("image", file)}
          onClear={() => {
            const next = { ...draft, image: "" };
            setDraft(next);
            save(next);
          }}
        />
        <MediaSlot
          kind="audio"
          label="音频"
          hint="最大 6MB，只在大屏上播放"
          value={draft.audio}
          busy={busy}
          accept="audio/*"
          onPick={(file) => upload("audio", file)}
          onClear={() => {
            const next = { ...draft, audio: "" };
            setDraft(next);
            save(next);
          }}
        />
        <MediaSlot
          kind="video"
          label="视频"
          hint="最大 40MB，只在大屏上播放"
          value={draft.video}
          busy={busy}
          accept="video/*"
          onPick={(file) => upload("video", file)}
          onClear={() => {
            const next = { ...draft, video: "" };
            setDraft(next);
            save(next);
          }}
        />
      </div>

      <section className="answer">
        <div className="answer__row answer__row--stack">
          <span className="admin__stat-label">投票选项</span>
          <div className="options">
            {draft.options.map((option, position) => {
              const attached = OPTION_MEDIA.filter((kind) => option[kind]).length;
              return (
                <div
                  key={option.key}
                  className={`option key--${option.key} ${
                    openMedia === position ? "has-media-open" : ""
                  }`}
                >
                  <EmojiField
                    value={option.icon}
                    disabled={busy}
                    onType={(icon) => editOption(position, { icon })}
                    onCommit={commitOptions}
                    onPick={(icon) => pickIcon(position, icon)}
                  />
                  <input
                    className="option__label"
                    value={option.label}
                    maxLength={24}
                    placeholder={`选项 ${position + 1}`}
                    aria-label="选项文字"
                    onChange={(event) => editOption(position, { label: event.target.value })}
                    onBlur={commitOptions}
                  />
                  <button
                    className={`option__media-toggle ${openMedia === position ? "is-open" : ""}`}
                    title="这个选项自己的图片、音频和视频"
                    aria-expanded={openMedia === position}
                    onClick={() => setOpenMedia(openMedia === position ? null : position)}
                  >
                    媒体
                    {attached > 0 && <span className="option__media-count">{attached}</span>}
                  </button>
                  <button
                    className="option__remove"
                    title={
                      draft.options.length <= MIN_OPTIONS
                        ? `至少要有 ${MIN_OPTIONS} 个选项`
                        : "删除这个选项"
                    }
                    disabled={busy || draft.options.length <= MIN_OPTIONS}
                    onClick={() => removeOption(position)}
                  >
                    ✕
                  </button>

                  {openMedia === position && (
                    <div className="option__media">
                      <MediaSlot
                        kind="image"
                        label="图片"
                        hint="自动压到 200KB 以内，手机和大屏都显示"
                        compact
                        value={option.image}
                        busy={busy}
                        accept="image/*"
                        onPick={(file) => uploadToOption(position, "image", file)}
                        onClear={() => setOptionMedia(position, "image", "")}
                      />
                      <MediaSlot
                        kind="audio"
                        label="音频"
                        hint="最大 6MB。大屏上按 A、B、C 的顺序依次播放"
                        compact
                        value={option.audio}
                        busy={busy}
                        accept="audio/*"
                        onPick={(file) => uploadToOption(position, "audio", file)}
                        onClear={() => setOptionMedia(position, "audio", "")}
                      />
                      <MediaSlot
                        kind="video"
                        label="视频"
                        hint="最大 40MB。大屏上静音循环播放，控制在几秒内"
                        compact
                        value={option.video}
                        busy={busy}
                        accept="video/*"
                        onPick={(file) => uploadToOption(position, "video", file)}
                        onClear={() => setOptionMedia(position, "video", "")}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="options__actions">
            <button
              className="admin__reset"
              disabled={busy || draft.options.length >= MAX_OPTIONS}
              title={draft.options.length >= MAX_OPTIONS ? `最多 ${MAX_OPTIONS} 个选项` : undefined}
              onClick={addOption}
            >
              ＋ 添加选项
            </button>
            <button
              className="admin__reset"
              disabled={busy || contentFailed}
              title={contentFailed ? "题目内容没能加载，现在复制会用占位文案覆盖服务端" : undefined}
              onClick={applyOptionsToAll}
            >
              复制到全部 {questions.length} 题
            </button>
          </div>
        </div>

        <div className="answer__row">
          <span className="admin__stat-label">倒计时</span>
          <div className="answer__durations">
            {DURATIONS.map((seconds) => (
              <button
                key={seconds}
                className={`answer__pick ${current?.duration === seconds ? "is-set" : ""}`}
                disabled={busy || !current}
                onClick={() => setMeta({ duration: seconds })}
              >
                {seconds}s
              </button>
            ))}
            <label className={`answer__pick answer__custom ${custom ? "is-set" : ""}`}>
              <input
                type="number"
                inputMode="numeric"
                min={MIN_DURATION}
                max={MAX_DURATION}
                step={1}
                value={customDuration}
                placeholder="自定"
                aria-label={`自定义倒计时秒数，${MIN_DURATION} 到 ${MAX_DURATION} 秒`}
                disabled={busy || !current}
                onChange={(event) => setCustomDuration(event.target.value)}
                onBlur={commitCustomDuration}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              {customDuration && "s"}
            </label>
          </div>
        </div>
      </section>

      <footer className="editor__foot">
        <button className="editor__save" onClick={() => save()} disabled={busy}>
          保存文字
        </button>
        <button
          className="editor__delete"
          onClick={deleteQuestion}
          disabled={busy || questions.length <= 1}
          title={questions.length <= 1 ? "至少要留一题" : "删掉这一题"}
        >
          删除本题
        </button>
      </footer>

      <p className="editor__hint">
        选项文字改完点一下别处就会保存；添加、删除和倒计时都是点一下立刻生效。每题
        {MIN_OPTIONS}–{MAX_OPTIONS} 个选项，各题可以不一样。倒计时想要 20/30/40/45/60 以外的秒数，
        就在最后那个框里直接输，回车或点一下别处生效，范围 {MIN_DURATION}–{MAX_DURATION} 秒。
        <br />
        <strong>选项没有对错</strong>——这是意见投票，每个选项只有文字、表情和颜色。
        投票期间大屏会实时显示每个选项的比例；手机要等操作台按下「公布结果」才显示全场怎么选。
        <br />
        彩排投过票以后再删选项，那些票会留在总数里但不再显示 ——
        改完选项按一次「重置」最稳。开演前改选项没有这个问题。
        <br />
        音频只在投影上播放，不会同时从 300 台手机里放出来。
      </p>
    </section>
  );
}

/**
 * The option's emoji: a text field with a palette hanging off it.
 *
 * It stays a text field rather than becoming a picker, because the palette can
 * only ever hold a fraction of the emoji someone might want and the fallback
 * has to be "type it" — which is exactly what this field already was. The
 * palette is the shortcut, not the interface.
 */
const PLACES = [
  { value: "above", label: "媒体上方" },
  { value: "below", label: "媒体下方" },
  { value: "over", label: "叠加在媒体上" },
];

const ALIGNS = [
  { value: "start", label: "左" },
  { value: "center", label: "居中" },
  { value: "end", label: "右" },
];

/**
 * 正文 position, and a projector preview of the result.
 *
 * The three controls are deliberately a closed set rather than a drag handle.
 * Every combination here lands inside the panel's height budget, so nothing the
 * setup page can produce puts a sentence off the wall — which matters because
 * this is edited in the last quiet minutes before a room fills up.
 */
function BodyLayout({ draft, busy, onPreview, onCommit }) {
  return (
    <div className="layout">
      <div className="layout__controls">
        <div className="layout__row">
          <span className="admin__stat-label">位置</span>
          <div className="layout__choices">
            {PLACES.map((place) => (
              <button
                key={place.value}
                type="button"
                className={`layout__chip ${draft.bodyPlace === place.value ? "is-on" : ""}`}
                disabled={busy}
                onClick={() => onCommit({ bodyPlace: place.value })}
              >
                {place.label}
              </button>
            ))}
          </div>
        </div>

        <div className="layout__row">
          <span className="admin__stat-label">对齐</span>
          <div className="layout__choices">
            {ALIGNS.map((align) => (
              <button
                key={align.value}
                type="button"
                className={`layout__chip ${draft.bodyAlign === align.value ? "is-on" : ""}`}
                disabled={busy}
                onClick={() => onCommit({ bodyAlign: align.value })}
              >
                {align.label}
              </button>
            ))}
          </div>
        </div>

        <div className="layout__row">
          <span className="admin__stat-label">
            字号 <b className="num">{Math.round(draft.bodySize * 100)}%</b>
          </span>
          {/* Committed on release, not on every frame of the drag: each save
              bumps contentVersion and every client in the room refetches
              /content when it changes. The preview still tracks the drag,
              because it reads the draft rather than the server. */}
          <input
            className="layout__slider"
            type="range"
            min={BODY_SIZE_MIN * 100}
            max={BODY_SIZE_MAX * 100}
            step={5}
            value={Math.round(draft.bodySize * 100)}
            disabled={busy}
            onChange={(event) => onPreview({ bodySize: Number(event.target.value) / 100 })}
            onPointerUp={(event) => onCommit({ bodySize: Number(event.target.value) / 100 })}
            onKeyUp={(event) => onCommit({ bodySize: Number(event.target.value) / 100 })}
          />
        </div>
      </div>

      <StagePreview draft={draft} />
    </div>
  );
}

/**
 * What the wall will show, shrunk.
 *
 * Rendered at a real projector's pixel size and then scaled down with a
 * transform, rather than rendered small. Every length in this layout is
 * relative to the viewport or to the panel — vw, vh, cqw, cqh — so a box that
 * is merely narrow resolves all of them differently and lies about the result.
 * At full size and scaled, the proportions are the ones the room gets.
 *
 * The surrounding rows are here for the same reason: .stage only gets its
 * height from the flex line the ticks, header, ballot and countdown leave
 * behind, so a preview without them would give the panel a budget the
 * projector never has.
 */
// The projector the preview pretends to be. Any 16:9 size would do — this one
// is only the number the measured scale below divides by.
const PREVIEW_W = 1600;

function StagePreview({ draft }) {
  const options = optionsOf(draft);
  const [frame, setFrame] = useState(null);
  const [scale, setScale] = useState(0.25);

  // Measured rather than computed in CSS: scale() takes a unitless ratio and
  // CSS cannot divide the frame's width by 1600 to produce one. Observed rather
  // than read once, because the admin column reflows — the editor's two-column
  // layout collapses under 720px and the frame changes width without the page
  // ever reloading.
  useEffect(() => {
    if (!frame) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / PREVIEW_W);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  return (
    <div className="preview">
      <span className="admin__stat-label">大屏预览</span>
      <div className="preview__frame" ref={setFrame}>
        <div className="preview__scale" style={{ "--preview-scale": scale }}>
          <main className="screen" data-stage="on">
            <div className="ticks">
              <span className="tick is-current" />
            </div>
            <header className="screen__head">
              <span className="screen__index badge">STAGE ?/?</span>
              <h1 className="screen__title">{draft.title || "这样恋爱可不可以？"}</h1>
            </header>

            <Stage question={draft}>
              {draft.image && <img className="stage__image" src={draft.image} alt="" />}
              {/* No autoplay and no sound: this is a still of a layout, not a
                  rehearsal of the clip. muted is what lets it paint a frame at
                  all without a gesture. */}
              {draft.video && (
                <div className="stage__video">
                  <video
                    className="stage__video-el"
                    src={draft.video}
                    muted
                    playsInline
                    preload="metadata"
                  />
                </div>
              )}
            </Stage>

            <section className="choices choices--bare" data-count={options.length}>
              {options.map((option) => (
                <article key={option.key} className={`choice-card key--${option.key}`}>
                  <div className="choice-card__foot">
                    {option.icon && <span className="choice-card__icon glyph">{option.icon}</span>}
                    <span className="choice-card__label">{option.label}</span>
                    <span className="choice-card__pct num">—</span>
                  </div>
                </article>
              ))}
            </section>

            <div className="countdown">
              <div className="countdown__track">
                <div className="countdown__fill" style={{ width: "60%" }} />
              </div>
              <div className="countdown__number num">30</div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function EmojiField({ value, disabled, onType, onCommit, onPick }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(null);

  useEffect(() => {
    if (!open || !host) return undefined;

    const away = (event) => {
      if (!host.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, host]);

  return (
    <div className="option__emoji" ref={setHost}>
      <input
        className="option__icon"
        value={value}
        maxLength={8}
        placeholder="♥"
        aria-label="表情"
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(event) => onType(event.target.value)}
        onBlur={onCommit}
      />
      {open && (
        // preventDefault on mousedown so the input never loses focus to the
        // palette: a blur here would fire the on-blur save a beat before the
        // pick that follows it, saving the old emoji and then the new one.
        <div className="emoji-pop" onMouseDown={(event) => event.preventDefault()}>
          {EMOJI_GROUPS.map((group) => (
            <div className="emoji-pop__group" key={group.name}>
              <span className="emoji-pop__name">{group.name}</span>
              <div className="emoji-pop__grid">
                {group.emoji.map((emoji) => (
                  <button
                    key={emoji}
                    className={`emoji-pop__pick ${emoji === value ? "is-set" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                      onPick(emoji);
                      setOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            className="emoji-pop__clear"
            disabled={disabled || !value}
            onClick={() => {
              onPick("");
              setOpen(false);
            }}
          >
            不用表情
          </button>
        </div>
      )}
    </div>
  );
}

function MediaSlot({ kind, label, hint, value, busy, accept, onPick, onClear, compact }) {
  const [ref, setRef] = useState(null);

  return (
    <div className={`editor__side ${compact ? "editor__side--compact" : ""}`}>
      <div className="editor__side-head">
        <span className="admin__stat-label">{label}</span>
        <div className="editor__side-actions">
          <button className="admin__reset" onClick={() => ref?.click()} disabled={busy}>
            {value ? "更换" : "上传"}
          </button>
          {value && (
            <button className="admin__reset" onClick={onClear} disabled={busy}>
              移除
            </button>
          )}
        </div>
        <input
          ref={setRef}
          type="file"
          accept={accept}
          hidden
          onChange={(event) => {
            onPick(event.target.files?.[0]);
            event.target.value = ""; // let the same file be picked again
          }}
        />
      </div>

      {value && kind === "image" && <img className="editor__preview" src={value} alt="" />}
      {value && kind === "audio" && <audio className="editor__audio" src={value} controls />}
      {/* preload="metadata" so opening the setup page does not pull 40MB per
          question down the venue uplink just to draw a preview. */}
      {value && kind === "video" && (
        <video className="editor__preview" src={value} controls preload="metadata" playsInline />
      )}
      {!value && <p className="editor__hint">{hint}</p>}
    </div>
  );
}

const size = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;

const toDraft = (question) => ({
  topic: question?.topic ?? "",
  title: question?.title ?? "",
  body: question?.body ?? "",
  image: question?.image ?? "",
  audio: question?.audio ?? "",
  video: question?.video ?? "",
  // Through bodyLayoutOf rather than read off the record, so a question saved
  // before this feature opens the editor showing the defaults it is actually
  // being rendered with rather than three empty controls.
  bodyPlace: bodyLayoutOf(question).place,
  bodyAlign: bodyLayoutOf(question).align,
  bodySize: bodyLayoutOf(question).size,
  // Never empty: a question that has never been edited comes back as the pair
  // the game shipped with, so the editor always has something to edit.
  options: optionsOf(question),
});

function nonEmpty(question) {
  const out = {};
  for (const field of ["topic", "title", "body", "image", "audio", "video"]) {
    if (question?.[field]) out[field] = question[field];
  }
  if (question?.options?.length) out.options = question.options;
  // Copied unconditionally, unlike the text fields above: the server always
  // returns all three (it defaults them in sanitizeQuestion), and dropping a
  // falsy one would strip a legitimately-saved value — bodySize can never be 0,
  // but making that the reason this works is a trap for the next edit.
  for (const field of ["bodyPlace", "bodyAlign", "bodySize"]) {
    if (question?.[field] !== undefined) out[field] = question[field];
  }
  return out;
}

const ERRORS = {
  MEDIA_TOO_LARGE: "文件太大了",
  BAD_CONTENT_TYPE: "不支持这个格式",
  BAD_KIND: "不支持这种媒体",
  UPLOADS_DISABLED: "服务端没有配置媒体存储",
  UNAUTHORIZED: "密钥不对",
  TIMEOUT: "上传超时，网络太慢",
  BAD_OPTIONS: "选项不合法：每题 2–6 个，每个都要有文字",
  BAD_DURATION: `倒计时要在 ${MIN_DURATION}–${MAX_DURATION} 秒之间`,
  BAD_OPTION_KEY: "这个选项不存在",
  WRONG_PHASE: "游戏已经开始了，加题删题要先按「重置」",
  VOTES_EXIST: "这题或后面的题已经有票了 —— 先按一次「重置」再删",
  LAST_QUESTION: "至少要留一题",
  TOO_MANY_QUESTIONS: "题目太多了",
};

function describe(err) {
  if (err instanceof ApiError) return ERRORS[err.code] ?? err.code;
  return "操作失败，检查网络";
}
