// Which votes the projector has not yet announced, and how many bubbles may be
// on the wall at once. Like choices.js and name.js this imports nothing from
// the browser, so the rules run under plain node --test.
//
// /state carries the last few accepted votes as `recentVotes`, oldest first,
// each with an id that rises by one per vote and never goes back (a RESET does
// not rewind it). A screen polls, so one response can hold several votes it has
// not seen, and every response repeats the ones it has. The id is what tells
// them apart: a bubble for every entry above the last id this screen has seen.

/** At most this many bubbles at once; a newer one pushes the oldest off. */
export const MAX_ON_SCREEN = 6;
/** How long a bubble is up. The fade is the last part of it (see styles.css). */
export const SHOW_MS = 3500;
/** Gap between two bubbles arriving in the same poll. */
export const STAGGER_MS = 250;
/**
 * Waiting to be shown, per poll. A burst larger than this is a crowd, not a
 * list: the oldest of it is dropped rather than read out for half a minute
 * after the votes were cast.
 */
export const MAX_QUEUE = 12;
/** Said for a vote that came without a name. */
export const ANONYMOUS = "有人";

const isEntry = (entry) =>
  Boolean(entry) && Number.isInteger(entry.id) && typeof entry.choice === "string";

/**
 * Which entries are new, given the highest id this screen has seen.
 *
 * `lastId` is null until the first state arrives. That first state only seeds
 * it: a screen opened, or reloaded, in the middle of a question does not replay
 * the votes already cast. After that, entries above `lastId` are fresh, oldest
 * first and at most MAX_QUEUE of them (the newest are kept).
 *
 * Outside VOTING nothing is fresh and `lastId` stays where it was; the server
 * sends no entries then anyway, and the ids carry on across questions.
 *
 * @param {number|null} lastId
 * @param {{phase?: string, recentVotes?: unknown}|null|undefined} state
 * @returns {{lastId: number, fresh: object[]}}
 */
export function advance(lastId, state) {
  const entries = Array.isArray(state?.recentVotes) ? state.recentVotes.filter(isEntry) : [];
  const newest = entries.reduce((top, entry) => Math.max(top, entry.id), -1);

  if (lastId === null) return { lastId: newest, fresh: [] };
  if (state?.phase !== "VOTING") return { lastId, fresh: [] };

  // Ids only go up, so a list whose newest id is below the last one seen can
  // only come from a server that started counting again (a restart). Those
  // entries are new; counting from the bottom shows them.
  const floor = entries.length > 0 && newest < lastId ? -1 : lastId;

  const seen = new Set();
  const fresh = entries
    .filter((entry) => {
      if (entry.id <= floor || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_QUEUE);

  return { lastId: entries.length > 0 ? Math.max(floor, newest) : lastId, fresh };
}

/** Put a bubble on the wall, dropping the oldest if the wall is full. */
export function show(visible, bubble, cap = MAX_ON_SCREEN) {
  return [...visible, bubble].slice(-cap);
}

/** The bubbles that have not yet run their time. */
export const unexpired = (visible, now, lifeMs = SHOW_MS) =>
  visible.filter((bubble) => now - bubble.shownAt < lifeMs);

/**
 * What one bubble says: "<name> 选了「<option>」", in the option's colour.
 * `options` is the question's option list; a key it no longer holds (the
 * option was deleted after the vote) is said plainly rather than left blank.
 */
export function describe(entry, options) {
  const who = typeof entry.name === "string" && entry.name !== "" ? entry.name : ANONYMOUS;
  const label = options.find((option) => option.key === entry.choice)?.label ?? "已删除的选项";
  return { id: entry.id, key: entry.choice, who, label };
}
