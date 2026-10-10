// Offline mode (#12) has to survive the store it is saved in. Production runs
// on DynamoDB, whose adapter names every attribute it persists, so a field the
// adapter does not name is silently dropped: OFFLINE_ON answered 200, /state
// said offline:false, and the phones kept voting.
//
// Every router-level test here runs on both stores, the same way the
// imageScale tests in router.test.js do; the fake table below is only a table.

import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "./router.js";
import { createMemoryStore } from "./store-memory.js";
import { createDynamoStore } from "./store-dynamo.js";
import { initialState } from "./game.js";

const KEY = "test-key";
const NOW = 1_700_000_000_000;
const QUESTIONS = [
  { id: "q1", duration: 40 },
  { id: "q2", duration: 45 },
];

// A DynamoDB table small enough to read, big enough for everything the state
// item, votes, joins and RESET issue. Anything else throws, on purpose.
// UpdateItem honours ConditionExpression `attribute_not_exists(SK) OR #ua = :prev`
// so the optimistic lock on `updatedAt` is really exercised.
function statefulTable() {
  const items = new Map();
  const id = ({ PK, SK }) => `${PK.S} ${SK.S}`;

  const conditionFails = (cmd, current) => {
    const {
      ConditionExpression: cond,
      ExpressionAttributeNames: n,
      ExpressionAttributeValues: v,
    } = cmd;
    if (!cond) return false;
    if (cond === "attribute_not_exists(SK)") return Boolean(current);
    if (cond === "attribute_not_exists(SK) OR #ua = :prev") {
      return Boolean(current) && current[n["#ua"]]?.N !== v[":prev"].N;
    }
    throw new Error(`statefulTable does not support condition: ${cond}`);
  };

  const applyUpdate = (cmd) => {
    const {
      Key,
      UpdateExpression,
      ExpressionAttributeNames: n = {},
      ExpressionAttributeValues: v,
    } = cmd;
    const current = items.get(id(Key));
    if (conditionFails(cmd, current)) {
      throw Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      });
    }
    const next = { ...(current ?? Key) };
    const [setPart, addPart] = UpdateExpression.replace(/^SET /, "").split(/\s+ADD\s+/);
    for (const clause of setPart.split(",")) {
      const [name, value] = clause.split("=").map((s) => s.trim());
      next[n[name] ?? name] = v[value];
    }
    if (addPart) {
      const [name, value] = addPart.trim().split(/\s+/);
      const attr = n[name] ?? name;
      next[attr] = { N: String(Number(next[attr]?.N ?? 0) + Number(v[value].N)) };
    }
    items.set(id(Key), next);
  };

  return {
    items,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "BatchGetItemCommand") {
        const [table, { Keys }] = Object.entries(input.RequestItems)[0];
        return {
          Responses: { [table]: Keys.map((k) => items.get(id(k))).filter(Boolean) },
          UnprocessedKeys: {},
        };
      }
      if (name === "UpdateItemCommand") {
        applyUpdate(input);
        return {};
      }
      if (name === "TransactWriteItemsCommand") {
        for (const { Put, Update } of input.TransactItems) {
          if (Put && conditionFails(Put, items.get(id(Put.Item)))) {
            throw Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
            });
          }
          if (Update === undefined && Put === undefined) throw new Error("unsupported item");
        }
        for (const { Put, Update } of input.TransactItems) {
          if (Put) items.set(id(Put.Item), Put.Item);
          else applyUpdate(Update);
        }
        return {};
      }
      if (name === "QueryCommand") {
        return { Items: [...items.values()].map(({ PK, SK }) => ({ PK, SK })) };
      }
      if (name === "BatchWriteItemCommand") {
        for (const { DeleteRequest } of Object.values(input.RequestItems)[0]) {
          items.delete(id(DeleteRequest.Key));
        }
        return {};
      }
      throw new Error(`statefulTable does not support command: ${name}`);
    },
  };
}

const dynamo = (table = statefulTable()) =>
  createDynamoStore({ tableName: "test-table", client: table });

const STORES = [
  { name: "memory", make: () => createMemoryStore() },
  { name: "dynamo", make: () => dynamo() },
];

