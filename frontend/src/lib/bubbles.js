// Which way each answer bubble points, and how much room it gets. Pure, and
// importing nothing, so it runs under plain node --test like choices.js does —
// the phone has no DOM test setup, and this is the only logic the bubbles have.

// The grid is two columns wide at every count (see .quiz__choices), so a
// bubble's column is its index parity. Tails point at the edge of the screen
// they sit nearest: left column left, right column right, which reads as two
// people talking either side of the chat. The odd one out that spans the full
// width keeps the left tail, the way a lone `.bubble` does everywhere else.
export function tailSide(index, count) {
  if (spansRow(index, count)) return "left";
  return index % 2 === 0 ? "left" : "right";
}

// Two options get the big roomy bubbles; three or more get the compact ones so
// six of them still sit above the fold on a small phone. The 68px floor for a
// tap target lives in the stylesheet; this only picks the class.
export function bubbleSize(count) {
  return count > 2 ? "many" : "pair";
}

// Whether a bubble spans both columns: the last of an odd count, so the grid
// never ends on a lone half-width bubble with a hole beside it. Two options
// never span; they sit side by side.
export function spansRow(index, count) {
  return count > 2 && count % 2 === 1 && index === count - 1;
}
