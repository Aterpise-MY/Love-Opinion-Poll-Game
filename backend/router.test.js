import test from "node:test";
import assert from "node:assert/strict";

import { GAME_DURATION_MS, OPTION_KEYS } from "./game.js";
import { API_ROUTES, createRouter } from "./router.js";
import { createMemoryStore } from "./store-memory.js";
import { createDynamoStore } from "./store-dynamo.js";

const QUESTIONS = [
  { id: "q1", duration: 40 },
  { id: "q2", duration: 45 },
];
const KEY = "test-key";
const NOW = 1_700_000_000_000;

// A tally always reports the whole key space, so the shape does not depend on
// how many options the question happens to offer.
const tally = (counts = {}) =>
  Object.fromEntries(OPTION_KEYS.map((key) => [key, counts[key] ?? 0]));

const HOME = "https://images.example";

function fakeImages({ removeFails = false } = {}) {
  const puts = [];
  const removed = [];
  return {
    puts,
    removed,
    kind: "fake",
    async ready() {
      return true;
    },
    async put({ key, bytes }) {
      puts.push({ key, size: bytes.length });
      return `${HOME}/${key}`;
    },
    async remove(key) {
      if (removeFails) throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" });
      removed.push(key);
    },
    keyOf(url) {
      if (typeof url !== "string" || !url.startsWith(`${HOME}/questions/`)) return null;
      return url.slice(HOME.length + 1);
    },
  };
}

function harness(images = fakeImages(), store = createMemoryStore()) {
  const router = createRouter({
    store,
    defaults: QUESTIONS,
    adminKey: KEY,
    images,
  });
  return {
    images,
    router,
    content: () => router({ method: "GET", path: "/content", now: NOW }),
    saveContent: (qIndex, question) =>
      router({
        method: "POST",
        path: "/admin/content",
        body: { key: KEY, qIndex, question },
        now: NOW,
      }),
    setImageScale: (qIndex, imageScale, key = KEY) =>
      router({
        method: "POST",
        path: "/admin/image-scale",
        body: { key, qIndex, imageScale },
        now: NOW,
      }),
    upload: (qIndex, kind, contentType, data, option) =>
      router({
        method: "POST",
        path: "/admin/upload",
        body: { key: KEY, qIndex, kind, option, contentType, data },
        now: NOW,
      }),
    state: (now = NOW, query = {}) => router({ method: "GET", path: "/state", query, now }),
    admin: (action, now = NOW, extra = {}) =>
      router({ method: "POST", path: "/admin", body: { key: KEY, action, ...extra }, now }),
    vote: (voterId, choice, now = NOW, qIndex = 0) =>
      router({ method: "POST", path: "/vote", body: { voterId, qIndex, choice }, now }),
    join: (voterId, now = NOW) => router({ method: "POST", path: "/join", body: { voterId }, now }),
  };
}

test("/state shows the live counts from the moment voting opens, and never an answer", async () => {
  const api = harness();

  // Nothing to count before the game starts, and saying so is what keeps this
  // a gate rather than a formality.
  const lobby = await api.state();
  assert.equal(lobby.body.tally, null, "no tally in the lobby");
  assert.equal("answer" in lobby.body, false, "and no answer field, because there is no answer");

  await api.admin("START");
  await api.vote("voter-aaaa", "a");

  const voting = await api.state();
  assert.deepEqual(voting.body.tally, tally({ a: 1 }), "the room can watch itself split");
  assert.equal(voting.body.results, null);
  assert.equal("answer" in voting.body, false);
  assert.equal(voting.body.phaseEndsAt, NOW + 40_000);

  // Real time means the next poll carries the next vote, not a snapshot.
  await api.vote("voter-bbbb", "b");
  assert.deepEqual((await api.state()).body.tally, tally({ a: 1, b: 1 }));

  await api.admin("LOCK");
  const locked = await api.state();
  assert.deepEqual(locked.body.tally, tally({ a: 1, b: 1 }), "closing the vote hides nothing");
  assert.equal("answer" in locked.body, false);

  await api.admin("REVEAL");
  const reveal = await api.state();
  assert.deepEqual(reveal.body.tally, tally({ a: 1, b: 1 }));
  assert.equal(reveal.body.results, null);
  assert.equal("answer" in reveal.body, false, "counts only — no key is marked as the right one");
});

test("the operator console sees the tally in every phase, and it alone sees `admin`", async () => {
  const api = harness();
  await api.admin("START");
  await api.vote("voter-aaaa", "b");

  const console_ = await api.state(NOW, { k: KEY });
  assert.deepEqual(console_.body.tally, tally({ b: 1 }));
  assert.equal(console_.body.admin.canUndo, true);

  // Counts are public while a question is open, so a wrong key still gets
  // them — what it does not get is the block carrying the per-question
  // settings, which is how the console knows its key was refused.
  const wrongKey = await api.state(NOW, { k: "nope" });
  assert.deepEqual(wrongKey.body.tally, tally({ b: 1 }));
  assert.equal(wrongKey.body.admin, undefined);

  // The operator still sees a tally before the first question opens, which is
  // the one thing `|| isAdmin` is still there for.
  await api.admin("RESET");
  assert.deepEqual((await api.state(NOW, { k: KEY })).body.tally, tally());
  assert.equal((await api.state()).body.tally, null, "…and the room does not");
});

test("votes are rejected outside VOTING, after the cutoff, and twice", async () => {
  const api = harness();

  const early = await api.vote("voter-aaaa", "a");
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "WRONG_PHASE");

  await api.admin("START");

  const wrongQuestion = await api.vote("voter-aaaa", "a", NOW, 1);
  assert.equal(wrongQuestion.body.error, "WRONG_PHASE");

  assert.equal((await api.vote("voter-aaaa", "a")).status, 200);

  const again = await api.vote("voter-aaaa", "b");
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "ALREADY_VOTED");

  const grace = await api.vote("voter-bbbb", "a", NOW + 44_000);
  assert.equal(grace.status, 200, "5s of network-jitter grace past the deadline");

  const late = await api.vote("voter-cccc", "a", NOW + 46_000);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "EXPIRED");

  // Six keys exist, but nothing outside them is a choice.
  assert.equal((await api.vote("voter-dddd", "g")).status, 400);
  assert.equal((await api.vote("voter-dddd", "")).status, 400);
});

test("dedup is per question — the same voter votes again on the next one", async () => {
  const api = harness();
  await api.admin("START");
  await api.vote("voter-aaaa", "a");
  await api.admin("LOCK");
  await api.admin("REVEAL");
  await api.admin("NEXT");
  await api.admin("START");

  assert.equal((await api.vote("voter-aaaa", "b", NOW, 1)).status, 200);
});

test("/join counts each voterId once", async () => {
  const api = harness();
  assert.equal((await api.join("voter-aaaa")).body.created, true);
  assert.equal((await api.join("voter-aaaa")).body.created, false);
  await api.join("voter-bbbb");
  assert.equal((await api.state()).body.joined, 2);
});

test("FINAL returns every question's tally, with nothing marked as right", async () => {
  const api = harness();
  await api.admin("START");
  // One vote, on the first question only, so the two rows cannot be mistaken
  // for each other.
  await api.vote("voter-aaaa", "b");
  for (const action of ["LOCK", "REVEAL", "NEXT", "START", "LOCK", "REVEAL", "NEXT"]) {
    await api.admin(action);
  }
  const final = await api.state();
  assert.equal(final.body.phase, "FINAL");
  assert.equal(final.body.tally, null, "one question's tally gives way to the recap of all");
  // deepEqual is strict about keys, so this is also the assertion that no
  // row carries an `answer`.
  assert.deepEqual(final.body.results, [
    { qIndex: 0, ...tally({ b: 1 }) },
    { qIndex: 1, ...tally() },
  ]);

  // The operator gets the same recap and the same absence of a tally.
  const console_ = await api.state(NOW, { k: KEY });
  assert.equal(console_.body.tally, null);
  assert.deepEqual(console_.body.results, final.body.results);
});

