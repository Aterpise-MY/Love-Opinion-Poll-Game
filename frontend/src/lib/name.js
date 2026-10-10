// What a name has to be, and when the phone offers to change one. Like
// choices.js this imports nothing and touches no browser API, so it runs under
// plain node --test.

// Long enough for a nickname, short enough for the bubble on the projector and
// for the lobby's on the narrowest phone in the room. The server cuts a name
// to the same 12 code points (sanitizeName in backend/game.js); this refuses
// past it instead, so nobody's name is shortened behind their back.
export const NAME_MAX = 12;

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
 * Is the rename button on offer in this state?
 *
 * Any time, with one exception: while a question is open and this phone has not
 * answered it. The form takes over the whole screen, and an unanswered
 * question covered by it is a vote lost to a keyboard. Once the player has
 * voted (or the time has run out) the form is safe, and the name typed there is
 * the one the next vote carries. The reveal and the recap are full-bleed and
 * have no room for the button.
 *
 * @param {{phase?: string}|null|undefined} state
 * @param {boolean} [answering] a question is open and this phone can still answer it
 */
export function canEditName(state, answering = false) {
  switch (state?.phase) {
    case "LOBBY":
    case "LOCKED":
      return true;
    case "VOTING":
      return !answering;
    default:
      return false;
  }
}

/**
 * The part of a vote's body that carries the name: `{name}` for a usable one
 * and nothing at all otherwise, so a phone without a name sends the vote as it
 * always did. The server sanitises whatever arrives; this only keeps empty and
 * non-text values off the wire.
 */
export const nameField = (name) => (typeof name === "string" && name !== "" ? { name } : {});
