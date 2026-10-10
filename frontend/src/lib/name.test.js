// name.js imports nothing and touches no browser API, so it runs under plain
// node --test. The form and the gate around these rules need a browser; what a
// name may be and when it may change do not.

import test from "node:test";
import assert from "node:assert/strict";

import { NAME_MAX, canEditName, checkName, countCodePoints, nameField } from "./name.js";

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

test("twelve is allowed and thirteen is not", () => {
  assert.equal(NAME_MAX, 12);
  for (const unit of ["字", "w", "é"]) {
    assert.deepEqual(checkName(unit.repeat(12)), accepted(unit.repeat(12)), unit);
    assert.deepEqual(checkName(unit.repeat(13)), refused("TOO_LONG"), unit);
  }
});

test("an emoji counts once, though it is two UTF-16 units", () => {
  const twelve = "😀".repeat(12);
  assert.equal(twelve.length, 24);
  assert.deepEqual(checkName(twelve), accepted(twelve));
  assert.deepEqual(checkName("😀".repeat(13)), refused("TOO_LONG"));
  // Mixed: six of each is still twelve.
  assert.deepEqual(checkName("字😀".repeat(6)), accepted("字😀".repeat(6)));
  assert.deepEqual(checkName(`${"字😀".repeat(6)}a`), refused("TOO_LONG"));
});

test("the length is measured after trimming, never before", () => {
  const name = "字".repeat(12);
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

test("the name can be changed in the lobby, whichever question is next", () => {
  for (const qIndex of [0, 1, 7]) {
    assert.equal(canEditName({ phase: "LOBBY", qIndex }), true, String(qIndex));
  }
});

test("the name can be changed once the question is locked", () => {
  assert.equal(canEditName({ phase: "LOCKED", qIndex: 2 }), true);
});

test("the name can be changed under an open question only once it is answered", () => {
  const voting = { phase: "VOTING", qIndex: 0 };
  assert.equal(canEditName(voting, true), false); // still to answer: never cover it
  assert.equal(canEditName(voting, false), true); // voted, or the time is up
  assert.equal(canEditName(voting), true);
});

test("the reveal and the recap have no button", () => {
  for (const phase of ["REVEAL", "FINAL"]) {
    assert.equal(canEditName({ phase, qIndex: 0 }), false, phase);
  }
});

test("no state, or an unknown phase, offers nothing", () => {
  assert.equal(canEditName(null), false);
  assert.equal(canEditName(undefined), false);
  assert.equal(canEditName({}), false);
  assert.equal(canEditName({ phase: "NOPE" }), false);
});

test("a vote carries the name only when there is one", () => {
  assert.deepEqual(nameField("小明"), { name: "小明" });
  assert.deepEqual(nameField("Li Lei"), { name: "Li Lei" });
  for (const none of [null, undefined, "", 7, {}, []]) {
    assert.deepEqual(nameField(none), {}, String(none));
  }
});
