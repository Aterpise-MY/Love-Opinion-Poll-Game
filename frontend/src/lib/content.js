import { useEffect, useState } from "react";

import bundled from "../content/questions.json";
import { getContent } from "./api.js";
import { DEFAULT_OPTIONS, optionsOf } from "./choices.js";

/**
 * Questions come from two places: the bundle (instant, offline, the Day 0
 * source of truth) and the server (whatever was uploaded from the console).
 * The server wins field by field, so uploading one picture does not wipe the
 * text sitting next to it.
 */
export function applyOverride(question, override) {
  if (!override) return question;
  return {
    ...question,
    topic: override.topic || question.topic,
    title: override.title || question.title,
    body: override.body || question.body,
    image: override.image || question.image,
    audio: override.audio || question.audio,
    video: override.video || question.video,
    // Field-by-field like the rest, so a question whose options have never been
    // edited keeps the pair the bundle shipped with.
    options: override.options?.length ? override.options : question.options,
    // The three body-layout fields, merged the same way. The bundle has never
    // carried them, so in practice the override always wins — but going through
    // the same `||` keeps one rule for the whole record instead of two.
    bodyPlace: override.bodyPlace || question.bodyPlace,
    bodyAlign: override.bodyAlign || question.bodyAlign,
    bodySize: override.bodySize || question.bodySize,
  };
}

// Where the body paragraph sits on the projector panel. The server whitelists
// these same three sets — see sanitizeQuestion in backend/router.js. This is
// the client's own fallback, for the bundle (which has never carried the
// fields) and for any question saved before the feature shipped.
export const BODY_PLACES = ["below", "above", "over"];
export const BODY_ALIGNS = ["center", "start", "end"];
export const BODY_SIZE_MIN = 0.5;
export const BODY_SIZE_MAX = 1.5;

export const DEFAULT_BODY_LAYOUT = { place: "below", align: "center", size: 1 };

/**
 * One question's body layout, defaulted and range-checked.
 *
 * Every caller goes through this rather than reading the three fields directly,
 * so the projector and the setup page's preview cannot disagree about what an
 * absent or out-of-range value means. A preview that disagrees with the wall is
 * worse than no preview, because it is believed.
 */
export function bodyLayoutOf(question) {
  const size = Number(question?.bodySize);
  return {
    place: BODY_PLACES.includes(question?.bodyPlace)
      ? question.bodyPlace
      : DEFAULT_BODY_LAYOUT.place,
    align: BODY_ALIGNS.includes(question?.bodyAlign)
      ? question.bodyAlign
      : DEFAULT_BODY_LAYOUT.align,
    size:
      Number.isFinite(size) && size >= BODY_SIZE_MIN && size <= BODY_SIZE_MAX
        ? size
        : DEFAULT_BODY_LAYOUT.size,
  };
}

// The bundle by id rather than by position. After a question in the middle has
// been deleted, position 2 on the server is a different question from position
// 2 in the bundle, and merging those would put question 4's placeholder text
// under question 3's heading on the projector.
const BUNDLED_BY_ID = new Map(bundled.map((question) => [question.id, question]));

const blankQuestion = (id) => ({
  id,
  topic: "",
  title: "",
  body: "",
  image: "",
  audio: "",
  video: "",
  options: DEFAULT_OPTIONS,
});

/**
 * The server owns how many questions there are and what order they are in — the
 * setup page can add and delete them during the event. The bundle is still the
 * field-by-field fallback for the questions it knows, which is what keeps a
 * question nobody has edited showing its authored text.
 */
export function mergeContent(overrides) {
  if (!Array.isArray(overrides)) return bundled;
  return overrides.map((override) =>
    applyOverride(BUNDLED_BY_ID.get(override?.id) ?? blankQuestion(override?.id), override),
  );
}

// The marker the authored source uses for questions that are still stubs.
// If the real content only ever landed on the server and this fetch fails,
// the projector would quietly show these to the room.
export const PLACEHOLDER = "【占位】";

export function hasPlaceholder(questions) {
  return questions.some(
    (q) =>
      [q.body, q.title].some((text) => text?.includes(PLACEHOLDER)) ||
      // A question added during setup and then never written. Blank on the
      // projector is as bad as 【占位】 on it, and easier to forget about.
      ![q.title, q.body, q.image, q.audio, q.video].some(Boolean),
  );
}

export function preloadImages(questions) {
  for (const question of questions) {
    if (question.image) new Image().src = question.image;
    // Option pictures too. A phone whose buttons are pictures cannot be voted on
    // until they have arrived, and the lobby is the only unhurried minute the
    // room has — waiting until the question opens spends the countdown on a
    // download. Only images: option audio and video never play on a phone.
    for (const option of optionsOf(question)) {
      if (option.image) new Image().src = option.image;
    }
  }
}

/**
 * Fetched at page load and again whenever the server says the content changed.
 * Pictures are preloaded during the lobby so a question opening does not stall
 * on a download.
 *
 * `contentVersion` comes from /state, which every page already polls. Passing
 * it here is what closes the gap that used to exist between /admin and the
 * room: content saved on the setup page reached only clients that loaded
 * afterwards, so a projector opened before the edit showed the old text — or
 * the 【占位】 placeholder — for the whole show unless somebody thought to
 * reload it. Nothing new is polled; this rides the /state poll that was
 * already running.
 */
const RETRY_DELAYS_MS = [500, 1500];

export function useQuestions(contentVersion) {
  const [questions, setQuestions] = useState(bundled);
  const [contentFailed, setContentFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // This one request lands in the busiest 20 seconds of the whole event, so
    // retry it. Falling back to the bundle is only harmless when the bundle
    // holds the real content — see hasPlaceholder.
    (async () => {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          const res = await getContent();
          if (!cancelled) {
            setQuestions(mergeContent(res.questions));
            setContentFailed(false);
          }
          return;
        } catch {
          if (cancelled) return;
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay === undefined) break;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (!cancelled) setContentFailed(true);
    })();

    return () => {
      cancelled = true;
    };
    // Re-runs on every change of the server's content version, including the
    // first poll's undefined -> 0. That extra fetch is one request per client
    // at page load, and it is what makes a client that opened during a save
    // certain to end up with the saved text.
  }, [contentVersion]);

  useEffect(() => preloadImages(questions), [questions]);

  return [questions, setQuestions, contentFailed];
}
