// The server only knows opaque choice keys — "a" through "f" — and that is what
// the state machine, the tally, the dedup records and the transactions are built
// on. None of it knows what a key means.
//
// A question carries its own option list in its content: {key, label, icon} in
// the order they appear on the phone. The list is public — a phone cannot draw a
// button whose label it has not been told — and there is nothing more to it
// than that. This is an opinion poll: no key is the correct one, so nothing
// about the options is held back from the room.

export const OPTION_KEYS = ["a", "b", "c", "d", "e", "f"];
// Two is what a poll needs to be a poll. Six is where a phone screen runs out.
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = OPTION_KEYS.length;

// What the game ships as, and what a question that has never been edited still
// offers. A word each: these are read under a countdown, on a phone, by someone
// who is also reading the scenario being judged.
// The icons are a heart and a cross, and neither is an emoji: the design
// language this app wears has none, so both are plain text glyphs — U+2665 and
// U+2715 — drawn from a font the app ships (see "Poll Glyphs" in fonts.css)
// rather than from whatever colour emoji a handset would substitute. A heart
// and a cross, deliberately not a tick and a cross: that pair is how answers
// get marked, and on a poll with no right answer it would tell the room which
// side is correct before anybody has voted. One bare code point each, with no
// variation selector for a renderer to disagree about.
// Kept in step with DEFAULT_OPTIONS in scripts/build-content.mjs, and written
// out in the same shape optionsOf returns, media fields and all, so nothing
// downstream has to care whether a list came from here or the server.
export const DEFAULT_OPTIONS = [
  { key: OPTION_KEYS[0], icon: "♥", label: "可以", image: "", audio: "", video: "" },
  { key: OPTION_KEYS[1], icon: "✕", label: "不可以", image: "", audio: "", video: "" },
];

// An option can carry its own picture, clip and video. Three kinds, named once.
export const OPTION_MEDIA = ["image", "audio", "video"];

/** Does any option on this question carry media of this kind? */
export const someOptionHas = (options, kind) => options.some((option) => Boolean(option[kind]));

/**
 * The options a question offers, always a usable list.
 *
 * Falling back to the default pair matters more than it looks: this runs on
 * three hundred phones against whatever /content returned, and a question with
 * no readable option list would otherwise render as a page with no buttons on
 * it — indistinguishable, from the audience's side, from the app being broken.
 */
export function optionsOf(question) {
  const raw = question?.options;
  if (!Array.isArray(raw)) return DEFAULT_OPTIONS;

  const seen = new Set();
  const options = [];
  for (const option of raw) {
    if (!option || !OPTION_KEYS.includes(option.key) || seen.has(option.key)) continue;
    seen.add(option.key);
    // Every field, in a fixed order, always — including "" for media this option
    // does not have. The setup page decides whether an edit needs saving by
    // comparing JSON.stringify of the option list against what is stored, and
    // key order is part of that string: if `image` appeared only once a picture
    // had been uploaded, the comparison would flip between two orderings of the
    // same list and save on every blur.
    options.push({
      key: option.key,
      label: option.label ?? "",
      icon: option.icon ?? "",
      image: option.image ?? "",
      audio: option.audio ?? "",
      video: option.video ?? "",
    });
    if (options.length === MAX_OPTIONS) break;
  }
  return options.length >= MIN_OPTIONS ? options : DEFAULT_OPTIONS;
}

export const findOption = (options, key) => options.find((option) => option.key === key) ?? null;

/** The lowest unused key, or null when the question is already full. */
export const nextOptionKey = (options) =>
  OPTION_KEYS.find((key) => !options.some((option) => option.key === key)) ?? null;

/**
 * Total votes on a question. Summed over the whole key space rather than the
 * question's current options, so a rehearsal vote for an option that was later
 * deleted still counts in the denominator instead of vanishing from it.
 */
export const totalVotes = (tally) => OPTION_KEYS.reduce((sum, key) => sum + (tally?.[key] ?? 0), 0);

/**
 * How the room split, as whole-number percentages that add up to exactly 100 —
 * or null when nobody voted, because a share of nothing is not a number.
 *
 * One function, and every surface that prints a percentage calls it: the phone,
 * the wall, the operator console and both recaps. Rounding each share on its
 * own is how forty people splitting 15 to 25 becomes 38% against 63% and a wall
 * that adds up to 101 — and how a phone ends up telling its owner a number one
 * off from the one three metres tall behind them.
 *
 * Largest remainder: every share is rounded down, and the points that leaves
 * over go one each to the shares that lost the most by it. A tie goes to the
 * earlier key, so the result is the same on every device rather than whatever
 * order a sort happened to settle in. The arithmetic is done in whole numbers
 * for the same reason — 29 votes in 100 must be 29, not the 28.999999999999996
 * that dividing first and flooring second would make of it.
 *
 * Over the whole key space, like totalVotes: a vote for an option that was
 * later deleted still holds its share, so the options a question has left can
 * add up to less than 100. That is the truth about the room, not a rounding
 * error to be spread around.
 */
export function sharesOf(tally) {
  const total = totalVotes(tally);
  if (total === 0) return null;

  const scaled = OPTION_KEYS.map((key) => (tally?.[key] ?? 0) * 100);
  const shares = scaled.map((votes) => Math.floor(votes / total));
  const remainders = scaled.map((votes) => votes % total);
  const spare = 100 - shares.reduce((sum, share) => sum + share, 0);

  const byRemainder = OPTION_KEYS.map((_, i) => i).sort(
    (x, y) => remainders[y] - remainders[x] || x - y,
  );
  for (const i of byRemainder.slice(0, spare)) shares[i] += 1;

  return Object.fromEntries(OPTION_KEYS.map((key, i) => [key, shares[i]]));
}
