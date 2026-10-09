// name.js imports nothing and touches no browser API, so it runs under plain
// node --test. The form and the gate around these rules need a browser; what a
// name may be and when it may change do not.

import test from "node:test";
import assert from "node:assert/strict";

import { NAME_MAX, canEditName, checkName, countCodePoints } from "./name.js";

const refused = (code) => ({ ok: false, code });
const accepted = (name) => ({ ok: true, name });

// By number and by name. Typed straight into a string, every one of these is a
// character nobody reading the test could see.
const at = (code) => String.fromCharCode(code);
const FULL_WIDTH_SPACE = at(0x3000); // what a Chinese keyboard's space bar types
const NO_BREAK_SPACE = at(0xa0);
const NEXT_LINE = at(0x85);
const LINE_SEPARATOR = at(0x2028);
const PARAGRAPH_SEPARATOR = at(0x2029);
// The two halves of 😀, apart.
const HIGH_SURROGATE = at(0xd83d);
const LOW_SURROGATE = at(0xde00);

test("a name is kept as typed, less the space around it", () => {
  assert.deepEqual(checkName("小明"), accepted("小明"));
  assert.deepEqual(checkName("  小明  "), accepted("小明"));
  assert.deepEqual(checkName("\t小明\n"), accepted("小明"));
  assert.deepEqual(checkName(`${FULL_WIDTH_SPACE}小明${FULL_WIDTH_SPACE}`), accepted("小明"));
  assert.deepEqual(checkName(`${NO_BREAK_SPACE}Tom${NO_BREAK_SPACE}`), accepted("Tom"));
  // Spaces inside a name are the name's own, however many there are.
  assert.deepEqual(checkName(" Li  Lei "), accepted("Li  Lei"));
  assert.deepEqual(checkName(`小${FULL_WIDTH_SPACE}明`), accepted(`小${FULL_WIDTH_SPACE}明`));
  assert.deepEqual(checkName("x"), accepted("x"));
});

test("nothing, and nothing but space, is empty", () => {
  for (const raw of [
    "",
    " ",
    "     ",
    FULL_WIDTH_SPACE + FULL_WIDTH_SPACE,
    NO_BREAK_SPACE,
    "\t",
    "\n",
    "\t\r\n ",
    LINE_SEPARATOR,
  ]) {
    assert.deepEqual(checkName(raw), refused("EMPTY"), JSON.stringify(raw));
  }
});

test("what is not text is empty too, so a damaged stored name asks again", () => {
  for (const raw of [null, undefined, 0, 42, true, {}, [], ["小明"]]) {
    assert.deepEqual(checkName(raw), refused("EMPTY"), JSON.stringify(raw));
  }
});

test("twenty is allowed and twenty-one is not", () => {
  assert.equal(NAME_MAX, 20);
  for (const unit of ["字", "w", "é"]) {
    assert.deepEqual(checkName(unit.repeat(20)), accepted(unit.repeat(20)), unit);
    assert.deepEqual(checkName(unit.repeat(21)), refused("TOO_LONG"), unit);
  }
});

test("an emoji counts once, though it is two UTF-16 units", () => {
  const twenty = "😀".repeat(20);
  assert.equal(twenty.length, 40);
  assert.deepEqual(checkName(twenty), accepted(twenty));
  assert.deepEqual(checkName("😀".repeat(21)), refused("TOO_LONG"));
  // Mixed: ten of each is still twenty.
  assert.deepEqual(checkName("字😀".repeat(10)), accepted("字😀".repeat(10)));
  assert.deepEqual(checkName(`${"字😀".repeat(10)}a`), refused("TOO_LONG"));
});

test("the length is measured after trimming, never before", () => {
  const name = "字".repeat(20);
  assert.deepEqual(checkName(`   ${name}${FULL_WIDTH_SPACE}${FULL_WIDTH_SPACE}`), accepted(name));
});

