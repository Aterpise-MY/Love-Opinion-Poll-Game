// The one server entry point. Serves the built frontend and the API from a
// single origin, which is what removes CORS from the system entirely.
//
//   node server.js                      in-memory store, API only if no public/
//   TABLE_NAME=poll-game node server.js DynamoDB
//   DECK_FILE=./deck.test.json          2-second questions, for smoke tests
//
// Environment:
//   PORT            default 8080
//   ADMIN_KEY       operator console key; without it every admin route 401s
//   TABLE_NAME      set -> DynamoDB, unset -> in-memory
//   AWS_REGION      REQUIRED with TABLE_NAME. Lambda injected this; Fargate
//                   does not, and the SDK throws "Region is missing" without it
//   MEDIA_BUCKET    set -> uploads go to S3, unset -> uploads disabled
//                   (pictures, voice clips and video alike)
//   MEDIA_BASE_URL  origin the bucket is served from; defaults to the S3 REST
//                   endpoint built from MEDIA_BUCKET and AWS_REGION
//   GAME_ID         partition key, default game#1

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

import { API_ROUTES, createRouter } from "./router.js";
import { createMemoryStore } from "./store-memory.js";
import { loadQuestions } from "./config.js";
import { loadStatic, sendAsset } from "./static.js";

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_KEY = process.env.ADMIN_KEY ?? (process.env.NODE_ENV === "production" ? "" : "dev");
// 32KB, not the 8 this started at. A question with six options each carrying a
// picture, a clip and a video is 6 x 3 x MAX_URL = 9KB of urls before any body
// text, and MEDIA_BASE_URL is a deployment variable — a custom domain with a
// long prefix is how that quietly starts 413ing the setup page's saves. Still a
// bound on an unbounded POST; only uploads need the megabyte budget below.
const BODY_LIMIT = 32 * 1024;
// Audio and video are accepted as uploaded (no client-side re-encode), and
// base64 inflates by a third, so this has to clear the 40MB video cap in
// media.js comfortably. readBody buffers the whole thing, so the real cost is
// a few hundred MB of headroom on a 2GB task — affordable because uploads are
// one operator before the show, never the audience during it.
const UPLOAD_LIMIT = 64 * 1024 * 1024;
// The routes that carry a file in the body. A set rather than an equality
// check: a new upload route that is forgotten here does not 404 or throw, it
// silently 413s the first time somebody picks a real file.
const UPLOAD_PATHS = new Set(["/admin/upload"]);

const LOOKS_LIKE_FILE = /\.[a-z0-9]{1,8}$/i;

// The deck the show shipped with, still read once and still fail-fast
// validated. It is the seed for the live list, not the live list itself — the
// setup page can add and delete questions, and what it changes lives in the
// store. This is why the startup line below says "seed".
const defaults = loadQuestions();

const store = process.env.TABLE_NAME
  ? (await import("./store-dynamo.js")).createDynamoStore({
      tableName: process.env.TABLE_NAME,
      gameId: process.env.GAME_ID ?? "game#1",
      region: process.env.AWS_REGION,
    })
  : // Seeded with the boot time, because this store forgets everything when the
    // process stops and the phones do not. A phone drops the choices it
    // remembers only when the epoch changes, and it ignores an epoch of 0 as
    // "never reset" — so a restart that came back at 0 would leave every phone
    // showing 已投票 on questions nobody has answered in this run.
    createMemoryStore({ epoch: Date.now() });

const media = await import("./media.js");

// Without a bucket, uploads land in process memory and are served from
// /uploads. That is what makes the setup page testable on a laptop; it is not
// persistent and not shared between tasks, which is why Terraform always sets
// MEDIA_BUCKET and both the startup line and /ready name which one is active.
const images = process.env.MEDIA_BUCKET
  ? media.createS3MediaStore({
      bucket: process.env.MEDIA_BUCKET,
      region: process.env.AWS_REGION,
      baseUrl: process.env.MEDIA_BASE_URL,
    })
  : media.createMemoryMediaStore();

const router = createRouter({ store, defaults, adminKey: ADMIN_KEY, images });
const statics = loadStatic(fileURLToPath(new URL("./public/", import.meta.url)));

