import test from "node:test";
import assert from "node:assert/strict";

import { bubbleSize, spansRow, tailSide } from "./bubbles.js";

const sides = (count) => Array.from({ length: count }, (_, i) => tailSide(i, count));

test("two bubbles face outward, one tail each side", () => {
  assert.deepEqual(sides(2), ["left", "right"]);
});

test("columns alternate and the odd one out keeps the left tail", () => {
  assert.deepEqual(sides(3), ["left", "right", "left"]);
  assert.deepEqual(sides(4), ["left", "right", "left", "right"]);
  assert.deepEqual(sides(5), ["left", "right", "left", "right", "left"]);
  assert.deepEqual(sides(6), ["left", "right", "left", "right", "left", "right"]);
});

test("only the last of an odd count of three or more spans the row", () => {
  const spans = (count) => Array.from({ length: count }, (_, i) => spansRow(i, count));
  assert.deepEqual(spans(2), [false, false]);
  assert.deepEqual(spans(3), [false, false, true]);
  assert.deepEqual(spans(4), [false, false, false, false]);
  assert.deepEqual(spans(5), [false, false, false, false, true]);
  assert.deepEqual(spans(6), [false, false, false, false, false, false]);
});

test("a pair is roomy, anything more is compact", () => {
  assert.equal(bubbleSize(2), "pair");
  for (const n of [3, 4, 5, 6]) assert.equal(bubbleSize(n), "many");
});
