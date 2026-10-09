// Same origin by default. The frontend and the API are served by one process,
// so there is no base URL to configure and no CORS in the system at all.
//
// This being the default rather than a build-time env var is deliberate: it is
// now impossible to bake a localhost URL into a production bundle, which is
// exactly how a stale build once shipped pointing at http://localhost:8787.
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

// A request that never returns is worse than one that fails: the page keeps
// rendering stale state while looking perfectly healthy. Venue wifi drops
// packets in both directions, so every call needs a deadline.
const DEFAULT_TIMEOUT_MS = 4000;
// An upload is a different animal — 200KB of base64 on a congested uplink
// legitimately takes longer than four seconds.
const UPLOAD_TIMEOUT_MS = 15_000;
const AUDIO_UPLOAD_TIMEOUT_MS = 90_000;
// 40MB of video is ~53MB of base64. At a pessimistic 2Mbps up in a hall full
// of people that is nearly four minutes, and a timeout here throws away the
// whole upload rather than the last packet of it.
const VIDEO_UPLOAD_TIMEOUT_MS = 600_000;
// Pictures are compressed to ~200KB in the browser first, so they keep the
// short default; audio and video are uploaded as-is.
const UPLOAD_TIMEOUTS_MS = {
  audio: AUDIO_UPLOAD_TIMEOUT_MS,
  video: VIDEO_UPLOAD_TIMEOUT_MS,
};

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // AbortController + setTimeout rather than AbortSignal.timeout(): the
  // audience opens this in WeChat's in-app WebView, whose older Android cores
  // predate that API.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw err.name === "AbortError" ? new ApiError(0, "TIMEOUT") : err;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // An empty or non-JSON body is still an error we can report by status.
  }

  if (!res.ok) throw new ApiError(res.status, payload?.error ?? `HTTP_${res.status}`);
  return payload;
}

export const getState = (adminKey) =>
  request(adminKey ? `/state?k=${encodeURIComponent(adminKey)}` : "/state");

export const postJoin = (voterId) => request("/join", { method: "POST", body: { voterId } });

export const postVote = (voterId, qIndex, choice) =>
  request("/vote", { method: "POST", body: { voterId, qIndex, choice } });

// extra carries the one action that needs more than a verb: TIMER_SET's
// { minutes }. Every other action ignores it, so existing callers pass
// nothing and are unaffected.
export const postAdmin = (key, action, extra = {}) =>
  request("/admin", { method: "POST", body: { key, action, ...extra } });

export const getContent = () => request("/content");

/** The one per-question setting the setup page owns outside the content: the countdown. */
export const postMeta = (key, qIndex, patch) =>
  request("/admin/meta", { method: "POST", body: { key, qIndex, ...patch } });

export const postContent = (key, qIndex, question) =>
  request("/admin/content", { method: "POST", body: { key, qIndex, question } });

/** Add a question to the end of the deck, or delete the one at qIndex. */
export const postAddQuestion = (key) =>
  request("/admin/questions", { method: "POST", body: { key, action: "ADD" } });

export const postDeleteQuestion = (key, qIndex) =>
  request("/admin/questions", { method: "POST", body: { key, action: "DELETE", qIndex } });

/**
 * kind is "image", "audio" or "video". `option` is an option key when the file
 * belongs to one option rather than to the question itself — it only shapes the
 * stored object's name; what makes the upload stick is saving the url it
 * returns into that option.
 */
export const postUpload = (key, qIndex, kind, contentType, data, option) =>
  request("/admin/upload", {
    method: "POST",
    body: { key, qIndex, kind, option, contentType, data },
    timeoutMs: UPLOAD_TIMEOUTS_MS[kind] ?? UPLOAD_TIMEOUT_MS,
  });