test("/content starts empty and returns what was saved", async () => {
  const api = harness();
  // Never null: an unauthored question still has to say which question it is,
  // because that is what clients align their bundled copy against.
  assert.deepEqual((await api.content()).body.questions, [
    { id: "q1", duration: 40 },
    { id: "q2", duration: 45 },
  ]);

  const saved = await api.saveContent(1, {
    title: "这样恋爱可不可以？",
    body: "要判断的那段文字",
    image: "https://images.example/a.jpg",
  });
  assert.equal(saved.status, 200);

  const { questions } = (await api.content()).body;
  assert.equal(questions[0].title, undefined, "other questions are untouched");
  assert.equal(questions[1].title, "这样恋爱可不可以？");
  assert.equal(questions[1].body, "要判断的那段文字");
  assert.equal(questions[1].image, "https://images.example/a.jpg");
});

test("/content carries only whitelisted fields — every phone fetches it unauthenticated", async () => {
  const api = harness();
  // Even if something tries to smuggle it through, the whitelist drops it.
  await api.saveContent(0, { title: "t", body: "b", answer: "a", isAi: true });

  const { questions } = (await api.content()).body;
  assert.deepEqual(Object.keys(questions[0]).sort(), [
    "audio",
    "body",
    "bodyAlign",
    "bodyPlace",
    "bodySize",
    "duration",
    "id",
    "image",
    "imageScale",
    "title",
    "topic",
    "video",
  ]);
});

test("audio uploads are allowed, with their own much larger ceiling", async () => {
  const api = harness();
  const clip = Buffer.alloc(3_000_000).toString("base64"); // 3MB — fine for audio

  const ok = await api.upload(0, "audio", "audio/mpeg", clip);
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /questions\/q0-audio-\w+\.mp3$/);

  // The same bytes are far too big for a picture.
  assert.equal((await api.upload(0, "image", "image/jpeg", clip)).body.error, "MEDIA_TOO_LARGE");
  // And an image type is not valid audio.
  assert.equal((await api.upload(0, "audio", "image/jpeg", clip)).body.error, "BAD_CONTENT_TYPE");
});

test("video uploads are allowed, with the largest ceiling of the three", async () => {
  const api = harness();
  // 8MB — over the audio cap, comfortably inside the video one.
  const clip = Buffer.alloc(8_000_000).toString("base64");

  const ok = await api.upload(0, "video", "video/mp4", clip);
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /questions\/q0-video-\w+\.mp4$/);

  // What an iPhone hands over, and the reason quicktime is on the list.
  assert.equal((await api.upload(0, "video", "video/quicktime", clip)).status, 200);

  // The same bytes are far too big to be a voice clip.
  assert.equal((await api.upload(0, "audio", "audio/mpeg", clip)).body.error, "MEDIA_TOO_LARGE");
  // And an audio type is not valid video.
  assert.equal((await api.upload(0, "video", "audio/mpeg", clip)).body.error, "BAD_CONTENT_TYPE");

  const huge = Buffer.alloc(40_000_001).toString("base64");
  assert.equal((await api.upload(0, "video", "video/mp4", huge)).body.error, "MEDIA_TOO_LARGE");
});

test("uploads store bytes and hand back a url", async () => {
  const api = harness();
  const data = Buffer.from("not-really-a-jpeg").toString("base64");

  const res = await api.upload(0, "image", "image/jpeg", data);
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^https:\/\/images\.example\/questions\/q0-image-\w+\.jpg$/);
  assert.equal(api.images.puts.length, 1);
  assert.equal(api.images.puts[0].size, "not-really-a-jpeg".length);
});

test("uploads reject bad types, oversized files and bad targets", async () => {
  const api = harness();
  const small = Buffer.from("x").toString("base64");

  assert.equal((await api.upload(0, "image", "image/gif", small)).body.error, "BAD_CONTENT_TYPE");
  assert.equal((await api.upload(0, "slides", "image/jpeg", small)).body.error, "BAD_KIND");
  assert.equal((await api.upload(9, "image", "image/jpeg", small)).body.error, "BAD_Q_INDEX");
  assert.equal((await api.upload(0, "image", "image/jpeg", "")).body.error, "BAD_MEDIA_DATA");

  const huge = Buffer.alloc(1_500_001).toString("base64");
  assert.equal((await api.upload(0, "image", "image/jpeg", huge)).body.error, "MEDIA_TOO_LARGE");
  assert.equal(api.images.puts.length, 0, "nothing reached storage");
});

test("content endpoints require the key, and uploads can be disabled", async () => {
  const api = harness(null);
  const unauth = await api.router({
    method: "POST",
    path: "/admin/content",
    body: { key: "guess", qIndex: 0, question: {} },
    now: NOW,
  });
  assert.equal(unauth.status, 401);

  const disabled = await api.upload(0, "image", "image/jpeg", Buffer.from("x").toString("base64"));
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error, "UPLOADS_DISABLED");
});

test("RESET clears the votes but keeps the uploaded content", async () => {
  const api = harness();
  await api.saveContent(0, { title: "留着", image: "https://images.example/x.jpg" });
  await api.admin("START");
  await api.vote("voter-aaaa", "a");

  await api.admin("RESET");

  const state = await api.state(NOW, { k: KEY });
  assert.equal(state.body.phase, "LOBBY");
  assert.deepEqual(state.body.tally, tally());

  const { questions } = (await api.content()).body;
  assert.equal(questions[0].image, "https://images.example/x.jpg");
});

test("contentVersion changes on every save, so open clients refetch /content", async () => {
  const api = harness();

  const before = (await api.state()).body.contentVersion;
  assert.equal(typeof before, "number");

  await api.saveContent(0, { title: "第一版" });
  const afterFirst = (await api.state()).body.contentVersion;
  assert.notEqual(afterFirst, before, "a save must be visible to an already-open projector");

  // Two saves in a row must not land on the same value: a client that saw the
  // first would never fetch the second.
  await api.saveContent(1, { title: "另一题" });
  assert.notEqual((await api.state()).body.contentVersion, afterFirst);

  // Unauthenticated clients are the ones that need this most — every phone and
  // the projector read /state without a key.
  assert.equal(
    (await api.state(NOW, { k: KEY })).body.contentVersion,
    (await api.state()).body.contentVersion,
  );
});

test("RESET keeps contentVersion, so it does not stampede every client to /content", async () => {
  const api = harness();
  await api.saveContent(0, { title: "留着" });

  const before = (await api.state()).body.contentVersion;
  await api.admin("RESET");

  assert.equal((await api.state()).body.contentVersion, before);
});

// The question list stopped being whatever deck.json shipped with. These are
// the tests that say a question keeps its own text and its own countdown when
// the deck changes shape underneath it.
const questions = (api, action, qIndex) =>
  api.router({
    method: "POST",
    path: "/admin/questions",
    body: { key: KEY, action, qIndex },
    now: NOW,
  });

test("deleting a question in the middle leaves every other one with its own text and countdown", async () => {
  const api = harness();
  await questions(api, "ADD"); // a third, so there is a middle to delete

  const meta = (qIndex, patch) =>
    api.router({
      method: "POST",
      path: "/admin/meta",
      body: { key: KEY, qIndex, ...patch },
      now: NOW,
    });

  for (const [i, title] of ["第一题", "第二题", "第三题"].entries()) {
    await api.saveContent(i, { title });
    await meta(i, { duration: 20 + i });
  }

  const deleted = await questions(api, "DELETE", 1);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.questionCount, 2);

  // The headline: content and countdowns stayed with their questions rather
  // than shifting one place left into somebody else's.
  assert.deepEqual(
    (await api.content()).body.questions.map((q) => q.title),
    ["第一题", "第三题"],
  );
  assert.deepEqual(
    (await api.state(NOW, { k: KEY })).body.admin.questions.map((q) => q.duration),
    [20, 22],
  );
});

