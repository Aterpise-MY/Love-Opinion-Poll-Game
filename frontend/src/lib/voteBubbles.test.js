import assert from "node:assert/strict";
import test from "node:test";

import {
  ANONYMOUS,
  MAX_ON_SCREEN,
  MAX_QUEUE,
  SHOW_MS,
  advance,
  describe,
  show,
  unexpired,
} from "./voteBubbles.js";

const vote = (id, extra = {}) => ({ id, name: `n${id}`, choice: "a", qIndex: 0, at: id, ...extra });
const voting = (...ids) => ({ phase: "VOTING", qIndex: 0, recentVotes: ids.map((id) => vote(id)) });
const ids = (result) => result.fresh.map((entry) => entry.id);

test("the first state only seeds: nothing already cast is replayed", () => {
  const first = advance(null, voting(4, 5, 6));
  assert.deepEqual(first, { lastId: 6, fresh: [] });
  assert.deepEqual(ids(advance(first.lastId, voting(4, 5, 6))), []);
});

test("an empty first state seeds below every id, so the first vote is shown", () => {
  const first = advance(null, { phase: "LOBBY", recentVotes: [] });
  assert.equal(first.lastId, -1);
  assert.deepEqual(ids(advance(first.lastId, voting(0, 1))), [0, 1]);
});

test("only entries above the last id are fresh, oldest first, and the id moves on", () => {
  const next = advance(2, voting(3, 1, 2, 4));
  assert.deepEqual(ids(next), [3, 4]);
  assert.equal(next.lastId, 4);
  assert.deepEqual(ids(advance(next.lastId, voting(1, 2, 3, 4))), []);
});

test("a repeated id is shown once", () => {
  assert.deepEqual(ids(advance(0, voting(1, 1, 2))), [1, 2]);
});

test("a burst larger than the queue keeps the newest, in order, and still advances past all", () => {
  const burst = Array.from({ length: MAX_QUEUE + 5 }, (_, i) => i + 1);
  const next = advance(0, voting(...burst));
  assert.equal(next.fresh.length, MAX_QUEUE);
  assert.equal(next.fresh[0].id, 6);
  assert.equal(next.lastId, MAX_QUEUE + 5);
});

test("outside VOTING nothing is fresh and the last id is kept", () => {
  for (const phase of ["LOBBY", "LOCKED", "REVEAL", "FINAL"]) {
    assert.deepEqual(
      advance(7, { phase, recentVotes: [vote(8)] }),
      { lastId: 7, fresh: [] },
      phase,
    );
  }
  // ids carry on across questions: the next question's votes are above it
  assert.deepEqual(ids(advance(7, voting(8, 9))), [8, 9]);
});

test("an empty list in VOTING changes nothing", () => {
  assert.deepEqual(advance(7, voting()), { lastId: 7, fresh: [] });
});

test("ids that start again below the last one (a server restart) are shown", () => {
  const next = advance(50, voting(1, 2));
  assert.deepEqual(ids(next), [1, 2]);
  assert.equal(next.lastId, 2);
});

test("junk in recentVotes is ignored", () => {
  const state = { phase: "VOTING", recentVotes: [null, {}, { id: "3", choice: "a" }, vote(9)] };
  assert.deepEqual(ids(advance(0, state)), [9]);
  assert.deepEqual(advance(0, { phase: "VOTING" }), { lastId: 0, fresh: [] });
  assert.deepEqual(advance(0, null), { lastId: 0, fresh: [] });
  assert.deepEqual(advance(null, undefined), { lastId: -1, fresh: [] });
});

test("show caps what is on the wall by dropping the oldest", () => {
  let wall = [];
  for (let id = 1; id <= MAX_ON_SCREEN + 2; id++) wall = show(wall, { id, shownAt: 0 });
  assert.equal(wall.length, MAX_ON_SCREEN);
  assert.equal(wall[0].id, 3);
  assert.equal(wall.at(-1).id, MAX_ON_SCREEN + 2);
});

test("unexpired drops bubbles that have run their time", () => {
  const wall = [
    { id: 1, shownAt: 0 },
    { id: 2, shownAt: 1000 },
  ];
  assert.deepEqual(
    unexpired(wall, SHOW_MS - 1).map((b) => b.id),
    [1, 2],
  );
  assert.deepEqual(
    unexpired(wall, SHOW_MS).map((b) => b.id),
    [2],
  );
  assert.deepEqual(unexpired(wall, SHOW_MS + 1000), []);
});

test("describe names the option and falls back for no name or a deleted option", () => {
  const options = [
    { key: "a", label: "可以" },
    { key: "b", label: "不可以" },
  ];
  assert.deepEqual(describe(vote(1, { name: "小明", choice: "b" }), options), {
    id: 1,
    key: "b",
    who: "小明",
    label: "不可以",
  });
  assert.equal(describe(vote(2, { name: null }), options).who, ANONYMOUS);
  assert.equal(describe(vote(3, { name: "" }), options).who, ANONYMOUS);
  assert.equal(describe(vote(4, { choice: "f" }), options).label, "已删除的选项");
});