let draining = false;

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "BAD_REQUEST" });
  }
  const path = url.pathname.replace(/\/{2,}/g, "/");

  // Same-origin never preflights, but health probes and scanners still ask.
  if (req.method === "OPTIONS") {
    res.writeHead(204, { allow: "GET, HEAD, POST, OPTIONS" }).end();
    return;
  }

  // Liveness. Deliberately touches nothing: if this checked DynamoDB, one blip
  // would fail every task's health check at once, the ALB would have zero
  // healthy targets, and ECS would replace both tasks — turning a transient,
  // self-healing degradation into a 90-second self-inflicted outage.
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, draining ? 503 : 200, { ok: !draining });
  }

  if (API_ROUTES.has(`${req.method} ${path}`)) {
    return handleApi(req, res, url, path);
  }

  // Media held in process memory (no bucket configured). With S3 these URLs
  // are absolute and never reach us.
  if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/uploads/")) {
    const file = images.get?.(path.slice("/uploads/".length));
    if (!file) return sendJson(res, 404, { error: "NOT_FOUND" });
    res.writeHead(200, {
      "content-type": file.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": file.bytes.length,
    });
    return res.end(req.method === "HEAD" ? undefined : file.bytes);
  }

  // Anything non-GET that reaches here is a genuine 404. It must never fall
  // through to the SPA — a POST answered with HTML is impossible to diagnose.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 404, { error: "NOT_FOUND" });
  }

  if (!statics) return sendJson(res, 404, { error: "NOT_FOUND" });

  const asset = statics.get(path);
  if (asset) return sendAsset(req, res, asset);

  // A missing thing that looks like a file is a 404, not the SPA. Otherwise a
  // mistyped /assets/*.js returns index.html with status 200 and the browser
  // fails with an opaque MIME error that points nowhere near the real cause.
  if (LOOKS_LIKE_FILE.test(path)) return sendJson(res, 404, { error: "NOT_FOUND" });

  // SPA rewrite — same URL, status 200. Never a redirect: a 302 would drop the
  // query string, taking /admin?k= and /screen?url= with it, and main.jsx
  // routes on pathname so the destination would be wrong too.
  const index = statics.index();
  if (!index) return sendJson(res, 404, { error: "NOT_FOUND" });
  return sendAsset(req, res, index);
});

async function handleApi(req, res, url, path) {
  let body = null;
  if (req.method === "POST") {
    const limit = UPLOAD_PATHS.has(path) ? UPLOAD_LIMIT : BODY_LIMIT;
    try {
      const raw = await readBody(req, limit);
      if (raw) body = JSON.parse(raw);
    } catch (err) {
      const tooBig = err.code === "BODY_TOO_LARGE";
      return sendJson(res, tooBig ? 413 : 400, { error: tooBig ? "TOO_LARGE" : "BAD_JSON" });
    }
  }

  try {
    const result = await router({
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error("unhandled", { path, method: req.method, name: err.name, message: err.message });
    sendJson(res, 500, { error: "INTERNAL" });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("body too large");
        err.code = "BODY_TOO_LARGE";
        // Pause rather than destroy, so the 413 actually reaches the client
        // instead of the socket being reset out from under it.
        req.pause();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// The ALB reuses a keep-alive socket the instant Node closes it, so Node's
// timeout has to outlive the load balancer's idle timeout (60s) or you get
// sporadic 502s that look like random application failures.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

function shutdown(signal) {
  if (draining) return; // ECS can send SIGTERM more than once
  draining = true;
  console.log(`${signal}: draining`);

  server.close(() => process.exit(0));
  // close() alone waits for keep-alive sockets to go idle on their own. With
  // hundreds of phones polling every 2s that never happens, so sweep them.
  server.closeIdleConnections?.();
  const sweep = setInterval(() => server.closeIdleConnections?.(), 250);
  sweep.unref();
  setTimeout(() => process.exit(0), 10_000).unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Inside a container the interfaces above are the container's own: a bridge
// address that nothing outside the Docker host can route to, on the internal
// port rather than the one the host publishes. Printed as "point phones here"
// it is confidently wrong, which is worse than saying nothing — and the
// process has no way to learn the host's address or the port mapping. These
// two files are how Docker and Podman mark a container from the inside.
const inContainer = ["/.dockerenv", "/run/.containerenv"].some((marker) => existsSync(marker));

// Pay the credential-provider round trip, the TLS handshake and the SigV4
// credential resolution now, rather than on the first phone's request. This
// must never throw: a crash loop is far worse than one slow request.
try {
  await store.getState();
} catch (err) {
  console.error(`warm-up failed (continuing): ${err.name}: ${err.message}`);
}

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(
    `love-opinion-poll listening on :${PORT} · store=${process.env.TABLE_NAME ? "dynamo" : "memory"} · ` +
      `uploads=${images.kind} · ` +
      `static=${statics ? `${statics.size} files, ${Math.round(statics.bytes / 1024)}KB` : "disabled"} · ` +
      `questions=${defaults.length} (seed)`,
  );
  if (!ADMIN_KEY) console.warn("ADMIN_KEY is unset — every admin route will return 401");
  if (inContainer) {
    console.log(
      "  lan   in a container: point phones at the host machine's LAN address and the port it " +
        "publishes (HOST_PORT in docker-compose.yml, 8520 by default)",
    );
  } else if (lan) {
    console.log(`  lan   http://${lan}:${PORT}   <- point phones here`);
  }
});