function harness(store) {
  const router = createRouter({ store, defaults: QUESTIONS, adminKey: KEY });
  return {
    state: (now = NOW) => router({ method: "GET", path: "/state", query: {}, now }),
    admin: (action, now = NOW) =>
      router({ method: "POST", path: "/admin", body: { key: KEY, action }, now }),
    vote: (voterId = "voter-aaaa", now = NOW) =>
      router({ method: "POST", path: "/vote", body: { voterId, qIndex: 0, choice: "a" }, now }),
  };
}

// --- The adapter itself ------------------------------------------------------

test("the DynamoDB store saves offline and reads it back, true and false", async () => {
  const store = dynamo();
  assert.equal(await store.putState({ ...initialState(), offline: true }, 0, NOW), true);
  assert.equal((await store.getState()).offline, true);

  assert.equal(await store.putState({ ...initialState(), offline: false }, NOW, NOW + 1), true);
  assert.equal((await store.getState()).offline, false);
});

test("a state item written before offline existed reads as not offline", async () => {
  const table = statefulTable();
  table.items.set("game#1 state", {
    PK: { S: "game#1" },
    SK: { S: "state" },
    phase: { S: "LOBBY" },
    qIndex: { N: "0" },
    history: { L: [] },
    updatedAt: { N: String(NOW) },
  });
  assert.equal((await dynamo(table).getState()).offline, false);
});

test("with no state item at all the DynamoDB store reads as not offline", async () => {
  assert.equal((await dynamo().getState()).offline, false);
});

test("the updatedAt lock still turns away a stale writer when offline is in the write", async () => {
  const store = dynamo();
  assert.equal(await store.putState({ ...initialState(), offline: true }, 0, NOW), true);

  // Two pods read updatedAt = NOW. The first lands; the second is stale.
  assert.equal(await store.putState({ ...initialState(), offline: false }, NOW, NOW + 1), true);
  assert.equal(
    await store.putState({ ...initialState(), offline: true }, NOW, NOW + 2),
    false,
    "the stale writer is refused",
  );
  assert.equal((await store.getState()).offline, false, "and its offline value did not land");
});

// --- Through the router, on both stores --------------------------------------

for (const { name, make } of STORES) {
  test(`offline [${name}]: ON in the lobby blocks votes, OFF lets them back in`, async () => {
    const api = harness(make());

    const on = await api.admin("OFFLINE_ON");
    assert.equal(on.status, 200);
    assert.equal(on.body.offline, true, "the admin answer says so");
    assert.equal((await api.state()).body.offline, true, "and so does the next poll");

    assert.equal((await api.admin("START")).status, 200);
    assert.equal((await api.state()).body.offline, true, "still offline once voting is open");
    const refused = await api.vote();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "OFFLINE");

    // Back to a lobby to switch it off: the reducer only allows that there.
    assert.equal((await api.admin("BACK")).status, 200);
    assert.equal((await api.admin("OFFLINE_OFF")).status, 200);
    assert.equal((await api.state()).body.offline, false);
    assert.equal((await api.admin("START")).status, 200);
    assert.equal((await api.vote()).status, 200, "normal voting is back");
  });

  test(`offline [${name}]: RESET keeps offline when it was on`, async () => {
    const api = harness(make());
    await api.admin("OFFLINE_ON");
    await api.admin("START");

    const reset = await api.admin("RESET");
    assert.equal(reset.status, 200);
    assert.equal(reset.body.offline, true);
    assert.equal((await api.state()).body.offline, true);
    assert.equal(reset.body.phase, "LOBBY");
  });

  test(`offline [${name}]: RESET keeps offline off when it was off`, async () => {
    const api = harness(make());
    await api.admin("START");
    await api.vote();

    const reset = await api.admin("RESET");
    assert.equal(reset.body.offline, false);
    assert.equal((await api.state()).body.offline, false);
    await api.admin("START");
    assert.equal((await api.vote()).status, 200);
  });

  test(`offline [${name}]: a fresh room is not offline`, async () => {
    assert.equal((await harness(make()).state()).body.offline, false);
  });
}
