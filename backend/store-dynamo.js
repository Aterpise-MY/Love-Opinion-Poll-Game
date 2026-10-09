// DynamoDB storage adapter. Single table, single partition (`game#N`).
//
// Uses the bare @aws-sdk/client-dynamodb client — which the nodejs20.x runtime
// ships — so the deployment package has zero dependencies and zero build step.
// Attribute values are hand-marshalled; there are only a handful of them.

import {
  DynamoDBClient,
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DeleteItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import { GAME_DURATION_MS, JOIN_DURATION_MS, OPTION_KEYS, initialState } from "./game.js";
import { pickShard, shardSk, tallySks } from "./tally.js";

const TTL_DAYS = 7;
// DynamoDB's own ceiling on one BatchGetItem.
const BATCH_GET_LIMIT = 100;

export function createDynamoStore({ tableName, gameId = "game#1", region, client } = {}) {
  // Region must be explicit. Lambda injected AWS_REGION automatically; Fargate
  // does not, and there is no IMDS region fallback in a task — the SDK simply
  // throws "Region is missing" on the first call.
  const ddb = client ?? new DynamoDBClient(region ? { region } : {});
  const PK = { S: gameId };
  const key = (sk) => ({ PK, SK: { S: sk } });
  const ttlAt = (now) => String(Math.floor(now / 1000) + TTL_DAYS * 86400);

  async function batchGet(sks) {
    const found = new Map();

    // BatchGetItem takes at most 100 keys per request, and a tally is no longer
    // one key per question — FINAL asks for every shard of every question,
    // which is well past that ceiling. Chunked here rather than at each call
    // site, because every caller has the same limit.
    for (let start = 0; start < sks.length; start += BATCH_GET_LIMIT) {
      let keys = sks.slice(start, start + BATCH_GET_LIMIT).map((sk) => key(sk));

      // BatchGetItem may return UnprocessedKeys under throttling. With a handful
      // of sub-1KB items this effectively never fires, but retrying is cheap.
      for (let attempt = 0; attempt < 3 && keys.length > 0; attempt++) {
        const res = await ddb.send(
          new BatchGetItemCommand({ RequestItems: { [tableName]: { Keys: keys } } }),
        );
        for (const item of res.Responses?.[tableName] ?? []) found.set(item.SK.S, item);
        keys = res.UnprocessedKeys?.[tableName]?.Keys ?? [];
      }
    }
    return found;
  }

  const writeJson = (sk, value) =>
    ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key(sk),
        UpdateExpression: "SET #json = :json",
        ExpressionAttributeNames: { "#json": "json" },
        ExpressionAttributeValues: { ":json": { S: JSON.stringify(value) } },
      }),
    );

  const bumpContentVersion = () =>
    ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key("content-version"),
        UpdateExpression: "ADD #v :one",
        ExpressionAttributeNames: { "#v": "v" },
        ExpressionAttributeValues: { ":one": { N: "1" } },
      }),
    );

  // Which tally getState speculatively batches with the state item.
  //
  // /state is polled once a second by every phone in the room, and the tally is
  // part of the answer from the moment voting opens. As a second GetItem that
  // is +300 reads/s aimed at `tally#<q>` — the hottest item in the table, and
  // the one every vote is already ADDing to. As one more key on the
  // BatchGetItem this process is making anyway it is free.
  //
  // The catch is that the key depends on qIndex, which is inside the item being
  // read. So it is read from the qIndex this process last saw and thrown away
  // when the state that comes back disagrees — which is the one poll after each
  // question change, and this process learns the new index from that very
  // response. Every task is polled many times a second, so the hint is warm
  // again within milliseconds.
  let tallyHint = 0;

  // One attribute per option key on each counter, written by the ADD in
  // recordVote. Absent means nobody has voted for it yet — including for
  // options the question does not offer, which simply stay at zero forever.
  //
  // Summed across the question's counters: the unsharded key plus every shard.
  // A missing item contributes nothing, so a question whose votes are all on
  // the old key and one whose votes are spread across shards both read
  // correctly, which is what makes the rollout safe.
  function sumTally(items, qIndex) {
    const total = Object.fromEntries(OPTION_KEYS.map((key) => [key, 0]));
    for (const sk of tallySks(qIndex)) {
      const item = items.get(sk);
      if (!item) continue;
      for (const key of OPTION_KEYS) total[key] += Number(item[key]?.N ?? 0);
    }
    return total;
  }

  return {
    async getState() {
      // `meta`, `content-version` and `roster` ride along on the existing round
      // trip, so answer overrides, the content stamp and the live question list
      // all cost nothing on the hot path — /state is polled by every phone in
      // the room once a second, and this is still one batched read.
      // The tally rides this read too, speculatively. See tallyHint above.
      const at = tallyHint;
      const items = await batchGet([
        "state",
        "joined",
        "meta",
        "content-version",
        "roster",
        ...tallySks(at),
      ]);
      const item = items.get("state");
      const joined = Number(items.get("joined")?.count?.N ?? 0);
      const meta = parseJson(items.get("meta")?.json?.S) ?? {};
      const contentVersion = Number(items.get("content-version")?.v?.N ?? 0);
      const roster = parseJson(items.get("roster")?.json?.S);
      // undefined on a miss, never a zeroed tally: readTally(undefined) is
      // all-zeros, and "0%" on the wall for a second at the top of every
      // question is precisely the flicker useRampUp exists to avoid. The router
      // reads the tally itself on that one poll.
      const tallyAt = (qIndex) => (qIndex === at ? sumTally(items, at) : undefined);
      if (!item) {
        return {
          ...initialState(),
          joined,
          meta,
          contentVersion,
          roster,
          tally: tallyAt(0),
        };
      }

      const qIndex = Number(item.qIndex.N);
      tallyHint = qIndex;
      return {
        phase: item.phase.S,
        qIndex,
        phaseEndsAt: item.phaseEndsAt?.N ? Number(item.phaseEndsAt.N) : null,
        gameEndsAt: item.gameEndsAt?.N ? Number(item.gameEndsAt.N) : null,
        gamePausedMs: item.gamePausedMs?.N ? Number(item.gamePausedMs.N) : null,
        // Absent on an item written before this change landed — the rolling
        // deploy carries a two-image window where the old code never wrote
        // this attribute at all. Defaulting it here, the same way `?? 45` on
        // a question's own duration already does, is what makes that item
        // read back as an idle clock at the default length instead of a
        // string of nulls the console has no default for.
        gameDurationMs: item.gameDurationMs?.N ? Number(item.gameDurationMs.N) : GAME_DURATION_MS,
        // Same mixed-window story as the two attributes above: absent on an
        // item the old image wrote, so it reads back as a stopped join clock at
        // the default length rather than as a null /screen would have to guess at.
        joinEndsAt: item.joinEndsAt?.N ? Number(item.joinEndsAt.N) : null,
        joinDurationMs: item.joinDurationMs?.N ? Number(item.joinDurationMs.N) : JOIN_DURATION_MS,
        replayAt: Number(item.replayAt?.N ?? 0),
        epoch: Number(item.epoch?.N ?? 0),
        updatedAt: Number(item.updatedAt?.N ?? 0),
        history: (item.history?.L ?? []).map((entry) => entry.S),
        showRules: Boolean(item.showRules?.BOOL),
        joined,
        meta,
        contentVersion,
        roster,
        tally: tallyAt(qIndex),
      };
    },

    async putState(next, expectedUpdatedAt, now) {
      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: key("state"),
            UpdateExpression:
              "SET #ph = :ph, #qi = :qi, #pe = :pe, #ge = :ge, #gp = :gp, #gd = :gd, #je = :je, #jd = :jd, #ra = :ra, #ep = :ep, #hi = :hi, #ua = :ua, #ttl = :ttl, #sr = :sr",
            // Optimistic lock: a second click that read the same prior state loses.
            ConditionExpression: "attribute_not_exists(SK) OR #ua = :prev",
            ExpressionAttributeNames: {
              "#ph": "phase",
              "#qi": "qIndex",
              "#pe": "phaseEndsAt",
              "#ge": "gameEndsAt",
              "#gp": "gamePausedMs",
              "#gd": "gameDurationMs",
              "#je": "joinEndsAt",
              "#jd": "joinDurationMs",
              "#ra": "replayAt",
              "#ep": "epoch",
              "#hi": "history",
              "#ua": "updatedAt",
              "#ttl": "ttl",
              "#sr": "showRules",
            },
            ExpressionAttributeValues: {
              ":ph": { S: next.phase },
              ":qi": { N: String(next.qIndex) },
              ":pe": next.phaseEndsAt == null ? { NULL: true } : { N: String(next.phaseEndsAt) },
              ":ge": next.gameEndsAt == null ? { NULL: true } : { N: String(next.gameEndsAt) },
              ":gp": next.gamePausedMs == null ? { NULL: true } : { N: String(next.gamePausedMs) },
              ":gd": { N: String(next.gameDurationMs ?? GAME_DURATION_MS) },
              ":je": next.joinEndsAt == null ? { NULL: true } : { N: String(next.joinEndsAt) },
              ":jd": { N: String(next.joinDurationMs ?? JOIN_DURATION_MS) },
              ":ra": { N: String(next.replayAt ?? 0) },
              ":ep": { N: String(next.epoch ?? 0) },
              ":hi": { L: (next.history ?? []).map((entry) => ({ S: entry })) },
              ":ua": { N: String(now) },
              ":prev": { N: String(expectedUpdatedAt ?? 0) },
              ":ttl": { N: ttlAt(now) },
              ":sr": { BOOL: Boolean(next.showRules) },
            },
          }),
        );
        return true;
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") return false;
        throw err;
      }
    },

    async getTally(qIndex) {
      return sumTally(await batchGet(tallySks(qIndex)), qIndex);
    },

    async getTallies(count) {
      const items = await batchGet(Array.from({ length: count }, (_, i) => tallySks(i)).flat());
      return Array.from({ length: count }, (_, i) => sumTally(items, i));
    },

    // Content is keyed by slot, and the first five slots are the strings "0"
    // through "4" — so `content#0` is the same item it has always been and a
    // table written before questions could be added needs no migration.
    async getContent(slots) {
      const items = await batchGet(slots.map((slot) => `content#${slot}`));
      return slots.map((slot) => {
        const raw = items.get(`content#${slot}`)?.json?.S;
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      });
    },

    async putMeta(slot, patch) {
      // Read-modify-write of a single small item. The setup page is used by one
      // person before the show, so there is no contention worth locking for.
      const current = parseJson((await batchGet(["meta"])).get("meta")?.json?.S) ?? {};
      const next = { ...current, [slot]: { ...(current[slot] ?? {}), ...patch } };
      await writeJson("meta", next);
      return next[slot];
    },

    async dropMeta(slot) {
      const current = parseJson((await batchGet(["meta"])).get("meta")?.json?.S) ?? {};
      if (!(slot in current)) return;
      const next = { ...current };
      delete next[slot];
      await writeJson("meta", next);
    },

    // The live question list. Written whole, because it is a list: a question
    // deleted from the middle is this array minus one entry, and every other
    // record in the table — content, meta — stays exactly where it was.
    async putRoster(slots) {
      await writeJson("roster", slots);
      await bumpContentVersion();
    },

    async dropContent(slot) {
      await ddb.send(new DeleteItemCommand({ TableName: tableName, Key: key(`content#${slot}`) }));
      await bumpContentVersion();
    },

    async putContent(slot, question) {
      await writeJson(`content#${slot}`, question);

      // A separate tiny item rather than an attribute on each content item, so
      // getState learns "something changed" in one batched read instead of
      // pulling all five questions on every poll.
      //
      // Written after the content it describes. A version that landed first
      // would send every client to /content while the new text was still the
      // old text there — and they would not come back, because from their side
      // nothing had changed since.
      //
      // ADD, not SET, so it is a counter: clients only ever compare it for
      // inequality, and an atomic increment cannot lose a save to a racing one.
      await bumpContentVersion();
    },

    async recordVote({ qIndex, voterId, choice, now }) {
      return sendWithConflictRetry(
        ddb,
        () =>
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...key(`voter#${qIndex}#${voterId}`),
                    choice: { S: choice },
                    ts: { N: String(now) },
                    ttl: { N: ttlAt(now) },
                  },
                  ConditionExpression: "attribute_not_exists(SK)",
                },
              },
              {
                Update: {
                  TableName: tableName,
                  // One of ten counters, chosen per vote. Three hundred phones
                  // vote in the two seconds after START; against a single item
                  // that burst produced 537 TransactionConflict retries in the
                  // 300-player run. Reads sum every shard, so the total is
                  // unchanged — see tally.js.
                  Key: key(shardSk(qIndex, pickShard())),
                  UpdateExpression: "SET #ttl = :ttl ADD #c :one",
                  ExpressionAttributeNames: { "#ttl": "ttl", "#c": choice },
                  ExpressionAttributeValues: { ":one": { N: "1" }, ":ttl": { N: ttlAt(now) } },
                },
              },
            ],
          }),
      );
    },

    async recordJoin(voterId, now) {
      return sendWithConflictRetry(
        ddb,
        () =>
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...key(`joiner#${voterId}`),
                    ts: { N: String(now) },
                    ttl: { N: ttlAt(now) },
                  },
                  ConditionExpression: "attribute_not_exists(SK)",
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: key("joined"),
                  UpdateExpression: "SET #ttl = :ttl ADD #c :one",
                  ExpressionAttributeNames: { "#ttl": "ttl", "#c": "count" },
                  ExpressionAttributeValues: { ":one": { N: "1" }, ":ttl": { N: ttlAt(now) } },
                },
              },
            ],
          }),
      );
    },

    // Rehearsal tool: delete the votes, joins, tallies and state — but never
    // the authored question content or the answer overrides.
    async reset() {
      let startKey;
      do {
        const page = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": PK },
            ProjectionExpression: "PK, SK",
            ExclusiveStartKey: startKey,
          }),
        );

        // `content-version` survives with the content it describes. Deleting it
        // would reset the counter to 0, and every phone and the projector would
        // read that as an edit and refetch /content in the same second — a
        // self-inflicted thundering herd at the exact moment RESET is pressed,
        // which is minutes before the doors open.
        // `roster` survives for the same reason `content#` does: RESET clears
        // the votes, and a question the operator added an hour ago is content,
        // not a vote. Deleting it would silently take the deck back to five.
        const items = (page.Items ?? []).filter(
          (item) =>
            !item.SK.S.startsWith("content#") &&
            item.SK.S !== "meta" &&
            item.SK.S !== "content-version" &&
            item.SK.S !== "roster",
        );
        for (let i = 0; i < items.length; i += 25) {
          const chunk = items.slice(i, i + 25);
          await ddb.send(
            new BatchWriteItemCommand({
              RequestItems: {
                [tableName]: chunk.map((item) => ({
                  DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
                })),
              },
            }),
          );
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
    },
  };
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cancellationReasons(err) {
  return err.name === "TransactionCanceledException" ? (err.CancellationReasons ?? []) : [];
}