test("a question added during the show gets a neutral countdown, and can be given its own", async () => {
  const api = harness();
  const added = await questions(api, "ADD");

  assert.equal(added.status, 200);
  assert.equal(added.body.questionCount, 3);

  const [, , fresh] = added.body.admin.questions;
  assert.equal(fresh.duration, 45, "a neutral countdown, since deck.json has no row for it");
  assert.match(fresh.id, /^q-s/);
  assert.deepEqual(
    Object.keys(fresh).sort(),
    ["duration", "id", "overridden"],
    "a countdown and an identity are all a question has on the authenticated side",
  );

  const set = await api.router({
    method: "POST",
    path: "/admin/meta",
    body: { key: KEY, qIndex: 2, duration: 20 },
    now: NOW,
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.admin.questions[2].duration, 20);

  // And it is a real question: it can be authored, run and voted on.
  await api.saveContent(2, { title: "临时加的" });
  assert.equal((await api.content()).body.questions[2].title, "临时加的");
  assert.equal((await api.state()).body.questionCount, 3);
});

test("the deck can only change shape in the lobby", async () => {
  const api = harness();
  await api.admin("START");

  for (const action of ["ADD", "DELETE"]) {
    const res = await questions(api, action, 1);
    assert.equal(res.status, 409, action);
    assert.equal(res.body.error, "WRONG_PHASE");
  }
});

test("a question is not deleted out from under votes already cast behind it", async () => {
  const api = harness();
  await api.admin("START");
  await api.vote("voter-aaaa", "a");
  await api.admin("LOCK");
  await api.admin("REVEAL");
  await api.admin("NEXT");
  await api.admin("RESET"); // back to the lobby, but the tally is gone with it

  // Nothing has been voted on since the reset, so this is allowed.
  assert.equal((await questions(api, "DELETE", 0)).status, 200);
  assert.equal((await api.state()).body.questionCount, 1);
});

test("deleting is refused while a question at or after it holds votes", async () => {
  // Votes and the lobby cannot coexist through the console — RESET is the only
  // way back to LOBBY and it clears the tallies. They can coexist through a
  // race: a vote in flight when RESET lands is recorded against a game that has
  // just been wiped. That is what this guard is for, so this drives the store
  // directly rather than pretending the console can produce it.
  const store = createMemoryStore();
  const api = harness(fakeImages(), store);
  await questions(api, "ADD"); // three, so there is something on each side
  await store.recordVote({ qIndex: 1, voterId: "voter-aaaa", choice: "a", now: NOW });

  for (const qIndex of [0, 1]) {
    const refused = await questions(api, "DELETE", qIndex);
    assert.equal(refused.status, 409, `deleting ${qIndex}`);
    // 0 would shift question 2's votes onto question 1; 1 would hand its own
    // votes to whatever moves up into its place.
    assert.equal(refused.body.error, "VOTES_EXIST");
  }

  // Nothing at or after question 3 has been voted on, so that one is allowed.
  assert.equal((await questions(api, "DELETE", 2)).status, 200);

  // And RESET is the way out that the setup page's wording points at.
  await api.admin("RESET");
  assert.equal((await questions(api, "DELETE", 1)).status, 200);
});

test("the last question cannot be deleted, and the deck has a ceiling", async () => {
  const api = harness();
  assert.equal((await questions(api, "DELETE", 0)).status, 200);

  const last = await questions(api, "DELETE", 0);
  assert.equal(last.status, 400);
  assert.equal(last.body.error, "LAST_QUESTION");

  // 40 is not an aesthetic limit: it is what one DynamoDB BatchGetItem can
  // address in a single call.
  for (let i = 1; i < 40; i++) assert.equal((await questions(api, "ADD")).status, 200);
  const tooMany = await questions(api, "ADD");
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, "TOO_MANY_QUESTIONS");
});

test("the deck survives RESET, and unknown actions are refused", async () => {
  const api = harness();
  await questions(api, "ADD");
  await api.saveContent(2, { title: "加的这题" });

  await api.admin("RESET");

  assert.equal((await api.state()).body.questionCount, 3, "a reset clears votes, not questions");
  assert.equal((await api.content()).body.questions[2].title, "加的这题");
  assert.equal((await questions(api, "SHUFFLE")).body.error, "UNKNOWN_ACTION");
});

test("a deleted question's media goes with it", async () => {
  const api = harness();
  await api.saveContent(0, { title: "t", image: `${HOME}/questions/q0-image-gone.jpg` });

  await questions(api, "DELETE", 0);
  assert.deepEqual(api.images.removed, ["questions/q0-image-gone.jpg"]);
});

test("/admin/questions is registered for dispatch, and requires the key", async () => {
  const api = harness();
  assert.ok(API_ROUTES.has("POST /admin/questions"));

  const res = await api.router({
    method: "POST",
    path: "/admin/questions",
    body: { key: "guess", action: "ADD" },
    now: NOW,
  });
  assert.equal(res.status, 401);
});

test("/admin requires the key", async () => {
  const router = createRouter({ store: createMemoryStore(), defaults: QUESTIONS, adminKey: KEY });
  const res = await router({
    method: "POST",
    path: "/admin",
    body: { key: "guess", action: "START" },
    now: NOW,
  });
  assert.equal(res.status, 401);
});

test("/content says only what was authored, and `admin` never reaches an unauthenticated /state", async () => {
  const api = harness();

  // /content is unauthenticated, so what it says about a question nobody has
  // written yet is pinned exactly.
  const { questions } = (await api.content()).body;
  assert.deepEqual(
    questions[0],
    { id: "q1", duration: 40 },
    "nothing was authored, so identity and countdown are all there is to say",
  );

  await api.saveContent(0, { title: "t", body: "b" });
  const after = (await api.content()).body.questions[0];
  assert.deepEqual(Object.keys(after).sort(), [
    "audio",
    "body",
    "bodyAlign",
    "bodyPlace",
    "bodySize",
    "duration",
    "id",
    "image",
    "imageScale",
    "title",
    "topic",
    "video",
  ]);

  // And an unauthenticated /state must not carry the per-question settings.
  const anon = await api.state();
  assert.equal(anon.body.admin, undefined);
});

test("the body's position is saved with the text it positions", async () => {
  const api = harness();

  const saved = await api.saveContent(0, {
    title: "t",
    body: "b",
    bodyPlace: "over",
    bodyAlign: "start",
    bodySize: 1.4,
  });
  assert.equal(saved.status, 200);

  const [question] = (await api.content()).body.questions;
  assert.equal(question.bodyPlace, "over");
  assert.equal(question.bodyAlign, "start");
  assert.equal(question.bodySize, 1.4);
});

test("a question that has never been positioned reads as the old rendering", async () => {
  const api = harness();

  // No layout fields at all — every client that predates this feature saves
  // exactly this shape, and the defaults are what it used to draw.
  await api.saveContent(0, { title: "t", body: "b" });

  const [question] = (await api.content()).body.questions;
  assert.equal(question.bodyPlace, "below");
  assert.equal(question.bodyAlign, "center");
  assert.equal(question.bodySize, 1);
});

test("a nonsense position is coerced, never stored and never rejected", async () => {
  const api = harness();

  // Unlike imageScale, these ride the same save as the body text, so a bad
  // value must not cost the operator their edit. It falls back instead.
  const saved = await api.saveContent(0, {
    title: "t",
    body: "b",
    bodyPlace: "diagonally",
    bodyAlign: "../../etc",
    bodySize: 99,
  });
  assert.equal(saved.status, 200, "the text still saved");

  const [question] = (await api.content()).body.questions;
  assert.equal(question.bodyPlace, "below");
  assert.equal(question.bodyAlign, "center");
  assert.equal(question.bodySize, 1);
  assert.equal(question.body, "b", "and the text it came with survived");
});

