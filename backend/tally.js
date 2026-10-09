// Where a question's votes are counted.
//
// Every vote is one TransactWriteItems that ADDs to the question's counter, and
// three hundred phones vote inside the two seconds after the operator presses
// START. Against one item that is one hot key taking the entire burst: a
// 300-player run on the deployed stack produced 537 TransactionConflict retries
// on that line alone. Nothing was lost — sendWithConflictRetry absorbs them —
// but every retry is latency arriving at the exact moment the room is watching
// the screen fill in.
//
// So a vote lands on one of SHARDS counters chosen at random, and a read sums
// them. The contention divides by SHARDS; the read cost multiplies by it.
//
// That trade is the whole design decision, and it is worth stating plainly
// because this app is read-heavy: three hundred phones poll /state twice a
// second all show long, and each poll now carries the shard set. Writes are
// three hundred per question. So this optimises the rare operation at the
// expense of the constant one — worth it because the write burst is
// synchronised and therefore self-amplifying, while the reads are spread,
// cheap (sub-1KB, eventually consistent) and already batched into a request
// that was being made anyway.
//
// Ten is not tuned to anything measured. It is the smallest number that takes
// a 300-vote burst below the level where conflicts were observed at all, and
// small enough that the shard set still rides one BatchGetItem alongside the
// state read.
export const SHARDS = 10;

/**
 * Every counter that holds votes for one question, in read order.
 *
 * The unsharded key comes first and is never dropped. It is what tasks older
 * than this rollout wrote, and reading it forever is what makes a rolling
 * deployment safe: during the changeover some tasks write there and some write
 * shards, and a reader that sums both sees every vote either way. See the
 * two-phase note in README before changing this.
 */
export const tallySks = (qIndex) => [
  `tally#${qIndex}`,
  ...Array.from({ length: SHARDS }, (_, shard) => `tally#${qIndex}#${shard}`),
];

/** The shard one vote goes to. Random rather than hashed on the voter: a hash
 *  would put every vote from one phone on one shard, which is a distribution
 *  nobody needs, and random is uniform without holding any state. */
export const pickShard = () => Math.floor(Math.random() * SHARDS);

export const shardSk = (qIndex, shard) => `tally#${qIndex}#${shard}`;
