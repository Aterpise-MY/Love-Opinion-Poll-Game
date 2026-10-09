// Static file serving for the built frontend, from an in-memory manifest.
//
// The whole asset set is three files (index.html, one JS chunk, one CSS), so
// everything is read once at boot and answered from memory. That buys two
// things beyond speed:
//
//   1. There is no path arithmetic anywhere — a request is a Map.get() on an
//      exact key. The entire path-traversal class of bug is structurally
//      absent, with no `resolve()` or `startsWith(root)` guard to get wrong.
//   2. Zero fs syscalls per request, which matters when 300 phones fetch the
//      bundle in the same 90 seconds as the polling load.
//
// Gzip variants are precompressed at image build time. The ALB does not
// compress, so without this every phone downloads 196KB instead of 65KB —
// about 39MB of extra venue-wifi traffic during the opening minute.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
// index.html must be revalidated or a reload keeps pointing at asset hashes
// that a deploy has already replaced. no-cache still allows a 0-byte 304;
// no-store would re-download it every time and defeat the back/forward cache.
const REVALIDATE = "no-cache";

const INDEX = "/index.html";

function walk(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const key = posix.join(base, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, key));
    else out.push({ full, key: `/${key}` });
  }
  return out;
}

/**
 * Build the manifest. Returns null when the directory is absent, which is the
 * API-only mode used during backend development.
 */
export function loadStatic(dir) {
  let files;
  try {
    files = walk(dir);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const assets = new Map();
  const gzipped = new Map();

  for (const { full, key } of files) {
    const bytes = readFileSync(full);

    if (key.endsWith(".gz")) {
      gzipped.set(key.slice(0, -3), bytes);
      continue;
    }

    assets.set(key, {
      bytes,
      type: TYPES[extname(key)] ?? "application/octet-stream",
      // Vite puts a content hash in every asset filename, so /assets/* can
      // never change under a given URL. index.html is the only mutable entry.
      cacheControl: key === INDEX ? REVALIDATE : IMMUTABLE,
      etag: `"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"`,
      gzip: null,
    });
  }

  for (const [key, bytes] of gzipped) {
    const asset = assets.get(key);
    if (asset) asset.gzip = bytes;
  }

  return {
    get: (path) => assets.get(path === "/" ? INDEX : path) ?? null,
    index: () => assets.get(INDEX) ?? null,
    size: assets.size,
    bytes: [...assets.values()].reduce((n, a) => n + a.bytes.length, 0),
  };
}

/** Write an asset, honouring If-None-Match and Accept-Encoding. */
export function sendAsset(req, res, asset) {
  const headers = {
    "content-type": asset.type,
    "cache-control": asset.cacheControl,
    etag: asset.etag,
  };

  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers).end();
    return;
  }

  const wantsGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
  const body = wantsGzip && asset.gzip ? asset.gzip : asset.bytes;

  if (asset.gzip) headers.vary = "Accept-Encoding";
  if (body === asset.gzip) headers["content-encoding"] = "gzip";
  headers["content-length"] = body.length;

  res.writeHead(200, headers);
  // HEAD must carry the same headers but no body.
  res.end(req.method === "HEAD" ? undefined : body);
}
