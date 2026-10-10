// Unit tests for the retry behaviour around recordVote / recordJoin.
//
// These do not exercise real DynamoDB — a fake `client` stands in, scripted
// to throw exactly what a live table throws when TransactWriteItems is
// cancelled. That is deliberate: the in-memory store has no contention model
// at all, and a real integration test would need a hot shared item under
// concurrent load, which is what the #6 harness re-run is for. What is
// testable here, and worth testing here, is that the retry loop reacts to
// each cancellation reason the way the design says it should.

import test from "node:test";
import assert from "node:assert/strict";

import { createDynamoStore } from "./store-dynamo.js";

const NOW = 1_700_000_000_000;

function transactionCanceled(reasons) {
  const err = new Error(
    `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons
      .map((r) => r.Code)
      .join(", ")}]`,
  );
  err.name = "TransactionCanceledException";
  err.CancellationReasons = reasons;
  return err;
}

// The shape observed in #6: the voter/joiner Put is fine (`None`), the shared
// counter's Update lost the race (`TransactionConflict`).
function conflictError() {
  return transactionCanceled([{ Code: "None" }, { Code: "TransactionConflict" }]);
}

// Dedup working as intended: the voter/joiner Put found an existing item.
function alreadyRecordedError() {
  return transactionCanceled([{ Code: "ConditionalCheckFailed" }, { Code: "None" }]);
}

// A capacity/shape problem rather than a race — deliberately not retried.
// See the reasoning in store-dynamo.js next to isTransactionConflict.
function throughputError() {
  return transactionCanceled([{ Code: "None" }, { Code: "ProvisionedThroughputExceeded" }]);
}

// A `client` stand-in whose `.send()` plays back a scripted list of outcomes,
// one per call: an Error to throw, or undefined to resolve. Once the script
// runs out, every further call resolves — recordVote/recordJoin should never
// need more than the scripted length if the retry budget is respected.
function scriptedClient(script) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const outcome = script[calls.length - 1];
      if (outcome) throw outcome;
      return {};
    },
  };
}

function store(client) {
  return createDynamoStore({ tableName: "test-table", gameId: "game#1", client });
}

test("recordVote retries a TransactionConflict once and then succeeds", async () => {
  const client = scriptedClient([conflictError()]);
  const result = await store(client).recordVote({
    qIndex: 0,
    voterId: "voter-aaaa",
    choice: "a",
    now: NOW,
  });

  assert.equal(result, true);
  assert.equal(client.calls.length, 2, "one conflicted attempt, one retry that landed");
});

test("recordJoin retries a TransactionConflict and then succeeds", async () => {
  const client = scriptedClient([conflictError(), conflictError()]);
  const result = await store(client).recordJoin("voter-aaaa", NOW);

  assert.equal(result, true);
  assert.equal(client.calls.length, 3, "two conflicted attempts, third landed");
});

test("recordVote gives up once the retry budget is exhausted, rather than hanging or reporting a false success", async () => {
  // More conflicts scripted than the budget allows, so if the loop is
  // unbounded this test would hang instead of failing fast.
  const client = scriptedClient(Array.from({ length: 20 }, conflictError));

  await assert.rejects(
    () => store(client).recordVote({ qIndex: 0, voterId: "voter-aaaa", choice: "a", now: NOW }),
    (err) => err.name === "TransactionCanceledException",
  );
  assert.equal(client.calls.length, 5, "1 initial attempt + 4 retries, then it surfaces the error");
});

test("recordJoin gives up once the retry budget is exhausted", async () => {
  const client = scriptedClient(Array.from({ length: 20 }, conflictError));

  await assert.rejects(
    () => store(client).recordJoin("voter-aaaa", NOW),
    (err) => err.name === "TransactionCanceledException",
  );
  assert.equal(client.calls.length, 5);
});

test("recordVote treats ConditionalCheckFailed as dedup, not an error, and never retries it", async () => {
  const client = scriptedClient([alreadyRecordedError()]);
  const result = await store(client).recordVote({
    qIndex: 0,
    voterId: "voter-aaaa",
    choice: "a",
    now: NOW,
  });

  assert.equal(result, false, "ALREADY_VOTED semantics, unchanged");
  assert.equal(client.calls.length, 1, "no retry — this is legitimate dedup, not contention");
});