test("dragging the image scale does not reset the body position", async () => {
  const api = harness();
  await api.saveContent(0, { title: "t", body: "b", bodyPlace: "above", bodySize: 0.8 });

  const scaled = await api.router({
    method: "POST",
    path: "/admin/image-scale",
    body: { key: KEY, qIndex: 0, imageScale: 1.6 },
    now: NOW,
  });
  assert.equal(scaled.status, 200);

  // /screen writes the scale alone and knows nothing about the layout. The
  // read-modify-write has to carry it forward.
  const [question] = (await api.content()).body.questions;
  assert.equal(question.imageScale, 1.6);
  assert.equal(question.bodyPlace, "above");
  assert.equal(question.bodySize, 0.8);
});

test("options are saved with the content, and a field nobody whitelisted is dropped from them", async () => {
  const api = harness();

  const saved = await api.saveContent(0, {
    title: "谁写的？",
    options: [
      { key: "a", icon: "🤖", label: "AI" },
      { key: "b", icon: "🙋", label: "人类" },
      // Whatever a client marks as correct is dropped: /content is what every
      // phone fetches unauthenticated.
      { key: "c", icon: "🧑‍🎨", label: "实习生", correct: true, answer: true },
    ],
  });
  assert.equal(saved.status, 200);

  const [question] = (await api.content()).body.questions;
  assert.deepEqual(question.options, [
    { key: "a", label: "AI", icon: "🤖" },
    { key: "b", label: "人类", icon: "🙋" },
    { key: "c", label: "实习生", icon: "🧑‍🎨" },
  ]);
});

test("an option carries its own picture, clip and video, and nothing it was not asked for", async () => {
  const api = harness();

  const saved = await api.saveContent(0, {
    title: "哪个是真的？",
    options: [
      { key: "a", icon: "1️⃣", label: "左边", image: "https://images.example/questions/q0a-1.jpg" },
      {
        key: "b",
        icon: "2️⃣",
        label: "右边",
        audio: "https://images.example/questions/q0b-1.mp3",
        video: "https://images.example/questions/q0b-2.mp4",
        correct: true,
      },
    ],
  });
  assert.equal(saved.status, 200);

  const [question] = (await api.content()).body.questions;
  assert.deepEqual(question.options, [
    { key: "a", label: "左边", icon: "1️⃣", image: "https://images.example/questions/q0a-1.jpg" },
    {
      key: "b",
      label: "右边",
      icon: "2️⃣",
      audio: "https://images.example/questions/q0b-1.mp3",
      video: "https://images.example/questions/q0b-2.mp4",
    },
  ]);
});

test("an option list written before per-option media round-trips unchanged", async () => {
  const api = harness();
  const before = [
    { key: "a", label: "AI", icon: "🤖" },
    { key: "b", label: "人类", icon: "🙋" },
  ];

  await api.saveContent(0, { title: "t", options: before });
  const [question] = (await api.content()).body.questions;

  // Byte-identical, not merely equivalent: empty media must be omitted rather
  // than stored as "", or every phone in the room fetches six options' worth of
  // empty strings on every question.
  assert.equal(JSON.stringify(question.options), JSON.stringify(before));
});

test("a bad option media url is truncated, never enough to refuse the labels beside it", async () => {
  const api = harness();
  const long = `https://images.example/${"x".repeat(600)}.jpg`;

  const saved = await api.saveContent(0, {
    title: "t",
    options: [
      { key: "a", label: "A", image: long },
      { key: "b", label: "B", image: 42 },
    ],
  });
  assert.equal(saved.status, 200, "a bad url costs a picture; a bad label costs a button");

  const [question] = (await api.content()).body.questions;
  assert.equal(question.options[0].image.length, 500);
  assert.equal(
    question.options[1].image,
    undefined,
    "a non-string url is dropped, not stringified",
  );
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["A", "B"],
  );
});

test("an upload can target one option, and only a real option key", async () => {
  const api = harness();
  const data = Buffer.from("not-really-a-jpeg").toString("base64");

  const res = await api.upload(0, "image", "image/jpeg", data, "c");
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^https:\/\/images\.example\/questions\/q0c-image-\w+\.jpg$/);

  // The one caller-controlled string that reaches an object key.
  for (const option of ["z", "../evil", "", 1, { key: "a" }]) {
    const bad = await api.upload(0, "image", "image/jpeg", data, option);
    assert.equal(bad.body.error, "BAD_OPTION_KEY", `option ${JSON.stringify(option)}`);
  }
  assert.equal(api.images.puts.length, 1, "nothing else reached storage");
});

const q = (i, kind, n) => `${HOME}/questions/q${i}-${kind}-${n}.jpg`;

test("移除 deletes the object, and 更换 deletes the one it replaced", async () => {
  const api = harness();

  await api.saveContent(0, { title: "t", image: q(0, "image", "one") });
  assert.deepEqual(api.images.removed, [], "nothing to delete on the first save");

  // 更换: the same field, a different file.
  await api.saveContent(0, { title: "t", image: q(0, "image", "two") });
  assert.deepEqual(api.images.removed, ["questions/q0-image-one.jpg"]);

  // 移除: the field goes empty.
  await api.saveContent(0, { title: "t", image: "" });
  assert.deepEqual(api.images.removed, [
    "questions/q0-image-one.jpg",
    "questions/q0-image-two.jpg",
  ]);
});

test("option media is swept on the same rules as the question's own", async () => {
  const api = harness();
  const withPicture = (url) => ({
    title: "t",
    options: [
      { key: "a", label: "A", image: url },
      { key: "b", label: "B" },
    ],
  });

  await api.saveContent(0, withPicture(q(0, "image", "opt")));
  await api.saveContent(0, withPicture(""));
  assert.deepEqual(api.images.removed, ["questions/q0-image-opt.jpg"]);
});

test("a file another question still uses is never deleted", async () => {
  const api = harness();
  const shared = q(0, "image", "shared");

  // What 复制到全部 leaves behind: one url on every question in the deck.
  const options = (image) => [
    { key: "a", label: "A", image },
    { key: "b", label: "B" },
  ];
  await api.saveContent(0, { title: "t", options: options(shared) });
  await api.saveContent(1, { title: "t", options: options(shared) });

  await api.saveContent(0, { title: "t", options: options("") });
  assert.deepEqual(api.images.removed, [], "question 2 is still showing it");

  await api.saveContent(1, { title: "t", options: options("") });
  assert.deepEqual(api.images.removed, ["questions/q0-image-shared.jpg"], "now nobody is");
});

test("a file another option of the same question still uses is never deleted", async () => {
  const api = harness();
  const shared = q(0, "image", "twice");
  const both = (aImage) => ({
    title: "t",
    options: [
      { key: "a", label: "A", image: aImage },
      { key: "b", label: "B", image: shared },
    ],
  });

  await api.saveContent(0, both(shared));
  await api.saveContent(0, both(""));
  assert.deepEqual(api.images.removed, [], "option B still has it");
});

test("a delete that fails still clears the reference and still returns 200", async () => {
  // Every delete looks like this until the IAM policy is widened.
  const api = harness(fakeImages({ removeFails: true }));

  await api.saveContent(0, { title: "t", image: q(0, "image", "one") });
  const res = await api.saveContent(0, { title: "t", image: "" });

  assert.equal(res.status, 200);
  assert.equal(res.body.mediaFailed, 1);
  assert.equal(res.body.mediaDeleted, 0);
  assert.equal(
    (await api.content()).body.questions[0].image,
    "",
    "the picture is off the question",
  );
});

test("a url that is not ours is never handed to the storage adapter", async () => {
  const api = harness();

  // Nothing writes these, but a content record is a store record: this is the
  // check that keeps a delete path from being a way to reach into somebody
  // else's bucket.
  await api.saveContent(0, { title: "t", image: "https://elsewhere.example/questions/x.jpg" });
  await api.saveContent(0, { title: "t", image: "" });
  assert.deepEqual(api.images.removed, []);
});

