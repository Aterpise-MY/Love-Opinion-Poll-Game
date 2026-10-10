// In-process storage for local development and rehearsal. Same interface as
// store-dynamo.js. State lives only as long as the process does.

import { OPTION_KEYS, RECENT_VOTES_LIMIT, initialState } from "./game.js";
import { pickShard, shardSk, tallySks } from "./tally.js";

/**
 * @param {object} [options]
 * @param {number} [options.epoch]  the run this process starts in. server.js
 *   passes its boot time, so a restart is a new round to every phone; the
 *   default of 0 is "never reset", which is what the tests construct.
 */
export function createMemoryStore({ epoch = 0 } = {}) {
  let state = initialState(epoch);
  let joined = 0;
  // Keyed by the same storage keys the Dynamo adapter uses — `tally#<q>` and
  // `tally#<q>#<shard>` — rather than by qIndex, so this store models the same
  // two shapes and the tests that cover the rollout mean something here too.
  const tallies = new Map();
  const voters = new Set(); // `${qIndex}#${voterId}`
  const joiners = new Set();
  // The recent-votes feed: newest last, capped. `feedSeq` is deliberately not
  // cleared by reset() so ids stay increasing across a RESET; a projector that
  // remembers "last seen id 40" must not see id 1 and think it is old news.
  let feed = [];
  let feedSeq = 0;
  const content = new Map(); // slot id -> authored question content
  let meta = {}; // slot id -> { duration } override set from the setup page
  // The live question list, as an ordered array of slot ids — null until the
  // operator first adds or deletes one, which is what deck.json means.
  let roster = null;
  // Bumped on every content write. Rides along on getState so a projector that
  // is already open can notice an edit without polling /content every second.
  // A counter, not a clock — clients only compare it for inequality.
  let contentVersion = 0;

  const counterAt = (sk) => {
    if (!tallies.has(sk)) {
      tallies.set(sk, Object.fromEntries(OPTION_KEYS.map((key) => [key, 0])));
    }
    return tallies.get(sk);
  };

  // Every key in the space is present and zeroed, whether or not the question
  // offers it, so a tally always has the same shape and no reader has to
  // distinguish "nobody picked it" from "not on the ballot".
  //
  // Summed across the unsharded counter and every shard, exactly as the Dynamo
  // adapter does: that union is what makes a mixed-version deployment read
  // correctly whichever shape each task happens to be writing.
  const tallyFor = (qIndex) => {
    const total = Object.fromEntries(OPTION_KEYS.map((key) => [key, 0]));
    for (const sk of tallySks(qIndex)) {
      const counter = tallies.get(sk);
      if (!counter) continue;
      for (const key of OPTION_KEYS) total[key] += counter[key];
    }
    return total;
  };

  return {
    async getState() {
      // The tally rides along here for the same reason it does in the Dynamo
      // adapter: /state carries it from the moment voting opens, and it should
      // not cost a second round trip there or a second lookup here.
      return {
        ...state,
        joined,
        meta,
        contentVersion,
        roster,
        tally: { ...tallyFor(state.qIndex) },
      };
    },

    async putRoster(slots) {
      roster = [...slots];
      // Same stamp the content writes bump: adding or deleting a question
      // changes what /content answers, so every open client has to refetch.
      contentVersion += 1;
    },

    async putMeta(slot, patch) {
      const next = { ...(meta[slot] ?? {}), ...patch };
      meta = { ...meta, [slot]: next };
      return next;
    },

    async dropMeta(slot) {
      const next = { ...meta };
      delete next[slot];
      meta = next;
    },

    async putState(next, expectedUpdatedAt, now) {
      if (state.updatedAt !== expectedUpdatedAt) return false;
      state = { ...next, updatedAt: now };
      return true;
    },

    async getTally(qIndex) {
      return { ...tallyFor(qIndex) };
    },

    async getTallies(count) {
      return Array.from({ length: count }, (_, i) => ({ ...tallyFor(i) }));
    },

    async recordVote({ qIndex, voterId, choice }) {
      const key = `${qIndex}#${voterId}`;
      if (voters.has(key)) return false;
      voters.add(key);
      counterAt(shardSk(qIndex, pickShard()))[choice] += 1;
      return true;
    },

    async appendRecentVote({ name = null, choice, qIndex, now = Date.now() }) {
      feedSeq += 1;
      feed.push({ id: feedSeq, name, choice, qIndex, at: now });
      if (feed.length > RECENT_VOTES_LIMIT) feed = feed.slice(-RECENT_VOTES_LIMIT);
    },

    async getRecentVotes() {
      return feed.map((entry) => ({ ...entry }));
    },

    async recordJoin(voterId) {
      if (joiners.has(voterId)) return false;
      joiners.add(voterId);
      joined += 1;
      return true;
    },

    // Keyed by slot rather than position, so deleting a question in the middle
    // is a splice of the roster and not a rewrite of every record behind it.
    async getContent(slots) {
      return slots.map((slot) => content.get(slot) ?? null);
    },

    async putContent(slot, question) {
      content.set(slot, question);
      contentVersion += 1;
    },

    async dropContent(slot) {
      content.delete(slot);
      contentVersion += 1;
    },

    // Deliberately leaves authored content, countdown overrides and the roster
    // alone — RESET clears the votes, not the questions you spent Day 0 writing
    // or the sixth one you added an hour before the doors opened.
    async reset() {
      state = initialState();
      joined = 0;
      tallies.clear();
      voters.clear();
      joiners.clear();
      feed = [];
    },
  };
}