test("recordJoin treats ConditionalCheckFailed as dedup, not an error, and never retries it", async () => {
  const client = scriptedClient([alreadyRecordedError()]);
  const result = await store(client).recordJoin("voter-aaaa", NOW);

  assert.equal(result, false, "already-joined semantics, unchanged");
  assert.equal(client.calls.length, 1);
});

test("a plain (non-transaction) ConditionalCheckFailedException still returns false without retry", async () => {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  const client = scriptedClient([err]);

  const result = await store(client).recordVote({
    qIndex: 0,
    voterId: "voter-aaaa",
    choice: "a",
    now: NOW,
  });

  assert.equal(result, false);
  assert.equal(client.calls.length, 1);
});

test("a cancellation reason that is neither ConditionalCheckFailed nor TransactionConflict surfaces immediately, unretried", async () => {
  // ProvisionedThroughputExceeded / ThrottlingError / ValidationError name a
  // capacity or shape problem, not a race, and retrying them would spend the
  // client's abort budget hiding a signal that needs to be visible instead.
  const client = scriptedClient([throughputError()]);

  await assert.rejects(
    () => store(client).recordVote({ qIndex: 0, voterId: "voter-aaaa", choice: "a", now: NOW }),
    (err) => err.name === "TransactionCanceledException",
  );
  assert.equal(client.calls.length, 1, "not treated as a race, so not retried");
});

// ---------------------------------------------------------------------------
// Sharded tallies. The rollout argument is the union read, so that is what
// these pin down.

// A client backed by a table of items, so a read can be checked against seeded
// counters rather than against a script of failures.
function tableClient(items = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const keys = command.input?.RequestItems?.["test-table"]?.Keys;
      if (!keys) return {};
      const responses = keys
        .map((k) => items[k.SK.S])
        .filter(Boolean)
        .map((attrs, i) => ({ PK: { S: "game#1" }, SK: { S: keys[i].SK.S }, ...attrs }));
      return { Responses: { "test-table": responses } };
    },
  };
}

const counts = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { N: String(v) }]));

test("a tally is the sum of the unsharded counter and every shard", async () => {
  // Exactly the state a rolling deployment produces: some votes written by a
  // task that predates sharding, the rest spread across shards by tasks that
  // do not. A reader must see all of them, whichever task serves the read.
  const client = tableClient({
    "tally#0": counts({ a: 7, b: 1 }),
    "tally#0#3": counts({ a: 2, b: 5 }),
    "tally#0#9": counts({ a: 1 }),
  });

  const tally = await store(client).getTally(0);
  assert.equal(tally.a, 10, "7 legacy + 2 + 1 sharded");
  assert.equal(tally.b, 6);
  assert.equal(tally.c, 0, "an option nobody picked is still present and zero");
});

test("a question with only legacy votes reads exactly as it did before sharding", async () => {
  const client = tableClient({ "tally#2": counts({ a: 4, b: 6 }) });
  const tally = await store(client).getTally(2);
  assert.equal(tally.a, 4);
  assert.equal(tally.b, 6);
});

test("the batched read is chunked to DynamoDB's 100-key limit", async () => {
  // Forty questions is the deck ceiling; eleven counters each is 440 keys, and
  // one BatchGetItem takes 100. Unchunked this is a ValidationException at
  // FINAL, on the one screen nobody can refresh.
  const client = tableClient({});
  await store(client).getTallies(40);

  const batches = client.calls.filter((c) => c.input?.RequestItems);
  assert.equal(batches.length, 5, "440 keys over five requests");
  for (const batch of batches) {
    assert.ok(batch.input.RequestItems["test-table"].Keys.length <= 100);
  }
});