test("a malformed option list is refused rather than silently shortened", async () => {
  const api = harness();
  const options = (list) => api.saveContent(0, { title: "t", options: list });

  assert.equal((await options([{ key: "a", label: "只有一个" }])).body.error, "BAD_OPTIONS");
  assert.equal(
    (await options(OPTION_KEYS.concat("g").map((key) => ({ key, label: key })))).body.error,
    "BAD_OPTIONS",
    "past the end of the key space",
  );
  assert.equal(
    (
      await options([
        { key: "a", label: "A" },
        { key: "a", label: "又是 A" },
      ])
    ).body.error,
    "BAD_OPTIONS",
    "two options counting under one key",
  );
  assert.equal(
    (
      await options([
        { key: "a", label: "A" },
        { key: "z", label: "Z" },
      ])
    ).body.error,
    "BAD_OPTIONS",
  );
  assert.equal(
    (
      await options([
        { key: "a", label: "A" },
        { key: "b", label: "   " },
      ])
    ).body.error,
    "BAD_OPTIONS",
    "a blank button is a button nobody can read",
  );

  // Not editing the options at all leaves the saved ones alone.
  await options([
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ]);
  await api.saveContent(0, { title: "只改标题" });
  assert.equal((await api.content()).body.questions[0].options.length, 2);
});

test("a vote for any offered key is counted, and no key can be marked as the answer", async () => {
  const api = harness();
  await api.saveContent(0, {
    title: "t",
    options: OPTION_KEYS.slice(0, 4).map((key) => ({ key, label: key.toUpperCase() })),
  });

  const meta = (patch) =>
    api.router({
      method: "POST",
      path: "/admin/meta",
      body: { key: KEY, qIndex: 0, ...patch },
      now: NOW,
    });

  // The quiz this was cloned from took the correct option here. There is not
  // one any more, so a body that names only an answer has nothing to set — and
  // is told so, rather than answered 200 for a field that was ignored.
  const refused = await meta({ answer: "d" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "NOTHING_TO_SET");
  assert.equal((await meta({ isAi: true })).body.error, "NOTHING_TO_SET");

  await api.admin("START");
  assert.equal((await api.vote("voter-aaaa", "d")).status, 200);
  assert.equal((await api.vote("voter-bbbb", "c")).status, 200);
  await api.admin("LOCK");
  await api.admin("REVEAL");

  const reveal = await api.state();
  assert.deepEqual(reveal.body.tally, tally({ c: 1, d: 1 }), "the third and fourth keys count");
});

test("duration overrides drive the countdown, and are range-checked", async () => {
  const api = harness();
  const meta = (qIndex, patch) =>
    api.router({
      method: "POST",
      path: "/admin/meta",
      body: { key: KEY, qIndex, ...patch },
      now: NOW,
    });

  assert.equal((await meta(0, { duration: 4 })).body.error, "BAD_DURATION");
  assert.equal((await meta(0, { duration: 601 })).body.error, "BAD_DURATION");
  assert.equal((await meta(0, {})).body.error, "NOTHING_TO_SET");

  await meta(0, { duration: 20 });
  await api.admin("START");
  // q1 ships as 40s; the override wins.
  assert.equal((await api.state()).body.phaseEndsAt, NOW + 20_000);
});

test("RESET clears votes but keeps duration overrides", async () => {
  const api = harness();
  await api.router({
    method: "POST",
    path: "/admin/meta",
    body: { key: KEY, qIndex: 0, duration: 25 },
    now: NOW,
  });
  await api.admin("START");
  await api.vote("voter-aaaa", "a");
  await api.admin("RESET");

  const after = await api.state(NOW, { k: KEY });
  assert.equal(after.body.phase, "LOBBY");
  // The whole entry, so this also pins its shape: an id, a countdown, and
  // whether the setup page has touched it.
  assert.deepEqual(after.body.admin.questions[0], {
    id: "q1",
    duration: 25,
    overridden: true,
  });
});

test("every route the router answers is registered for dispatch", async () => {
  // server.js dispatches on this exact set, so a route added to the handler
  // chain but missing here 404s in production while these tests still pass.
  // That has happened once; this pins it.
  const api = harness();
  for (const route of API_ROUTES) {
    const [method, path] = route.split(" ");
    const res = await api.router({ method, path, body: { key: KEY }, now: NOW });
    assert.notEqual(res.status, 404, `${route} is registered but the router 404s it`);
  }
});

test("RESET stamps a new epoch, and nothing else changes it", async () => {
  const api = harness();

  const fresh = (await api.state()).body.epoch;
  assert.equal(fresh, 0, "a game that has never been reset has no epoch");

  await api.admin("RESET", NOW);
  const first = (await api.state()).body.epoch;
  assert.equal(first, NOW);

  // Running the game must not look like a new round to a phone.
  for (const action of ["START", "LOCK", "REVEAL", "NEXT"]) {
    await api.admin(action, NOW + 1000);
    assert.equal((await api.state()).body.epoch, first, `${action} changed the epoch`);
  }

  await api.admin("RESET", NOW + 9999);
  assert.equal((await api.state()).body.epoch, NOW + 9999, "a second reset is a new round");
});

test("RESET leaves a usable game, not a wiped one", async () => {
  // The epoch is written by re-seeding state after the wipe; if that write
  // failed the game would come back with no state item at all.
  const api = harness();
  await api.admin("START");
  await api.vote("voter-aaaa", "a");
  await api.admin("RESET", NOW + 500);

  const after = await api.state(NOW + 500, { k: KEY });
  assert.equal(after.body.phase, "LOBBY");
  assert.equal(after.body.qIndex, 0);
  assert.deepEqual(after.body.tally, tally());
  assert.equal(after.body.joined, 0);

  // And it can still be driven.
  assert.equal((await api.admin("START", NOW + 600)).status, 200);
  assert.equal((await api.vote("voter-aaaa", "a", NOW + 700)).status, 200, "votes work again");
});

test("TOGGLE_RULES is carried on the unauthenticated /state, LOBBY only", async () => {
  const api = harness();

  assert.equal((await api.state()).body.showRules, false, "off by default");

  const shown = await api.admin("TOGGLE_RULES");
  assert.equal(shown.status, 200);
  // The projector fetches /state with no ?k= — this must be visible there.
  assert.equal((await api.state()).body.showRules, true);

  await api.admin("START");
  const refused = await api.admin("TOGGLE_RULES");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "WRONG_PHASE");
  assert.equal((await api.state()).body.showRules, true, "the refused toggle changed nothing");
  assert.equal((await api.state()).body.phase, "VOTING", "and neither did it touch the phase");
});

test("RESET clears showRules along with everything else it wipes", async () => {
  const api = harness();
  await api.admin("TOGGLE_RULES");
  assert.equal((await api.state()).body.showRules, true);

  await api.admin("RESET");
  assert.equal((await api.state()).body.showRules, false);
});

