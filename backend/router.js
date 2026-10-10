// Transport-agnostic request handling. server.js is the only caller, but the
// split keeps every route testable without a socket — the whole suite runs
// against this function directly.

import {
  GAME_DURATION_MS,
  JOIN_DURATION_MS,
  MIN_OPTIONS,
  OPTION_KEYS,
  initialState,
  reduce,
  sanitizeName,
  validateVote,
  tallyVisible,
} from "./game.js";
import { decodeUpload, mediaKey } from "./media.js";

/**
 * The API surface, owned here rather than in server.js.
 *
 * server.js dispatches on exact (method, path) pairs — that is what lets
 * `GET /admin` be the setup page while `POST /admin` is this API. Keeping the
 * list next to the handlers means adding a route cannot silently 404 in
 * production while every unit test, which calls the router directly, passes.
 */
export const API_ROUTES = new Set([
  "GET /ready",
  "GET /state",
  "GET /content",
  "POST /join",
  "POST /vote",
  "POST /admin",
  "POST /admin/content",
  "POST /admin/meta",
  "POST /admin/upload",
  "POST /admin/image-scale",
  "POST /admin/questions",
]);

const initialStateFor = (now) => initialState(now);

// A question added during the show has no row in deck.json, because deck.json
// is what the show shipped with. It gets a neutral countdown, and the operator
// sets the real one with the same chips they use on every other question.
const NEW_QUESTION = { duration: 45 };
// Not an aesthetic limit: store-dynamo's batchGet builds a single
// BatchGetItemCommand, and DynamoDB caps that at 100 keys.
const MAX_QUESTIONS = 40;

/**
 * Slot ids name a question for as long as it exists.
 *
 * The first ones are the strings "0".."4" — the very keys content and meta
 * records were already written under — so a table from before questions could
 * be added needs no migration. Everything created afterwards gets a random one,
 * which is what makes deleting a question in the middle a splice of this list
 * rather than a renumbering of every record behind it.
 */
