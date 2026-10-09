// Server-side question metadata: which questions exist, and how long each
// one's countdown runs.
//
// GENERATED from content/questions.source.json by scripts/build-content.mjs,
// alongside the public projection the frontend bundles. There is no answer key
// here and nothing to keep from the room: an opinion poll has no correct
// option, so the deck is a list of ids and durations and that is all of it.
//
// The validation below is deliberately fail-fast. A duplicated id puts one
// question's text under another's heading, and a countdown of zero opens a
// question that has already closed — both in front of the whole room — and a
// container that refuses to start is enormously better than finding out on
// stage.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DECK = fileURLToPath(new URL("./deck.json", import.meta.url));

export function loadQuestions(source = process.env.DECK_FILE) {
  // An override is relative to the working directory; the default is relative
  // to this module, so it survives whatever WORKDIR the container uses. An
  // empty override counts as none: docker-compose.yml passes DECK_FILE through
  // as "" when nobody has set it, and that has to land on the default deck.
  const path = source ? resolve(process.cwd(), source) : DEFAULT_DECK;
  const questions = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${path}: must be a non-empty array`);
  }

  const seen = new Set();
  for (const [i, q] of questions.entries()) {
    const at = `${path}: question ${i + 1} (${q.id ?? "no id"})`;

    if (typeof q.id !== "string" || !q.id) throw new Error(`${at}: missing id`);
    if (seen.has(q.id)) throw new Error(`${at}: duplicate id "${q.id}"`);
    seen.add(q.id);

    if (!Number.isFinite(q.duration) || q.duration <= 0) {
      throw new Error(`${at}: duration must be a positive number of seconds`);
    }
  }

  return questions;
}