// A minimal in-memory stand-in for a DynamoDB table, just capable enough to
// back the two commands getContent/putContent actually issue: BatchGetItem
// to read, UpdateItem with a `SET #json = :json` or `ADD #v :one` expression
// to write. Anything outside that shape throws, on purpose — a silent
// no-op would make a broken assumption here look like a passing test.
//
// This is what lets the imageScale tests below run the identical assertions
// against both stores: the fixture stands in for the table, not for
// store-dynamo.js itself, so the router-level behaviour under test is real.
function fakeDynamoTable() {
  const items = new Map();
  const itemKey = ({ PK, SK }) => `${PK.S} ${SK.S}`;

  return {
    items,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;

      if (name === "BatchGetItemCommand") {
        const [tableName, { Keys }] = Object.entries(input.RequestItems)[0];
        const found = Keys.map((key) => items.get(itemKey(key))).filter(Boolean);
        return { Responses: { [tableName]: found }, UnprocessedKeys: {} };
      }

      if (name === "UpdateItemCommand") {
        const { Key, UpdateExpression, ExpressionAttributeValues: v } = input;
        const k = itemKey(Key);
        if (UpdateExpression === "SET #json = :json") {
          items.set(k, { ...Key, json: v[":json"] });
        } else if (UpdateExpression === "ADD #v :one") {
          const current = Number(items.get(k)?.v?.N ?? 0);
          items.set(k, { ...Key, v: { N: String(current + Number(v[":one"].N)) } });
        } else {
          throw new Error(`fakeDynamoTable does not support UpdateExpression: ${UpdateExpression}`);
        }
        return {};
      }

      throw new Error(`fakeDynamoTable does not support command: ${name}`);
    },
  };
}

// The rolling-deploy risk named in #34: two image versions run for 30-90
// seconds, and the old one never wrote `gamePausedMs` or `gameDurationMs` at
// all. Built by hand rather than through putState, because putState is what
// the *new* code writes — this reaches into the fake table directly to plant
// exactly the shape the *old* code left behind.
test("a state item written before this change reads back as an idle clock at the default length", async () => {
  const table = fakeDynamoTable();
  table.items.set("game#1 state", {
    PK: { S: "game#1" },
    SK: { S: "state" },
    phase: { S: "VOTING" },
    qIndex: { N: "0" },
    phaseEndsAt: { N: "1700000040000" },
    gameEndsAt: { NULL: true },
    replayAt: { N: "0" },
    epoch: { N: "0" },
    history: { L: [] },
    updatedAt: { N: "1700000000000" },
  });
  const store = createDynamoStore({ tableName: "test-table", client: table });

  const state = await store.getState();
  assert.equal(state.gameEndsAt, null);
  assert.equal(state.gamePausedMs, null, "an absent attribute reads as idle, not a crash");
  assert.equal(
    state.gameDurationMs,
    GAME_DURATION_MS,
    "and the length defaults rather than reading NaN",
  );
  assert.equal(state.showRules, false, "an absent BOOL attribute reads as false, not a crash");
});

const STORES = [
  { name: "memory", make: () => createMemoryStore() },
  {
    name: "dynamo",
    make: () => createDynamoStore({ tableName: "test-table", client: fakeDynamoTable() }),
  },
];

for (const { name, make } of STORES) {
  test(`imageScale [${name}]: a question never resized omits the field, exactly like master today`, async () => {
    const api = harness(fakeImages(), make());
    // Identity and countdown, and nothing else — no scale until one is set.
    assert.deepEqual((await api.content()).body.questions, [
      { id: "q1", duration: 40 },
      { id: "q2", duration: 45 },
    ]);
  });

  test(`imageScale [${name}]: a valid write round-trips through GET /content`, async () => {
    const api = harness(fakeImages(), make());
    const res = await api.setImageScale(0, 1.8);
    assert.equal(res.status, 200);
    assert.equal(res.body.question.imageScale, 1.8);

    const { questions } = (await api.content()).body;
    assert.equal(questions[0].imageScale, 1.8);
    assert.equal(questions[1].imageScale, undefined, "the other question is untouched");
  });

  test(`imageScale [${name}]: invalid inputs are rejected and never stored`, async () => {
    const api = harness(fakeImages(), make());

    for (const bad of [0, -1, 99, NaN, null, "large", undefined]) {
      const res = await api.setImageScale(0, bad);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.body.error, "BAD_IMAGE_SCALE");
    }

    // None of the rejected attempts created a content record at all.
    assert.deepEqual((await api.content()).body.questions[0], { id: "q1", duration: 40 });
  });

  test(`imageScale [${name}]: an unauthenticated write is rejected and does not mutate stored state`, async () => {
    const api = harness(fakeImages(), make());
    await api.setImageScale(0, 1.8); // establish a known-good value

    const res = await api.setImageScale(0, 2.2, "wrong-key");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "UNAUTHORIZED");

    assert.equal((await api.content()).body.questions[0].imageScale, 1.8, "unchanged");
  });

  test(`imageScale [${name}]: a boundary value at each clamp edge is accepted`, async () => {
    const api = harness(fakeImages(), make());
    assert.equal((await api.setImageScale(0, 0.3)).status, 200);
    assert.equal((await api.content()).body.questions[0].imageScale, 0.3);

    assert.equal((await api.setImageScale(0, 2.5)).status, 200);
    assert.equal((await api.content()).body.questions[0].imageScale, 2.5);

    // Just outside either edge is rejected, not clamped onto the edge.
    assert.equal((await api.setImageScale(0, 0.29999)).status, 400);
    assert.equal((await api.setImageScale(0, 2.50001)).status, 400);
  });

  test(`imageScale [${name}]: editing a question's text does not reset its scale`, async () => {
    const api = harness(fakeImages(), make());
    await api.saveContent(0, { title: "原始标题", body: "原始正文" });
    await api.setImageScale(0, 1.8);

    const edited = await api.saveContent(0, { title: "修改后的标题", body: "原始正文" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.question.imageScale, 1.8, "the drag survives an unrelated text save");

    const { questions } = (await api.content()).body;
    assert.equal(questions[0].title, "修改后的标题");
    assert.equal(questions[0].imageScale, 1.8);
  });

  test(`imageScale [${name}]: setting the scale does not touch the question's other fields`, async () => {
    const api = harness(fakeImages(), make());
    await api.saveContent(0, {
      title: "标题",
      body: "正文",
      image: "https://images.example/a.jpg",
    });

    await api.setImageScale(0, 1.5);

    const question = (await api.content()).body.questions[0];
    assert.equal(question.title, "标题");
    assert.equal(question.body, "正文");
    assert.equal(question.image, "https://images.example/a.jpg");
    assert.equal(question.imageScale, 1.5);
  });

  test(`imageScale [${name}]: a bad qIndex is rejected before any store write`, async () => {
    const api = harness(fakeImages(), make());
    const res = await api.setImageScale(9, 1.5);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "BAD_Q_INDEX");
  });

  test(`imageScale [${name}]: content saved through /admin/content without a prior scale defaults to 1`, async () => {
    const api = harness(fakeImages(), make());
    await api.saveContent(0, { title: "t" });
    assert.equal((await api.content()).body.questions[0].imageScale, 1);
  });

  test(`imageScale [${name}]: /admin/image-scale is registered for dispatch`, async () => {
    const api = harness(fakeImages(), make());
    assert.ok(API_ROUTES.has("POST /admin/image-scale"));
    const res = await api.router({
      method: "POST",
      path: "/admin/image-scale",
      body: { key: KEY },
      now: NOW,
    });
    assert.notEqual(res.status, 404);
  });
}

test("the segment clock rides the unauthenticated state, idle until the operator starts it", async () => {
  const api = harness();
  assert.equal((await api.state()).body.gameEndsAt, null, "nothing before the operator starts it");
  assert.equal((await api.state()).body.gamePausedMs, null);
  assert.equal((await api.state()).body.gameDurationMs, 15 * 60_000, "default stays 15 minutes");

  // START no longer arms it — that is the whole point of this change.
  await api.admin("START");
  assert.equal(
    (await api.state()).body.gameEndsAt,
    null,
    "opening a question does not start the clock",
  );

  await api.admin("TIMER_START");
  assert.equal((await api.state()).body.gameEndsAt, NOW + 15 * 60_000);

  await api.admin("RESET");
  assert.equal((await api.state()).body.gameEndsAt, null, "a rehearsal starts the segment over");
});