test("a line break inside a name is refused", () => {
  for (const breaker of [
    "\n",
    "\r\n",
    "\r",
    "\v",
    "\f",
    NEXT_LINE,
    LINE_SEPARATOR,
    PARAGRAPH_SEPARATOR,
  ]) {
    assert.deepEqual(checkName(`小${breaker}明`), refused("LINE_BREAK"), JSON.stringify(breaker));
  }
  // Said before the length is: the break is the thing to fix first.
  assert.deepEqual(checkName(`${"字".repeat(30)}\n字`), refused("LINE_BREAK"));
  // At either end it is only space, and trimmed with the rest.
  assert.deepEqual(checkName("\n小明\r\n"), accepted("小明"));
  assert.deepEqual(checkName(`${LINE_SEPARATOR}小明${PARAGRAPH_SEPARATOR}`), accepted("小明"));
});

test("code points are counted, not UTF-16 units and not what the eye sees", () => {
  assert.equal(countCodePoints(""), 0);
  assert.equal(countCodePoints("abc"), 3);
  assert.equal(countCodePoints("这样恋爱"), 4);
  assert.equal(countCodePoints("😀"), 1);
  assert.equal(countCodePoints("𠮷野家"), 3); // 𠮷 is outside the basic plane
  // Half of a pair on its own is still one thing in the field.
  assert.equal(countCodePoints(HIGH_SURROGATE), 1);
  assert.equal(countCodePoints(`a${LOW_SURROGATE}b`), 3);
  assert.equal(countCodePoints(HIGH_SURROGATE + LOW_SURROGATE), 1);
  // Known and accepted: what looks like one emoji can be several code points.
  const regionalM = String.fromCodePoint(0x1f1f2);
  const regionalY = String.fromCodePoint(0x1f1fe);
  assert.equal(countCodePoints(regionalM + regionalY), 2); // the two letters of a flag
  const thumb = String.fromCodePoint(0x1f44d);
  const skinTone = String.fromCodePoint(0x1f3fd);
  assert.equal(countCodePoints(thumb + skinTone), 2);
  const joiner = at(0x200d);
  const [man, woman, girl] = [0x1f468, 0x1f469, 0x1f467].map((code) => String.fromCodePoint(code));
  assert.equal(countCodePoints(man + joiner + woman + joiner + girl), 5); // one family on screen
});

test("the name can be changed in the first lobby and nowhere else", () => {
  assert.equal(canEditName({ phase: "LOBBY", qIndex: 0 }), true);

  // Every later lobby is the same phase, and locked.
  assert.equal(canEditName({ phase: "LOBBY", qIndex: 1 }), false);
  assert.equal(canEditName({ phase: "LOBBY", qIndex: 7 }), false);

  // Question one itself, from the moment it opens.
  for (const phase of ["VOTING", "LOCKED", "REVEAL", "FINAL"]) {
    assert.equal(canEditName({ phase, qIndex: 0 }), false, phase);
  }
});

test("skipping the first question locks the name, and undoing the skip frees it", () => {
  const first = { phase: "LOBBY", qIndex: 0, epoch: 1 };
  const skipped = { phase: "LOBBY", qIndex: 1, epoch: 1 };
  assert.deepEqual([first, skipped, first].map(canEditName), [true, false, true]);
  // A RESET lands in the first lobby of a new run.
  assert.equal(canEditName({ phase: "LOBBY", qIndex: 0, epoch: 2 }), true);
});

test("no state, or a state without the two fields, is not a lobby", () => {
  assert.equal(canEditName(null), false);
  assert.equal(canEditName(undefined), false);
  assert.equal(canEditName({}), false);
  assert.equal(canEditName({ phase: "LOBBY" }), false);
  assert.equal(canEditName({ qIndex: 0 }), false);
  // The index is a number on the wire; a string is not question one.
  assert.equal(canEditName({ phase: "LOBBY", qIndex: "0" }), false);
});
