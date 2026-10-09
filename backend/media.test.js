import test from "node:test";
import assert from "node:assert/strict";

import {
  KINDS,
  createMemoryMediaStore,
  createS3MediaStore,
  decodeUpload,
  mediaKey,
} from "./media.js";

test("mediaKey names the question, and the option when there is one", () => {
  assert.match(mediaKey(0, "image", "jpg"), /^questions\/q0-image-\w{6}\.jpg$/);
  assert.match(mediaKey(2, "audio", "mp3", "b"), /^questions\/q2b-audio-\w{6}\.mp3$/);

  // The suffix, not the name, is what makes a key unique — two uploads onto the
  // same option must not collide, or replacing a picture would leave phones
  // showing the old one out of their cache.
  assert.notEqual(mediaKey(1, "image", "png", "a"), mediaKey(1, "image", "png", "a"));
});

test("the memory store round-trips a file and then forgets it", async () => {
  const store = createMemoryMediaStore();
  const key = mediaKey(0, "image", "jpg");

  const url = await store.put({ key, contentType: "image/jpeg", bytes: Buffer.from("x") });
  assert.equal(url, `/uploads/${key}`);
  assert.equal(store.get(key).contentType, "image/jpeg");

  await store.remove(store.keyOf(url));
  assert.equal(store.get(key), null);
});

test("keyOf resolves our own urls and refuses everything else", () => {
  const s3 = createS3MediaStore({
    bucket: "poll-media",
    region: "ap-southeast-1",
    baseUrl: "https://cdn.example/media",
  });
  const memory = createMemoryMediaStore();

  assert.equal(
    s3.keyOf("https://cdn.example/media/questions/q0-image-abc123.jpg"),
    "questions/q0-image-abc123.jpg",
  );
  // The bare bucket endpoint too: MEDIA_BASE_URL is a deployment variable, and
  // a url written before it was set is still ours.
  assert.equal(
    s3.keyOf("https://poll-media.s3.ap-southeast-1.amazonaws.com/questions/q1b-audio-zz9.mp3"),
    "questions/q1b-audio-zz9.mp3",
  );
  assert.equal(
    memory.keyOf("/uploads/questions/q0-image-abc123.jpg"),
    "questions/q0-image-abc123.jpg",
  );

  for (const url of [
    "https://elsewhere.example/questions/q0-image-abc123.jpg", // somebody else's host
    "https://cdn.example/other/q0-image-abc123.jpg", // outside our prefix
    "https://cdn.example/media/logos/brand.png", // right host, wrong prefix
    "https://cdn.example/media/questions/../../secrets.json", // traversal
    "http://cdn.example/media/questions/q0-image-abc123.jpg", // downgraded scheme
    "questions/q0-image-abc123.jpg", // a bare key, which is never what we store
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(s3.keyOf(url), null, `s3 keyOf ${JSON.stringify(url)}`);
  }

  assert.equal(memory.keyOf("https://elsewhere.example/uploads/questions/x.jpg"), null);
  assert.equal(memory.keyOf("/uploads/../etc/passwd"), null);
});

test("a question's clip is capped where the guardrail is worth having", () => {
  // 6MB is roughly a couple of minutes of ordinary MP3, and this is the file
  // re-uploaded most often on venue wifi. `music` was briefly a fourth kind at
  // 30MB for a whole-show background track; that feature is gone, and this cap
  // is the one that was always doing the work.
  assert.equal(KINDS.audio.maxBytes, 6_000_000);
  assert.equal(KINDS.music, undefined, "no game-wide media kind");

  const at = (bytes) =>
    decodeUpload({
      kind: "audio",
      contentType: "audio/mpeg",
      data: Buffer.alloc(bytes).toString("base64"),
    });
  assert.equal(at(5_000_000).error, undefined);
  assert.equal(at(7_000_000).error, "MEDIA_TOO_LARGE");
});