const newSlot = (now) => `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The live question list: which questions exist, in what order, and how long
 * each one's countdown runs.
 *
 * This used to be frozen at module load from the shipped deck. The setup page
 * can now add and delete questions, so the list is a property of the store —
 * but it costs nothing to read: the roster rides along on the same batched
 * state read that already carries the countdown overrides and the content
 * version.
 */
function liveList(defaults, state) {
  const slots =
    Array.isArray(state?.roster) && state.roster.length
      ? state.roster
      : defaults.map((_, i) => String(i));
  return { slots, questions: resolveQuestions(defaults, slots, state?.meta) };
}

const baseFor = (defaults, slot) => {
  const i = Number(slot);
  if (Number.isInteger(i) && i >= 0 && i < defaults.length) return defaults[i];
  return { id: `q-${slot}`, ...NEW_QUESTION };
};

/**
 * The shipped deck.json is the default; the setup page can override the
 * countdown per question. Overrides live in a single `meta` record that rides
 * along on the state read, so resolving them costs nothing.
 *
 * The countdown is the only thing a question has to override. Whatever else a
 * meta record holds is ignored rather than resolved — there is no correct
 * option here for one to name.
 */
function resolveQuestions(defaults, slots, meta = {}) {
  return slots.map((slot) => {
    const question = { ...baseFor(defaults, slot), slot };
    const override = meta?.[slot];
    if (!override) return question;
    return {
      ...question,
      duration:
        Number.isFinite(override.duration) && override.duration > 0
          ? override.duration
          : question.duration,
    };
  });
}

const ACTIONS = new Set([
  "START",
  "LOCK",
  "EXTEND",
  "REVEAL",
  "NEXT",
  "BACK",
  "REPLAY",
  "RESET",
  "TOGGLE_RULES",
  "OFFLINE_ON",
  "OFFLINE_OFF",
  "TIMER_START",
  "TIMER_PAUSE",
  "TIMER_RESET",
  "TIMER_SET",
  "JOIN_START",
  "JOIN_STOP",
  "JOIN_ADJUST",
  "JOIN_SET",
]);

// The one argument any TIMER_* action carries. Validated here rather than in
// game.js, the same split /admin/meta already draws for its own duration
// field: the wire boundary rejects a malformed number before it ever reaches
// the pure reducer, which can then trust the value it is given.
const MIN_MINUTES = 1;
const MAX_MINUTES = 120;
const isValidMinutes = (value) =>
  Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES;

// JOIN_ADJUST reuses the `minutes` field but means something different by it: a
// signed step, not a length. So it needs its own predicate — `isValidMinutes`
// would reject the −1 that half the buttons send. Zero is rejected too; an
// adjustment that adjusts nothing is a malformed request, not a no-op worth
// writing a new state revision for.
const MAX_ADJUST_MINUTES = 60;
const isValidAdjust = (value) =>
  Number.isInteger(value) && value !== 0 && Math.abs(value) <= MAX_ADJUST_MINUTES;

const json = (status, body) => ({ status, body });
const fail = (status, error) => json(status, { error });

/**
 * @param {object} deps
 * @param {object} deps.store        storage adapter (memory or dynamo)
 * @param {Array}  deps.defaults     the deck deck.json shipped with, and the
 *                                   seed for the live list: [{id, duration}]
 * @param {string} deps.adminKey
 * @param {object} [deps.images]     media storage adapter, or null to disable uploads
 */
export function createRouter({ store, defaults, adminKey, images = null }) {
  return async function handle({ method, path, query = {}, body = null, now = Date.now() }) {
    const isAdmin = Boolean(adminKey) && query.k === adminKey;
    // The live list, resolved from the one state read each handler already
    // needs. Handlers that address a question by position translate it to a
    // slot here — position is what the operator clicks, slot is what the
    // records are keyed by, and the two stop agreeing the moment a question in
    // the middle is deleted.
    const live = async () => {
      const state = await store.getState();
      return { state, ...liveList(defaults, state) };
    };

    // Readiness, for humans and smoke tests. NOT the load balancer's check —
    // that one lives in server.js and deliberately touches no dependencies.
    // `GET /` is not handled here: it belongs to the frontend.
    if (method === "GET" && path === "/ready") {
      let storeOk = true;
      let count = defaults.length;
      try {
        count = (await live()).slots.length;
      } catch {
        storeOk = false;
      }
      return json(storeOk ? 200 : 503, {
        ok: storeOk,
        store: storeOk ? "reachable" : "unreachable",
        questions: count,
        uploads: images ? ((await images.ready()) ? images.kind : "unavailable") : "disabled",
      });
    }

    // Authored question content: text, pictures and audio from the setup page.
    // Fetched once per client at page load, not polled — /state stays small.
    if (method === "GET" && path === "/content") {
      const { slots, questions } = await live();
      const stored = await store.getContent(slots);
      // Identity and countdown are composed here rather than stored, so the
      // content record stays exactly what the setup page writes. `id` is what
      // clients align their bundled copy against — by name, because after a
      // question in the middle is deleted, position 3 here and position 3 in
      // the bundle are different questions. `duration` has been public since
      // day one (it is in the bundle) and the projector's countdown bar needs
      // the live value, not the one it was built with.
      //
      // Nothing about the vote is here: this endpoint is fetched once per
      // client and not polled, so a count in it would be stale the moment it
      // arrived. How the room is splitting is /state's to say.
      return json(200, {
        questions: questions.map((question, i) => ({
          id: question.id,
          duration: question.duration,
          ...(stored[i] ?? {}),
        })),
      });
    }

    if (method === "GET" && path === "/state") {
      return json(200, await buildState({ store, defaults, now, isAdmin }));
    }

    if (method === "POST" && path === "/join") {
      const voterId = body?.voterId;
      if (typeof voterId !== "string" || voterId.length < 8 || voterId.length > 64) {
        return fail(400, "BAD_VOTER_ID");
      }
      const created = await store.recordJoin(voterId, now);
      return json(200, { ok: true, created });
    }

    if (method === "POST" && path === "/vote") {
      const { voterId, qIndex, choice } = body ?? {};
      const name = sanitizeName(body?.name);
      if (typeof voterId !== "string" || voterId.length < 8 || voterId.length > 64) {
        return fail(400, "BAD_VOTER_ID");
      }
      if (!Number.isInteger(qIndex)) return fail(400, "BAD_Q_INDEX");

      const state = await store.getState();
      const check = validateVote(state, { qIndex, choice }, now);
      if (!check.ok) return fail(check.status, check.code);

      const recorded = await store.recordVote({ qIndex, voterId, choice, now });
      if (!recorded) return fail(409, "ALREADY_VOTED");
      // Best effort: the vote is already counted, and a bubble is decoration.
      try {
        await store.appendRecentVote({ name, choice, qIndex, now });
      } catch (err) {
        console.error("recent-votes feed write failed", err?.name ?? err);
      }
      return json(200, { ok: true });
    }

    // Save one question's text. The frontend keeps the whole question in form
    // state and writes it back wholesale, so this is a plain replace.
    //
    // imageScale is deliberately excluded from that replace: the setup page's
    // form does not carry it (it is written only through POST
    // /admin/image-scale below), so a text-only save must carry whatever
    // scale is already stored forward rather than resetting it to default
    // just because this request didn't mention it.
    if (method === "POST" && path === "/admin/content") {
      const { key, qIndex, question } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");
      const { slots } = await live();
      if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= slots.length) {
        return fail(400, "BAD_Q_INDEX");
      }
      if (!question || typeof question !== "object") return fail(400, "BAD_CONTENT");

      const options = sanitizeOptions(question.options);
      if (options.error) return fail(400, options.error);

      const all = await store.getContent(slots);
      const existing = all[qIndex];
      // Two fields this request does not necessarily carry, both taken from what
      // is already on record rather than from the body. A save that says nothing
      // about the options keeps the saved ones: every other field is replaced
      // wholesale, which is safe because the setup page holds the whole question
      // in form state — but a client that predates options must not silently
      // return three hundred phones to the default pair.
      const clean = sanitizeQuestion(question, {
        options: options.list ?? existing?.options,
        imageScale: existing?.imageScale,
      });
      await store.putContent(slots[qIndex], clean);

      // Deleting comes after the write, never before. 移除 and 更换 are both
      // just a save with a media field changed, so this is the one place that
      // has to notice — and if it throws, the operator still got what they
      // asked for: the picture is off the question, and what is left is an
      // orphan in a bucket with a lifecycle rule on it. A stray object costs
      // pennies for thirty days. A picture the operator cannot remove is on the
      // projector, in front of the room.
      const swept = await sweepMedia({
        images,
        before: existing,
        after: clean,
        keep: all.filter((_, i) => i !== qIndex),
      });
      return json(200, { ok: true, question: clean, ...swept });
    }

    // The presenter's drag handle on /screen. A narrow sibling of
    // /admin/content rather than a field folded into it: /screen only ever
    // knows the one number it just dragged, never the rest of the question's
    // text, so a plain-replace endpoint would force it to round-trip content
    // it has no business rewriting.
    //
    // Same store path as /admin/content — content#<qIndex> — read-modify-
    // write so the other five fields survive untouched. No new persistence
    // mechanism, just a second door onto the one that already exists.
    if (method === "POST" && path === "/admin/image-scale") {
      const { key, qIndex, imageScale } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");
      const { slots } = await live();
      if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= slots.length) {
        return fail(400, "BAD_Q_INDEX");
      }
      // Reject, don't clamp — same posture as /admin/meta's duration check
      // just above. `imageScale` must be a genuine number in range; 0, -1,
      // 99, NaN, null, "1.8" and missing all fail this the same way and never
      // reach the store.
      if (!isValidImageScale(imageScale)) return fail(400, "BAD_IMAGE_SCALE");

      const stored = (await store.getContent(slots))[qIndex];
      // Same read-modify-write, from the other side: this caller knows the
      // scale and nothing else, so the options come off the record.
      const clean = sanitizeQuestion(stored ?? {}, {
        options: stored?.options,
        imageScale,
      });
      await store.putContent(slots[qIndex], clean);
      return json(200, { ok: true, question: clean });
    }

    // The one per-question setting the setup page owns outside the content
    // record: how long the countdown runs.
    //
    // Only `duration` is read off the body. A request that names nothing else —
    // an `answer`, say, from a client written for the quiz this was cloned from
    // — has nothing to set and is told so, rather than being answered 200 for a
    // field that was dropped on the floor.
    if (method === "POST" && path === "/admin/meta") {
      const { key, qIndex, duration } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");
      const { slots } = await live();
      if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= slots.length) {
        return fail(400, "BAD_Q_INDEX");
      }

      const patch = {};
      if (duration !== undefined) {
        if (!Number.isFinite(duration) || duration < 5 || duration > 600) {
          return fail(400, "BAD_DURATION");
        }
        patch.duration = Math.round(duration);
      }
      if (Object.keys(patch).length === 0) return fail(400, "NOTHING_TO_SET");

      await store.putMeta(slots[qIndex], patch);
      return json(200, await buildState({ store, defaults, now, isAdmin: true }));
    }

    // Add a question, or delete one. The deck used to be whatever deck.json
    // shipped with, fixed until the next build; this is how the operator gets
    // a sixth question written on the night, or cuts one when the room is
    // running long.
    if (method === "POST" && path === "/admin/questions") {
      const { key, action, qIndex } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");

      const { state, slots } = await live();
      // Structural edits are a pre-show and between-rounds thing. The tally and
      // the dedup records are keyed by position, so a list that changed shape
      // under a running question would move votes between questions — the
      // lobby is the one phase where there is nothing to move.
      if (state.phase !== "LOBBY") return fail(409, "WRONG_PHASE");

      if (action === "ADD") {
        if (slots.length >= MAX_QUESTIONS) return fail(400, "TOO_MANY_QUESTIONS");
        // Appended, so no existing question changes position and no tally can
        // be misattributed however this races with anything else.
        await store.putRoster([...slots, newSlot(now)]);
        return json(200, await buildState({ store, defaults, now, isAdmin: true }));
      }

      if (action === "DELETE") {
        if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= slots.length) {
          return fail(400, "BAD_Q_INDEX");
        }
        if (slots.length <= 1) return fail(400, "LAST_QUESTION");

        // The guard that makes an index-keyed tally safe next to a list that
        // can change shape. Deleting question 3 shifts every question after it
        // down one, and their votes do not move with them — so this is refused
        // outright while any of those questions has a vote on it. RESET clears
        // the tallies and keeps the content, which is why the setup page's
        // wording points at it.
        const tallies = await store.getTallies(slots.length);
        const voted = tallies
          .slice(qIndex)
          .some((tally) => OPTION_KEYS.some((option) => (tally?.[option] ?? 0) > 0));
        if (voted) return fail(409, "VOTES_EXIST");

        const all = await store.getContent(slots);
        const keep = all.filter((_, i) => i !== qIndex);
        const slot = slots[qIndex];

        // Roster first: from here on the question is gone from the game, and
        // everything below is tidying up after it.
        await store.putRoster(slots.filter((_, i) => i !== qIndex));
        await store.dropContent(slot);
        await store.dropMeta(slot);
        const swept = await sweepMedia({ images, before: all[qIndex], after: {}, keep });

        // The game cannot be left pointing past the end of the deck.
        if (state.qIndex >= slots.length - 1) {
          await store.putState(
            { ...state, qIndex: Math.max(0, slots.length - 2) },
            state.updatedAt,
            now,
          );
        }
        const after = await buildState({ store, defaults, now, isAdmin: true });
        return json(200, { ...after, ...swept });
      }

      return fail(400, "UNKNOWN_ACTION");
    }

    if (method === "POST" && path === "/admin/upload") {
      const { key, qIndex, kind, option, contentType, data } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");
      if (!images) return fail(503, "UPLOADS_DISABLED");
      const { slots } = await live();
      if (!Number.isInteger(qIndex) || qIndex < 0 || qIndex >= slots.length) {
        return fail(400, "BAD_Q_INDEX");
      }
      // The one caller-controlled string that reaches an S3 object key —
      // everything else in mediaKey is an integer or comes off the KINDS
      // allow-list. Absent means the upload belongs to the question itself.
      //
      // Deliberately not checked against the question's saved option list: the
      // setup page uploads onto an option it has just added, before the save
      // that creates it, so a key that is ahead of the list it belongs to is
      // normal here rather than an error.
      if (option !== undefined && !OPTION_KEYS.includes(option)) return fail(400, "BAD_OPTION_KEY");

      const decoded = decodeUpload({ kind, contentType, data });
      if (decoded.error) return fail(400, decoded.error);

      const url = await images.put({
        key: mediaKey(qIndex, kind, decoded.ext, option),
        contentType,
        bytes: decoded.bytes,
      });
      return json(200, { ok: true, url, bytes: decoded.bytes.length });
    }

    if (method === "POST" && path === "/admin") {
      const { key, action, minutes } = body ?? {};
      if (!adminKey || key !== adminKey) return fail(401, "UNAUTHORIZED");
      if (!ACTIONS.has(action)) return fail(400, "UNKNOWN_ACTION");

      if (action === "RESET") {
        // Not one of the six show buttons — a rehearsal tool. Wipes votes,
        // joins and tallies and puts the game back in LOBBY on Q1.
        //
        // Offline mode is read first and written back, the one piece of state
        // a reset keeps. The setup page's own reset button is labelled "press
        // once before the show": a host who has chosen to run the room
        // without phones and then presses it must not find the QR back on the
        // wall and the phones taking votes. The clocks' lengths are not kept
        // — they go back to their defaults, as they always have.
        const { offline } = await store.getState();
        await store.reset();
        // Stamp a new epoch. Wiping the server is only half the job: every
        // phone still remembers which questions it answered, and without this
        // it would render "already voted" for the rest of the show and never
        // offer the buttons again.
        await store.putState({ ...initialStateFor(now), offline: Boolean(offline) }, 0, now);
        return json(200, await buildState({ store, defaults, now, isAdmin: true }));
      }

      // Reject, don't clamp — same posture as /admin/meta's own duration
      // check. Checked before the state read below so a bad value never
      // reaches the reducer at all.
      // JOIN_SET means the same thing by `minutes` that TIMER_SET does — an
      // absolute length — so it gets the same validator, not JOIN_ADJUST's.
      if ((action === "TIMER_SET" || action === "JOIN_SET") && !isValidMinutes(minutes)) {
        return fail(400, "BAD_DURATION");
      }
      if (action === "JOIN_ADJUST" && !isValidAdjust(minutes)) return fail(400, "BAD_DURATION");

      const { state, questions } = await live();
      const result = reduce(state, action, { questions, now, minutes });
      if (!result.ok) return fail(409, result.code);

      const written = await store.putState(result.state, state.updatedAt, now);
      // Optimistic-concurrency miss: two console clicks raced. The operator's
      // next poll (1s away) shows the truth, so just tell them it bounced.
      if (!written) return fail(409, "CONFLICT");

      return json(200, await buildState({ store, defaults, now, isAdmin: true }));
    }

    return fail(404, "NOT_FOUND");
  };
}

/** Every media url a question holds: its own, and each option's. */
const urlsOf = (question) =>
  [
    question?.image,
    question?.audio,
    question?.video,
    ...(question?.options ?? []).flatMap((option) => OPTION_MEDIA.map((kind) => option[kind])),
  ].filter(Boolean);

/**
 * Delete the media this save orphaned.
 *
 * "Orphaned" is decided against every other question, not just this one.
 * 复制到全部 puts one option list — and so one set of urls — on every question
 * in the deck, and taking the picture off one of them must not blank the other
 * four. The whole content set was already read a few lines above to resolve the
 * saved options, so this check costs nothing.
 *
 * @param {Array} keep  every other question that still holds a live reference
 * @returns {{mediaDeleted: number, mediaFailed: number}}
 */
async function sweepMedia({ images, before, after, keep }) {
  if (!images?.remove || !before) return { mediaDeleted: 0, mediaFailed: 0 };

  const gone = new Set(urlsOf(before));
  for (const url of urlsOf(after)) gone.delete(url);
  for (const question of keep) {
    for (const url of urlsOf(question)) gone.delete(url);
  }

  let mediaDeleted = 0;
  let mediaFailed = 0;
  for (const url of gone) {
    // Never a key from the request — only a url this server stored, resolved
    // back to a key by the adapter that wrote it. Anything else is not ours.
    const key = images.keyOf?.(url);
    if (!key) continue;
    try {
      await images.remove(key);
      mediaDeleted++;
    } catch (err) {
      // Logged and counted, never surfaced as a failure: see the call site.
      // Before the IAM policy is widened this is every delete, and the setup
      // page must go on working exactly as it did.
      mediaFailed++;
      console.warn("media delete failed", { key, name: err?.name, message: err?.message });
    }
  }
  return { mediaDeleted, mediaFailed };
}

const MAX_TEXT = 2000;
const MAX_URL = 500;
// An option can carry its own picture, clip and video — a question whose answers
// are four photographs is the whole point of this. Same three kinds as the
// question itself, so one upload path and one delete sweep serve both levels.
const OPTION_MEDIA = ["image", "audio", "video"];
// One word on a phone button under a countdown. Long enough for a short phrase,
// short enough that six of them still fit on the smallest screen in the room.
const MAX_LABEL = 24;

const text = (value, limit = MAX_TEXT) => (typeof value === "string" ? value.slice(0, limit) : "");

// Two graphemes, so a pasted sentence in the icon box cannot become a second
// label. Counted in graphemes and not code points because 🧑‍🎨 is three code
// points joined by a zero-width joiner, and cutting it at two leaves 🧑 and a
// dangling joiner — a mangled character on every phone in the room.
const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : null;

function icon(value) {
  if (typeof value !== "string") return "";
  if (!graphemes) return [...value].slice(0, 4).join("");

  const out = [];
  for (const { segment } of graphemes.segment(value)) {
    out.push(segment);
    if (out.length === 2) break;
  }
  return out.join("");
}

/**
 * The option list a question offers: the keys the vote endpoint will accept for
 * it, and the words the phones put on the buttons.
 *
 * Rejected rather than quietly repaired. A malformed list would otherwise be
 * saved as a shorter one, and an option silently missing from three hundred
 * phones is the kind of thing nobody notices until the question is live.
 *
 * @returns {{list: Array|undefined} | {error: string}}
 */
function sanitizeOptions(value) {
  // Absent means "not editing the options" — every other content field is
  // written wholesale, but a client that predates options must not wipe them.
  if (value === undefined || value === null) return { list: undefined };
  if (!Array.isArray(value) || value.length < MIN_OPTIONS || value.length > OPTION_KEYS.length) {
    return { error: "BAD_OPTIONS" };
  }

  const seen = new Set();
  const list = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { error: "BAD_OPTIONS" };
    // Keys are assigned by the setup page and kept for the life of the option:
    // they are what the tally counts under, so renumbering them on every edit
    // would move votes between options.
    if (!OPTION_KEYS.includes(raw.key) || seen.has(raw.key)) return { error: "BAD_OPTIONS" };
    seen.add(raw.key);

    const label = text(raw.label, MAX_LABEL).trim();
    if (!label) return { error: "BAD_OPTIONS" };

    const option = { key: raw.key, label, icon: icon(raw.icon) };
    // Media is truncated rather than rejected, unlike the key and the label
    // above. A malformed url costs this option its picture; a malformed label
    // costs the question a button, and only the second is worth refusing the
    // whole save — including the label edit sitting right next to it.
    //
    // Empty fields are dropped rather than stored as "": an option list written
    // before per-option media then round-trips byte-identical, and /content is
    // fetched by three hundred phones that have no use for six options' worth
    // of empty strings.
    for (const kind of OPTION_MEDIA) {
      const url = text(raw[kind], MAX_URL);
      if (url) option[kind] = url;
    }
    list.push(option);
  }
  return { list };
}

// A multiplier on each client surface's own baseline image height cap — the
// server has no opinion on what those baselines are, only that the number it
// stores and serves stays in a sane range. 1 reproduces today's rendering
// exactly, which is what makes a never-resized question safe to leave alone.
const IMAGE_SCALE_MIN = 0.3;
const IMAGE_SCALE_MAX = 2.5;
const IMAGE_SCALE_DEFAULT = 1;

const isValidImageScale = (value) =>
  Number.isFinite(value) && value >= IMAGE_SCALE_MIN && value <= IMAGE_SCALE_MAX;

// Where the body paragraph sits on the projector panel, and how big it is.
//
// Three bounded knobs rather than a free x/y, and the bound is the point: every
// value in these sets lands inside the panel's height budget, so no combination
// the setup page can produce puts a sentence off the wall or under the ballot.
// A drag handle would be more expressive and would also let somebody park the
// question mark behind the video ten minutes before a show.
//
// Each default reproduces today's rendering exactly, which is what makes a
// question saved before this feature safe to leave alone — same posture as
// IMAGE_SCALE_DEFAULT above.
const BODY_PLACES = ["below", "above", "over"];
const BODY_ALIGNS = ["center", "start", "end"];
const BODY_PLACE_DEFAULT = "below";
const BODY_ALIGN_DEFAULT = "center";

const BODY_SIZE_MIN = 0.5;
const BODY_SIZE_MAX = 1.5;
const BODY_SIZE_DEFAULT = 1;

const isValidBodySize = (value) =>
  Number.isFinite(value) && value >= BODY_SIZE_MIN && value <= BODY_SIZE_MAX;

// Unlike the scale endpoint, these three arrive on the same save as the text
// they position, from the same form. So they are coerced rather than rejected:
// an unknown place is not worth refusing a body edit over, and falling back to
// the default renders exactly what a client that had never heard of the field
// would have rendered anyway.
const bodyPlace = (value) => (BODY_PLACES.includes(value) ? value : BODY_PLACE_DEFAULT);
const bodyAlign = (value) => (BODY_ALIGNS.includes(value) ? value : BODY_ALIGN_DEFAULT);
const bodySize = (value) => (isValidBodySize(value) ? value : BODY_SIZE_DEFAULT);

// Whitelist the shape rather than storing whatever the console posted — this
// content is rendered on 300 phones and a projector.
//
// Note what is NOT here: anything the list below does not name. A field a
// client invents — an `answer`, a `correct` flag on an option — is dropped
// rather than stored, because GET /content is unauthenticated and whatever is
// saved here is served to every phone in the room.
//
// The option list IS here, and has to be: a phone cannot draw a button whose
// label it has not been told. What it carries is the words and the keys, and
// no key is marked as the right one — on an opinion poll there is not one.
//
// Neither `options` nor `imageScale` is read from `question` itself — both come
// from the second argument, and see the call sites for why. Each caller knows
// only the one it is changing and passes the other straight off the stored
// record, so a text edit cannot clobber the scale and a drag cannot clobber the
// options. This is also the one place an out-of-range or non-numeric scale gets
// a last-resort fallback to the default, so a bad value can never reach the
// store no matter which caller is careless.
function sanitizeQuestion(question, { options, imageScale } = {}) {
  return {
    ...(options ? { options } : {}),
    // The question's short name. It labels the tab on the setup page and the
    // operator's console while the question is live, and it is what the final
    // recap calls the question on the projector and on every phone — so it is
    // written for the room to read, not as a private note.
    topic: text(question.topic, 100),
    title: text(question.title, 200),
    body: text(question.body),
    image: text(question.image, MAX_URL),
    audio: text(question.audio, MAX_URL),
    video: text(question.video, MAX_URL),
    imageScale: isValidImageScale(imageScale) ? imageScale : IMAGE_SCALE_DEFAULT,
    // Read off `question`, not off the second argument, and that is the whole
    // difference from imageScale: these three are edited on the same form as
    // the body text, in the same save, so a plain replace is correct for them.
    // imageScale is the odd one out because /screen writes it alone.
    bodyPlace: bodyPlace(question.bodyPlace),
    bodyAlign: bodyAlign(question.bodyAlign),
    bodySize: bodySize(question.bodySize),
  };
}

async function buildState({ store, defaults, now, isAdmin }) {
  const state = await store.getState();
  const { questions } = liveList(defaults, state);

  const response = {
    phase: state.phase,
    qIndex: state.qIndex,
    phaseEndsAt: state.phaseEndsAt,
    // The whole segment's clock, operator-driven: idle until TIMER_START,
    // frozen at `gamePausedMs` while paused, counting down to `gameEndsAt`
    // while running. Unauthenticated like every other clock here — the
    // console counts it down from serverNow the same way it counts down
    // phaseEndsAt, and it is not a secret. /screen deliberately does not read
    // any of this: a countdown on the wall turns a settable slot into a
    // deadline in front of the room, and the operator running over is
    // nobody's business but the operator's.
    gameEndsAt: state.gameEndsAt ?? null,
    gamePausedMs: state.gamePausedMs ?? null,
    gameDurationMs: state.gameDurationMs ?? GAME_DURATION_MS,
    // The join clock, and the one clock here that /screen does read. The
    // reasoning that keeps the segment clock off the wall is exactly what puts
    // this one on it: a deadline in front of the room is the point, because the
    // room is the party being asked to hurry up. Unauthenticated for the same
    // reason showRules is — /screen carries no ?k= and is the only surface that
    // renders it, and a join countdown is not a secret.
    joinEndsAt: state.joinEndsAt ?? null,
    joinDurationMs: state.joinDurationMs ?? JOIN_DURATION_MS,
    // Bumped by the REPLAY action; the projector replays audio when it changes.
    replayAt: state.replayAt ?? 0,
    // Toggled by TOGGLE_RULES, LOBBY-only. Unauthenticated on purpose: /screen
    // has no ?k= and is the only thing that renders it. Carries nothing about
    // the vote — it is a bare boolean, same trust level as phase or qIndex.
    showRules: state.showRules ?? false,
    // Offline mode: the room is being run without phones. Unauthenticated,
    // and it has to be — the phones are the ones that must stop offering
    // buttons, and the wall is the one that must take the QR down.
    offline: state.offline ?? false,
    // Identifies this run of the game. Phones drop remembered answers when it
    // changes, which is what makes RESET actually reset the room.
    epoch: state.epoch ?? 0,
    // Bumped by every save on the setup page. Clients refetch /content when it
    // changes, so a projector left open all afternoon picks up an edit made
    // ten minutes before the doors open without anyone touching it.
    contentVersion: state.contentVersion ?? 0,
    serverNow: now,
    joined: state.joined ?? 0,
    questionCount: questions.length,
    tally: null,
    results: null,
    // Who just voted, for the projector's name bubbles: [{ id, name, choice,
    // qIndex, at }], oldest first, current question only, VOTING only. Never
    // carries a voterId.
    recentVotes: [],
  };

  if (state.phase === "VOTING") {
    const feed = await store.getRecentVotes();
    response.recentVotes = feed.filter((entry) => entry.qIndex === state.qIndex);
  }

  // Counts are public from the moment voting opens. This is the line that
  // decides who sees them, and when.
  //
  // The poll is shown in real time: the projector carries no key, and it draws
  // each option's share live while the countdown runs. So an unauthenticated
  // /state has to carry the tally through VOTING and LOCKED as well as REVEAL —
  // refusing it over HTTP would hide nothing from a room that is looking at it,
  // and there is no answer behind the counts for the refusal to protect.
  //
  // Phones deliberately do not render this while a question is open: a number
  // on a button under a countdown is one more thing to read in the seconds a
  // person has to make up their mind, and the room watching itself is what the
  // projector is for. They draw it at REVEAL.
  //
  // What `?k=` still adds is the lobby: the operator sees a tally — all zeros —
  // before the first question opens, and the room does not.
  //
  // Counts only, here and in `results`. Percentages are the clients' to work
  // out, and they all do it with the same function so that the phone and the
  // wall cannot disagree by a rounding.
  if (state.phase === "FINAL") {
    const tallies = await store.getTallies(questions.length);
    // The whole tally is spread in, one count per key in the space, so a
    // question with four options reports all four without this line having to
    // know how many it had.
    response.results = tallies.map((t, i) => ({ qIndex: i, ...t }));
  } else if (tallyVisible(state.phase) || isAdmin) {
    // The store folds the tally into the batched state read it was already
    // making; the explicit read is the fallback for the one poll after a
    // question changes, when that speculative key was for the previous index.
    response.tally = state.tally ?? (await store.getTally(state.qIndex));
  }

  if (isAdmin) {
    response.admin = {
      canUndo: (state.history ?? []).length > 0,
      updatedAt: state.updatedAt,
      // The setup page needs these to render the countdown picker, and the
      // operator console keys off the block's presence to know its key was
      // accepted. Authenticated by ?k=, and deliberately absent from every
      // unauthenticated response.
      questions: questions.map((q) => ({
        id: q.id,
        duration: q.duration,
        overridden: Boolean(state.meta?.[q.slot]),
      })),
    };
  }

  return response;
}