test("a vote lands on a shard, never on the counter phase 1 still read", async () => {
  const client = scriptedClient([]);
  await store(client).recordVote({ qIndex: 3, voterId: "voter-aaaa", choice: "b", now: NOW });

  const update = client.calls[0].input.TransactItems[1].Update;
  assert.match(update.Key.SK.S, /^tally#3#\d+$/);
  assert.equal(update.ExpressionAttributeNames["#c"], "b");
});

test("votes spread across shards, and the sum is exact", async () => {
  // The property that matters is not the distribution, it is that nothing is
  // lost by spreading: two hundred votes must still read as two hundred.
  const client = scriptedClient([]);
  const adapter = store(client);
  for (let i = 0; i < 200; i++) {
    await adapter.recordVote({ qIndex: 0, voterId: `voter-${i}`, choice: "a", now: NOW });
  }

  const used = new Set(client.calls.map((c) => c.input.TransactItems[1].Update.Key.SK.S));
  assert.ok(used.size > 1, `200 votes went to one shard: ${[...used]}`);

  // Replay those writes into a table and read it back the way the app does.
  const counters = {};
  for (const sk of used) counters[sk] = { a: { N: "0" } };
  for (const call of client.calls) {
    const sk = call.input.TransactItems[1].Update.Key.SK.S;
    counters[sk].a = { N: String(Number(counters[sk].a.N) + 1) };
  }
  assert.equal((await store(tableClient(counters)).getTally(0)).a, 200);
});

test("a reader sums both shapes while a rolling deployment writes both", async () => {
  // The rollout guarantee, stated as a test. During phase 2's rollout an old
  // task still writes tally#<q> and a new task writes tally#<q>#<shard>. This
  // is what every task reads while that is true.
  const client = tableClient({
    "tally#1": counts({ a: 120 }), // still-draining phase 1 task
    "tally#1#4": counts({ a: 80 }), // phase 2 task
  });
  assert.equal((await store(client).getTally(1)).a, 200, "no vote is invisible to either");
});

// ---------------------------------------------------------------------------
// Recent-votes feed.

// An in-memory stand-in for the three commands the feed uses.
function feedClient() {
  const items = new Map();
  let seq = 0;
  const calls = [];
  return {
    calls,
    items,
    async send(command) {
      calls.push(command);
      const input = command.input;
      switch (command.constructor.name) {
        case "UpdateItemCommand":
          assert.equal(input.Key.SK.S, "feed-seq");
          seq += 1;
          return { Attributes: { n: { N: String(seq) } } };
        case "PutItemCommand":
          items.set(input.Item.SK.S, input.Item);
          return {};
        case "QueryCommand": {
          assert.equal(input.ScanIndexForward, false);
          const rows = [...items.entries()]
            .filter(([sk]) => sk.startsWith("feed#"))
            .sort(([a], [b]) => (a < b ? 1 : -1))
            .slice(0, input.Limit)
            .map(([, item]) => item);
          return { Items: rows };
        }
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  };
}

test("appendRecentVote writes one padded, TTL'd item per vote and never the voter id", async () => {
  const client = feedClient();
  const s = store(client);
  await s.appendRecentVote({ name: "小明", choice: "b", qIndex: 2, now: NOW });
  await s.appendRecentVote({ name: null, choice: "a", qIndex: 2, now: NOW + 5 });

  assert.deepEqual([...client.items.keys()], ["feed#000000000001", "feed#000000000002"]);
  const first = client.items.get("feed#000000000001");
  assert.equal(first.name.S, "小明");
  assert.ok(first.ttl.N);
  assert.equal("name" in client.items.get("feed#000000000002"), false, "no name, no attribute");
  assert.equal(JSON.stringify([...client.items.values()]).includes("voter"), false);
});

test("getRecentVotes returns the newest 30, oldest first, with null for a missing name", async () => {
  const client = feedClient();
  const s = store(client);
  for (let i = 0; i < 33; i++) {
    await s.appendRecentVote({
      name: i === 32 ? null : `n${i}`,
      choice: "a",
      qIndex: 0,
      now: NOW + i,
    });
  }
  const feed = await s.getRecentVotes();
  assert.equal(feed.length, 30);
  assert.deepEqual(
    feed.map((e) => e.id),
    Array.from({ length: 30 }, (_, i) => i + 4),
  );
  assert.deepEqual(feed.at(-1), { id: 33, name: null, choice: "a", qIndex: 0, at: NOW + 32 });
});

test("reset deletes the feed items but keeps the feed sequence", async () => {
  const deleted = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      if (name === "QueryCommand") {
        return {
          Items: ["state", "feed#000000000001", "feed-seq", "roster"].map((sk) => ({
            PK: { S: "game#1" },
            SK: { S: sk },
          })),
        };
      }
      if (name === "BatchWriteItemCommand") {
        for (const r of command.input.RequestItems["test-table"]) {
          deleted.push(r.DeleteRequest.Key.SK.S);
        }
      }
      return {};
    },
  };
  await store(client).reset();
  assert.deepEqual(deleted, ["state", "feed#000000000001"]);
});
