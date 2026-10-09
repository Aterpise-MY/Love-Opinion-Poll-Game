// choices.js imports nothing and touches no browser API, so it runs under
// plain node --test with no bundler in the way. Everything that prints a
// percentage — the phone, the wall, the operator console and both recaps —
// goes through sharesOf, so this is the one place the arithmetic is pinned.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_OPTIONS, OPTION_KEYS, sharesOf, totalVotes } from "./choices.js";

const zeros = Object.fromEntries(OPTION_KEYS.map((key) => [key, 0]));
const sum = (shares) => OPTION_KEYS.reduce((total, key) => total + shares[key], 0);

test("nobody voted means no shares at all, not six zeros", () => {
  assert.equal(sharesOf({}), null);
  assert.equal(sharesOf(null), null);
  assert.equal(sharesOf(undefined), null);
  assert.equal(sharesOf(zeros), null);
});

test("an exact tie on the remainder goes to the earlier key", () => {
  // 37.5 against 62.5: rounding each on its own gives 38 and 63, which is 101.
  assert.deepEqual(sharesOf({ a: 3, b: 5 }), { ...zeros, a: 38, b: 62 });
  // The same tie the other way round still breaks towards `a`.
  assert.deepEqual(sharesOf({ a: 5, b: 3 }), { ...zeros, a: 63, b: 37 });
});

test("the spare point goes to whichever share lost the most by rounding down", () => {
  assert.deepEqual(sharesOf({ a: 1, b: 2 }), { ...zeros, a: 33, b: 67 });
  assert.deepEqual(sharesOf({ a: 2, b: 1 }), { ...zeros, a: 67, b: 33 });
  // Three equal thirds: 33 each leaves one point, and the tie gives it to `a`.
  assert.deepEqual(sharesOf({ a: 1, b: 1, c: 1 }), { ...zeros, a: 34, b: 33, c: 33 });
});

test("shares always add up to exactly 100, whatever the room does", () => {
  // Every two-way split of every room up to 60, then a spread of six-way ones.
  for (let total = 1; total <= 60; total++) {
    for (let a = 0; a <= total; a++) {
      const shares = sharesOf({ a, b: total - a });
      assert.equal(sum(shares), 100, `a=${a} b=${total - a}`);
      for (const key of OPTION_KEYS) assert.ok(Number.isInteger(shares[key]), key);
    }
  }
  for (const tally of [
    { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
    { a: 7, b: 11, c: 13, d: 17, e: 19, f: 23 },
    { a: 299, b: 1 },
    { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 99 }, // a key outside the space is not a vote
  ]) {
    assert.equal(sum(sharesOf(tally)), 100, JSON.stringify(tally));
  }
});

test("a whole-number share is that number, not a float one step short of it", () => {
  // 0.29 * 100 is 28.999999999999996 in floating point. Flooring that would
  // print 28% for 29 votes in 100.
  assert.equal(sharesOf({ a: 29, b: 71 }).a, 29);
  assert.equal(sharesOf({ a: 57, b: 43 }).a, 57);
  assert.deepEqual(sharesOf({ a: 300 }), { ...zeros, a: 100 });
});

test("a vote on an option the question no longer offers still holds its share", () => {
  // Two options are left on the ballot, and one rehearsal vote sits on a third
  // that was deleted. The two that are left add up to 75, and that is correct.
  const shares = sharesOf({ a: 1, b: 2, c: 1 });
  assert.deepEqual(shares, { ...zeros, a: 25, b: 50, c: 25 });
  assert.equal(totalVotes({ a: 1, b: 2, c: 1 }), 4);
  // What a surface prints is the shares of the options still on the ballot.
  assert.deepEqual(
    DEFAULT_OPTIONS.map((option) => shares[option.key]),
    [25, 50],
  );
});

test("the default pair is 可以 and 不可以, a heart and a cross that are not emoji", () => {
  assert.deepEqual(
    DEFAULT_OPTIONS.map(({ key, label }) => [key, label]),
    [
      ["a", "可以"],
      ["b", "不可以"],
    ],
  );
  // One code point each, and exactly these two: U+2665 and U+2715 are the pair
  // the "Poll Glyphs" face in fonts.css is declared for. A variation selector,
  // or any other code point, would fall through to the handset's own fonts —
  // which is how a heart turns back into a colour emoji.
  assert.deepEqual(
    DEFAULT_OPTIONS.map(({ icon }) => [...icon].map((glyph) => glyph.codePointAt(0))),
    [[0x2665], [0x2715]],
  );
});
