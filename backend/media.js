// Storage for question media — pictures, voice clips and video.
//
// Two adapters, same interface: S3 when deployed, the local filesystem when
// running without a bucket. The S3 client is loaded with a dynamic import so
// that if it is ever missing, uploads fail while /state, /vote and /admin keep
// working. Never let a content-authoring feature take the show down.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Every object this app writes lives under here. Both the IAM policy and the
// bucket policy are scoped to it, and keyOf refuses to delete anything outside
// it — so a url that is not under this prefix is not ours, whoever sent it.
const PREFIX = "questions";

// Hoisted out of KINDS so the list has one home.
const AUDIO_TYPES = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
};

// The browser compresses pictures to well under 200KB before sending, so the
// image ceiling is only a backstop. Audio cannot be re-encoded client-side
// without dragging in a codec, so it is accepted as uploaded and capped
// instead — a couple of minutes of ordinary MP3 fits comfortably.
export const KINDS = {
  image: {
    types: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
    maxBytes: 1_500_000,
  },
  audio: {
    types: AUDIO_TYPES,
    maxBytes: 6_000_000,
  },
  // Video goes up the same base64 path as the rest, so the cap is really a
  // statement about how long the operator is willing to stare at a progress
  // bar on venue wifi: 40MB is roughly 45 seconds of 1080p, and about two
  // minutes at 5Mbps up. Anything longer belongs on the projector from a
  // local file, not in this bucket.
  //
  // quicktime is here because that is what an iPhone hands over — a clip
  // recorded on the operator's own phone is the likely case.
  video: {
    types: {
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
    },
    maxBytes: 40_000_000,
  },
};

export function mediaKey(qIndex, kind, ext, option = null) {
  // The random suffix is cache-busting: replacing a file must not leave phones
  // and the projector showing the old one out of their HTTP cache.
  const suffix = Math.random().toString(36).slice(2, 8);
  // The option letter is a diagnostic, not an identity — the suffix above is
  // what makes the key unique. It is here so a bucket listing during the show
  // reads as "question 3, option b, the picture" without a lookup, and it does
  // not matter that a question deleted later shifts the numbering: the key is
  // opaque and the url is stored verbatim in the content record.
  const at = option ? `q${qIndex}${option}` : `q${qIndex}`;
  // The `questions/` prefix is what both the IAM policy and the bucket policy
  // are scoped to — do not move it without changing them too.
  return `${PREFIX}/${at}-${kind}-${suffix}.${ext}`;
}

/**
 * In-process store for local runs and rehearsal, so the setup page's uploads
 * can be exercised without an S3 bucket. Deliberately not persistent and not
 * shared between tasks — Terraform always sets MEDIA_BUCKET, and both the
 * startup log and /ready say plainly when this one is in use.
 */
export function createMemoryMediaStore() {
  const files = new Map();

  return {
    kind: "memory",
    async ready() {
      return true;
    },
    async put({ key, contentType, bytes }) {
      files.set(key, { contentType, bytes });
      return `/uploads/${key}`;
    },
    get(key) {
      return files.get(key) ?? null;
    },
    async remove(key) {
      files.delete(key);
    },
    keyOf(url) {
      return ourKey(url, (parsed) => (parsed ? null : url.replace(/^\/uploads\//, "")));
    },
  };
}

/**
 * The object key a stored url points at, or null when the url is not one of
 * ours to delete.
 *
 * The delete path is only ever handed a url out of a content record, never a
 * key: a caller-supplied key would be a caller-supplied path into the bucket.
 * Anything that does not resolve to our own prefix belongs to somebody else —
 * or is an attempt to make us delete somebody else's object — and the answer to
 * both is the same.
 *
 * @param {string} url
 * @param {(parsed: URL|null) => string|null} extract  how this adapter names its files
 */
function ourKey(url, extract) {
  if (typeof url !== "string" || !url) return null;

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    // A relative url — the memory adapter's /uploads/... form.
  }

  const key = extract(parsed);
  if (!key || !key.startsWith(`${PREFIX}/`) || key.includes("..")) return null;
  return key;
}

export function createLocalMediaStore({ dir, baseUrl = "" }) {
  const root = resolve(dir);

  return {
    kind: "local",
    async ready() {
      return true;
    },
    async put({ key, bytes }) {
      const target = join(root, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return `${baseUrl}/${key}`;
    },
    async remove(key) {
      await rm(join(root, key), { force: true });
    },
    keyOf(url) {
      return ourKey(url, (parsed) => keyUnder(parsed, url, [baseUrl]));
    },
  };
}

export function createS3MediaStore({ bucket, region, baseUrl }) {
  let loaded = null;

  const load = async () => {
    if (!loaded) loaded = import("@aws-sdk/client-s3");
    const { S3Client, PutObjectCommand, DeleteObjectCommand } = await loaded;
    return {
      client: (createS3MediaStore.client ??= new S3Client(region ? { region } : {})),
      PutObjectCommand,
      DeleteObjectCommand,
    };
  };

  const homes = [baseUrl, `https://${bucket}.s3.${region}.amazonaws.com`];

  return {
    kind: "s3",
    async ready() {
      try {
        await load();
        return true;
      } catch {
        return false;
      }
    },
    async put({ key, contentType, bytes }) {
      const { client, PutObjectCommand } = await load();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          // Keys are unique per upload, so these can cache forever.
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      return baseUrl ? `${baseUrl}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    },
    async remove(key) {
      const { client, DeleteObjectCommand } = await load();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    // Both forms put() can return: whatever MEDIA_BASE_URL was set to at the
    // time, and the bare bucket endpoint. A url written under one deployment's
    // base and read back under another's is still ours if the host matches.
    keyOf(url) {
      return ourKey(url, (parsed) => keyUnder(parsed, url, homes));
    },
  };
}

/** The path under one of `homes` that this url points at, or null. */
function keyUnder(parsed, url, homes) {
  if (!parsed) return null;

  for (const home of homes.filter(Boolean)) {
    let base;
    try {
      base = new URL(home);
    } catch {
      continue;
    }
    if (base.host !== parsed.host || base.protocol !== parsed.protocol) continue;

    const under = base.pathname.replace(/\/+$/, "");
    if (under && !parsed.pathname.startsWith(`${under}/`)) continue;
    return parsed.pathname.slice(under.length + 1);
  }
  return null;
}

/** Decode and validate an upload. Returns bytes and the file extension. */
export function decodeUpload({ kind, contentType, data }) {
  const spec = KINDS[kind];
  if (!spec) return { error: "BAD_KIND" };

  const ext = spec.types[contentType];
  if (!ext) return { error: "BAD_CONTENT_TYPE" };
  if (typeof data !== "string" || data.length === 0) return { error: "BAD_MEDIA_DATA" };

  let bytes;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return { error: "BAD_MEDIA_DATA" };
  }

  if (bytes.length === 0) return { error: "BAD_MEDIA_DATA" };
  if (bytes.length > spec.maxBytes) return { error: "MEDIA_TOO_LARGE" };
  return { bytes, ext, kind };
}