function isConditionFailure(err) {
  if (err.name === "ConditionalCheckFailedException") return true;
  return cancellationReasons(err).some((r) => r.Code === "ConditionalCheckFailed");
}

// A TransactWriteItems cancellation names *why* per item. `TransactionConflict`
// means a concurrent writer touched the same item in the same instant — the
// only shape of contention `tally#<qIndex>` and `joined` see, since every
// voter or joiner in the room ADDs to one shared item. It is transient and
// safe to retry: the retried attempt re-evaluates the same condition fresh.
//
// Everything else that can cancel a transaction (ProvisionedThroughputExceeded,
// ThrottlingError, ValidationError, ItemCollectionSizeLimitExceeded, ...) names
// a capacity or shape problem, not a race. Retrying those would spend the
// phone's 4s abort budget quietly hiding a signal that something needs fixing
// elsewhere — they surface immediately, same as before this change.
function isTransactionConflict(err) {
  return cancellationReasons(err).some((r) => r.Code === "TransactionConflict");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter (a random delay between 0 and an exponentially growing cap) so
// contending writers spread out instead of retrying in lockstep and
// re-colliding on the same hot item. This matters more than usual here: the
// real client (frontend/src/lib/api.js) does not back off at all, so without
// jitter a burst of simultaneous votes would retry in the same simultaneous
// burst.
//
// Budget: 4 retries (5 attempts total), delay caps 20/40/80/160ms. Worst case
// — every jittered delay lands at its cap and every DynamoDB round trip takes
// a pessimistic 150ms — is (20+40+80+160) + 5*150 = 1050ms added to a vote
// that already costs one getState() round trip before this (router.js:116).
// That leaves comfortable room inside the phone's 4000ms abort, most of which
// exists for venue wifi RTT rather than server-side work. A single retry
// resolves the contention measured in #6 (8/258 at 50 concurrent players);
// this budget has headroom for the ~10x hotter counter expected at 500 VUs
// without ever approaching the client's abort.
const CONFLICT_MAX_ATTEMPTS = 5; // 1 initial try + 4 retries
const CONFLICT_BASE_DELAY_MS = 20;
const CONFLICT_MAX_DELAY_MS = 200;

function conflictBackoffMs(attempt) {
  const cap = Math.min(CONFLICT_MAX_DELAY_MS, CONFLICT_BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * cap;
}

// Shared by recordVote and recordJoin: both are a conditional Put (dedup)
// plus an ADD on one shared counter item, and both can be cancelled by the
// same TransactionConflict when two writers hit that counter at once.
// `makeCommand` is a factory rather than a built command so each retry gets
// its own fresh command instance, matching the retry style already used by
// batchGet above.
async function sendWithConflictRetry(ddb, makeCommand) {
  for (let attempt = 0; ; attempt++) {
    try {
      await ddb.send(makeCommand());
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false; // legitimate dedup — never retried
      if (!isTransactionConflict(err) || attempt >= CONFLICT_MAX_ATTEMPTS - 1) throw err;
      await sleep(conflictBackoffMs(attempt));
    }
  }
}