test("TIMER_START / TIMER_PAUSE / TIMER_RESET over the wire, exactly as the operator would click them", async () => {
  const api = harness();

  const paused = await api.admin("TIMER_PAUSE");
  assert.equal(paused.status, 409, "nothing is running yet");
  assert.equal(paused.body.error, "TIMER_NOT_RUNNING");

  await api.admin("TIMER_START", NOW);
  const runningAgain = await api.admin("TIMER_START", NOW + 1000);
  assert.equal(runningAgain.status, 409, "a second start does not restart the clock");
  assert.equal(runningAgain.body.error, "TIMER_RUNNING");

  const elapsed = 90_000;
  await api.admin("TIMER_PAUSE", NOW + elapsed);
  assert.equal((await api.state()).body.gameEndsAt, null);
  assert.equal((await api.state()).body.gamePausedMs, 15 * 60_000 - elapsed);

  // Resuming picks up from the frozen value, not the full length.
  const resumeAt = NOW + 400_000;
  await api.admin("TIMER_START", resumeAt);
  assert.equal((await api.state()).body.gameEndsAt, resumeAt + (15 * 60_000 - elapsed));
  assert.equal((await api.state()).body.gamePausedMs, null);

  await api.admin("TIMER_RESET", resumeAt + 1000);
  const stopped = await api.state();
  assert.equal(stopped.body.gameEndsAt, null);
  assert.equal(stopped.body.gamePausedMs, null, "reset returns to stopped, not paused at zero");
  assert.equal(
    stopped.body.gameDurationMs,
    15 * 60_000,
    "reset does not touch the configured length",
  );
});

test("TIMER_SET changes the configured length from idle, and the wire rejects a bad `minutes`", async () => {
  const api = harness();

  const tenMin = await api.admin("TIMER_SET", NOW, { minutes: 10 });
  assert.equal(tenMin.status, 200);
  assert.equal((await api.state()).body.gameDurationMs, 10 * 60_000);

  await api.admin("TIMER_START", NOW);
  assert.equal(
    (await api.state()).body.gameEndsAt,
    NOW + 10 * 60_000,
    "the new length is what starts",
  );

  const whileRunning = await api.admin("TIMER_SET", NOW + 1000, { minutes: 20 });
  assert.equal(whileRunning.status, 409);
  assert.equal(whileRunning.body.error, "TIMER_RUNNING");

  await api.admin("TIMER_RESET", NOW + 2000);
  for (const bad of [0, 121, 1.5, "10", null, undefined, NaN]) {
    const res = await api.admin("TIMER_SET", NOW + 3000, { minutes: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.body.error, "BAD_DURATION");
  }
  // None of the rejected attempts touched the stored length.
  assert.equal((await api.state()).body.gameDurationMs, 10 * 60_000);

  // The boundary values are accepted, not just anything inside them.
  assert.equal((await api.admin("TIMER_SET", NOW + 4000, { minutes: 1 })).status, 200);
  assert.equal((await api.state()).body.gameDurationMs, 1 * 60_000);
  assert.equal((await api.admin("TIMER_SET", NOW + 5000, { minutes: 120 })).status, 200);
  assert.equal((await api.state()).body.gameDurationMs, 120 * 60_000);
});

test("TIMER_* actions require the admin key, same as every other admin action", async () => {
  const api = harness();
  for (const action of ["TIMER_START", "TIMER_PAUSE", "TIMER_RESET", "TIMER_SET"]) {
    const res = await api.router({
      method: "POST",
      path: "/admin",
      body: { key: "wrong-key", action, minutes: 10 },
      now: NOW,
    });
    assert.equal(res.status, 401, action);
    assert.equal(res.body.error, "UNAUTHORIZED", action);
  }
});

test("the segment clock reaching zero changes nothing about the poll game", async () => {
  const api = harness();
  await api.admin("TIMER_SET", NOW, { minutes: 1 });
  await api.admin("TIMER_START", NOW);

  // Long past zero on the segment clock, every ordinary control still works
  // and a phone can still vote — this clock is display-only, full stop.
  const wayPastZero = NOW + 10 * 60_000;
  assert.equal((await api.admin("START", wayPastZero)).status, 200);
  assert.equal((await api.vote("voter-aaaa", "a", wayPastZero)).status, 200);
  assert.equal((await api.admin("LOCK", wayPastZero)).status, 200);
  assert.equal((await api.admin("REVEAL", wayPastZero)).status, 200);
  assert.equal(
    (await api.state(wayPastZero)).body.gameEndsAt,
    NOW + 60_000,
    "still reads as expired, not cleared",
  );
});

test("/state carries the join clock unauthenticated, because /screen has no key", async () => {
  const api = harness();

  const fresh = await api.state();
  assert.equal(fresh.body.joinEndsAt, null, "stopped, so /screen draws nothing");
  assert.equal(fresh.body.joinDurationMs, 5 * 60_000, "five minutes is the default");

  await api.admin("JOIN_START", NOW);
  const running = await api.state();
  assert.equal(running.body.joinEndsAt, NOW + 5 * 60_000);
});

test("JOIN_START arms, JOIN_STOP clears, and a second start is refused", async () => {
  const api = harness();

  assert.equal((await api.admin("JOIN_START", NOW)).status, 200);
  const again = await api.admin("JOIN_START", NOW + 1000);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "JOIN_RUNNING");

  assert.equal((await api.admin("JOIN_STOP", NOW + 2000)).status, 200);
  assert.equal((await api.state()).body.joinEndsAt, null);
  assert.equal(
    (await api.state()).body.joinDurationMs,
    5 * 60_000,
    "stopping does not forget the length",
  );
});

test("JOIN_ADJUST moves the deadline while running and the length while stopped", async () => {
  const api = harness();

  // Stopped: the configured length moves, and the clock stays off.
  await api.admin("JOIN_ADJUST", NOW, { minutes: 1 });
  const stopped = await api.state();
  assert.equal(stopped.body.joinDurationMs, 6 * 60_000);
  assert.equal(stopped.body.joinEndsAt, null);

  // Running: the deadline moves, the length does not.
  await api.admin("JOIN_START", NOW);
  await api.admin("JOIN_ADJUST", NOW + 1000, { minutes: 1 });
  const running = await api.state();
  assert.equal(running.body.joinEndsAt, NOW + 7 * 60_000);
  assert.equal(running.body.joinDurationMs, 6 * 60_000, "the live stretch is not a new length");
});

