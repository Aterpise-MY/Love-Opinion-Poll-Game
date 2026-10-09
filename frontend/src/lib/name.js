// What a name has to be, and when the phone still lets one be changed. Like
// choices.js this imports nothing and touches no browser API, so it runs under
// plain node --test — which is the only place these rules are pinned, because
// nothing on the server knows about names yet.

// Long enough for a full name or a nickname with a flourish, short enough to
// sit in the lobby's speech bubble on the narrowest phone in the room.
export const NAME_MAX = 20;

/**
 * Length the way a person counts it: one for a Chinese character, and one for
 * an emoji that takes two UTF-16 units, where `.length` would say two.
 *
 * Code points, not graphemes. Counting what the eye sees as one — a flag, a
 * family, a skin tone — needs Intl.Segmenter, which the older WebView cores in
 * the room do not have. So a flag counts as two and a family as five or more.
 * Nothing is ever cut to this length, only refused past it, so the difference
 * can cost somebody an emoji but can never leave half of one behind.
 */
export const countCodePoints = (text) => Array.from(text).length;

// Every character that ends a line: LF, VT, FF, CR, NEL, and the Unicode line
// and paragraph separators. By number, because not one of them can be seen in
// an editor. A single-line field cannot produce any of them, so this is for a
// value that arrived some other way.
const LINE_BREAKS = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].map((code) =>
  String.fromCharCode(code),
);
const hasLineBreak = (text) => LINE_BREAKS.some((character) => text.includes(character));

/**
 * Check a name as typed.
 *
 * The order is the order of the messages somebody should see: a field of
 * spaces is empty, not too long. What comes back on success is the trimmed
 * text and otherwise exactly what was typed — spaces inside it are part of a
 * name like "Li Lei".
 *
 * Refused, never repaired: a name quietly shortened is a name its owner did
 * not choose.
 *
 * @returns {{ok: true, name: string} | {ok: false, code: "EMPTY" | "LINE_BREAK" | "TOO_LONG"}}
 */
export function checkName(raw) {
  if (typeof raw !== "string") return { ok: false, code: "EMPTY" };

  // trim() takes the full-width space a Chinese keyboard types as well.
  const name = raw.trim();
  if (!name) return { ok: false, code: "EMPTY" };
  if (hasLineBreak(name)) return { ok: false, code: "LINE_BREAK" };
  if (countCodePoints(name) > NAME_MAX) return { ok: false, code: "TOO_LONG" };
  return { ok: true, name };
}

/**
 * Can the name still be changed? Only in the first lobby.
 *
 * The phase alone does not say that: the room is back in LOBBY before every
 * question. It is the lobby of question one, so skipping that question fixes
 * the name and undoing the skip frees it again — this reads the state it is
 * given and remembers nothing.
 */
export const canEditName = (state) => state?.phase === "LOBBY" && state.qIndex === 0;