test("JOIN_ADJUST rejects a `minutes` that is not a signed whole-minute step", async () => {
  const api = harness();

  // Zero included: an adjustment that adjusts nothing is malformed, not a no-op.
  for (const bad of [0, 61, -61, 1.5, "1", null, undefined, NaN]) {
    const res = await api.admin("JOIN_ADJUST", NOW, { minutes: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.body.error, "BAD_DURATION");
  }
  assert.equal((await api.state()).body.joinDurationMs, 5 * 60_000, "nothing was written");

  // Negative steps are the half TIMER_SET's own validator would have rejected.
  assert.equal((await api.admin("JOIN_ADJUST", NOW, { minutes: -1 })).status, 200);
  assert.equal((await api.state()).body.joinDurationMs, 4 * 60_000);
});

test("JOIN_SET takes an absolute length, stopped only, and the wire rejects a bad one", async () => {
  const api = harness();

  // The console's 1 / 3 / 5 chips and its custom field both land here.
  for (const minutes of [1, 3, 5, 45]) {
    assert.equal((await api.admin("JOIN_SET", NOW, { minutes })).status, 200);
    assert.equal((await api.state()).body.joinDurationMs, minutes * 60_000);
  }

  // Same 1..120 band TIMER_SET validates against — not JOIN_ADJUST's signed step.
  for (const bad of [0, 121, -1, 1.5, "5", null, undefined, NaN]) {
    const res = await api.admin("JOIN_SET", NOW, { minutes: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.body.error, "BAD_DURATION");
  }
  assert.equal((await api.state()).body.joinDurationMs, 45 * 60_000, "nothing was written");

  await api.admin("JOIN_SET", NOW, { minutes: 3 });
  await api.admin("JOIN_START", NOW);
  const whileRunning = await api.admin("JOIN_SET", NOW + 1000, { minutes: 1 });
  assert.equal(whileRunning.status, 409);
  assert.equal(whileRunning.body.error, "JOIN_RUNNING");
  assert.equal(
    (await api.state()).body.joinEndsAt,
    NOW + 3 * 60_000,
    "the live window the room is watching is untouched",
  );
});

test("JOIN_* actions require the admin key, same as every other admin action", async () => {
  const api = harness();
  for (const action of ["JOIN_START", "JOIN_STOP", "JOIN_ADJUST", "JOIN_SET"]) {
    const res = await api.router({
      method: "POST",
      path: "/admin",
      body: { key: "wrong-key", action, minutes: 1 },
      now: NOW,
    });
    assert.equal(res.status, 401, action);
    assert.equal(res.body.error, "UNAUTHORIZED", action);
  }
});

test("the join clock reaching zero changes nothing about the poll game", async () => {
  const api = harness();
  await api.admin("JOIN_START", NOW);

  // Long past zero on the join clock, every ordinary control still works and a
  // phone can still vote. Nothing closes the doors but 开始本题.
  const wayPastZero = NOW + 30 * 60_000;
  assert.equal((await api.admin("START", wayPastZero)).status, 200);
  assert.equal((await api.vote("voter-aaaa", "a", wayPastZero)).status, 200);
  assert.equal(
    (await api.state(wayPastZero)).body.joinEndsAt,
    NOW + 5 * 60_000,
    "still reads as expired, not cleared",
  );
});

test("RESET clears the join clock and returns the length to five minutes", async () => {
  const api = harness();
  await api.admin("JOIN_ADJUST", NOW, { minutes: 10 });
  await api.admin("JOIN_START", NOW);
  assert.equal((await api.state()).body.joinEndsAt, NOW + 15 * 60_000);

  await api.admin("RESET", NOW + 1000);
  const fresh = await api.state();
  assert.equal(fresh.body.joinEndsAt, null);
  assert.equal(fresh.body.joinDurationMs, 5 * 60_000, "a rehearsal reset forgets a custom length");
});

test("every route the router answers is registered for dispatch", async () => {
  // A missing entry here passes every unit test in this file and 404s in
  // production, because server.js dispatches on the exact (method, path) pair.
  const api = harness();
  for (const route of [...API_ROUTES]) {
    const [method, path] = route.split(" ");
    const res = await api.router({ method, path, query: {}, body: { key: KEY }, now: NOW });
    assert.notEqual(res.status, 404, route);
  }
});

// Offline mode: the host runs the room without phones. It is switched from the
// setup page and it is what turns POST /vote off.

test("/state carries `offline` for everyone, and it is off until the host turns it on", async () => {
  const api = harness();

  assert.equal((await api.state()).body.offline, false);
  assert.equal((await api.state(NOW, { k: KEY })).body.offline, false);

  const on = await api.admin("OFFLINE_ON");
  assert.equal(on.status, 200);
  assert.equal(on.body.offline, true);
  // The phones and the wall are the ones that have to react, and neither
  // carries a key.
  assert.equal((await api.state()).body.offline, true);

  // Idempotent over the wire as well: a second "on" is a 200 and still on.
  assert.equal((await api.admin("OFFLINE_ON")).body.offline, true);
  assert.equal((await api.admin("OFFLINE_OFF")).body.offline, false);
  assert.equal((await api.admin("OFFLINE_OFF")).body.offline, false);
});

test("OFFLINE_ON and OFFLINE_OFF need the admin key, and a lobby", async () => {
  const api = harness();

  for (const action of ["OFFLINE_ON", "OFFLINE_OFF"]) {
    const res = await api.router({
      method: "POST",
      path: "/admin",
      body: { key: "guess", action },
      now: NOW,
    });
    assert.equal(res.status, 401, action);
    assert.equal(res.body.error, "UNAUTHORIZED", action);
  }
  assert.equal((await api.state()).body.offline, false, "a wrong key changed nothing");

  await api.admin("START");
  for (const action of ["OFFLINE_ON", "OFFLINE_OFF"]) {
    const refused = await api.admin(action);
    assert.equal(refused.status, 409, action);
    assert.equal(refused.body.error, "WRONG_PHASE", action);
  }
  assert.equal((await api.state()).body.offline, false);
});

test("/vote is refused with OFFLINE while offline, and works again once it is switched off", async () => {
  const api = harness();
  await api.admin("OFFLINE_ON");
  await api.admin("START");

  const refused = await api.vote("voter-aaaa", "a");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "OFFLINE");
  // Refused before the store ever saw it: nothing counted, and the voter is
  // not marked as having voted on a question they were never asked.
  assert.deepEqual((await api.state(NOW, { k: KEY })).body.tally, tally());

  // The mode cannot be switched under an open question...
  assert.equal((await api.admin("OFFLINE_OFF")).body.error, "WRONG_PHASE");

  // ...so the host finishes it — with no reveal to go through — and switches
  // in the lobby before the next one.
  await api.admin("LOCK");
  const next = await api.admin("NEXT");
  assert.equal(next.status, 200);
  assert.deepEqual([next.body.phase, next.body.qIndex], ["LOBBY", 1]);
  assert.equal((await api.admin("OFFLINE_OFF")).body.offline, false);

  await api.admin("START");
  assert.equal((await api.vote("voter-aaaa", "b", NOW, 1)).status, 200);
  assert.deepEqual((await api.state()).body.tally, tally({ b: 1 }));
});

test("/join still counts while offline, so nobody has to rejoin if the host switches back", async () => {
  const api = harness();
  await api.admin("OFFLINE_ON");

  assert.equal((await api.join("voter-aaaa")).body.created, true);
  assert.equal((await api.join("voter-aaaa")).body.created, false);
  assert.equal((await api.state()).body.joined, 1);

  await api.admin("OFFLINE_OFF");
  assert.equal((await api.state()).body.joined, 1);
});

test("an offline show runs to FINAL without a reveal, and with nothing collected", async () => {
  const api = harness();
  await api.admin("OFFLINE_ON");

  for (const action of ["START", "LOCK", "NEXT", "START", "LOCK", "NEXT"]) {
    const res = await api.admin(action);
    assert.equal(res.status, 200, action);
  }

  const final = await api.state();
  assert.equal(final.body.phase, "FINAL");
  assert.equal(final.body.offline, true);
  assert.deepEqual(final.body.results, [
    { qIndex: 0, ...tally() },
    { qIndex: 1, ...tally() },
  ]);
});

test("online, NEXT from a locked question is still refused — the offline shortcut is offline only", async () => {
  const api = harness();
  await api.admin("START");
  await api.vote("voter-aaaa", "a");
  await api.admin("LOCK");

  const refused = await api.admin("NEXT");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "WRONG_PHASE");
  assert.equal((await api.state()).body.phase, "LOCKED");
});

test("RESET keeps offline mode — it is a setting, not part of the run", async () => {
  const api = harness();
  await api.admin("OFFLINE_ON");
  await api.join("voter-aaaa");
  await api.admin("START");
  await api.admin("LOCK");
  await api.admin("NEXT");

  const reset = await api.admin("RESET", NOW + 500);
  assert.equal(reset.status, 200);
  // Everything a reset is for still happens...
  assert.equal(reset.body.phase, "LOBBY");
  assert.equal(reset.body.qIndex, 0);
  assert.equal(reset.body.joined, 0);
  assert.equal(reset.body.epoch, NOW + 500);
  // ...and the room is still being run without phones.
  assert.equal(reset.body.offline, true);
  assert.equal((await api.state()).body.offline, true);

  // Off survives a reset just the same: a reset never turns it on.
  await api.admin("OFFLINE_OFF");
  assert.equal((await api.admin("RESET", NOW + 900)).body.offline, false);
});
