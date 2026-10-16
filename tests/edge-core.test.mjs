import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handle, parseHost, injectHtml, contentSecurityPolicy, SDK_TAG, SDK_STUB } from "../edge/src/core.mjs";
import { libraryIndex } from "../scripts/lib/cdn.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const PROD = { GAME_DOMAIN: "dhplay.net", PREVIEW_DOMAIN: "dhpreview.net", FRAME_ANCESTORS: "https://degenhive.ai https://www.degenhive.ai" };
const LOCAL = { GAME_DOMAIN: "localhost", PREVIEW_DOMAIN: "localhost", FRAME_ANCESTORS: "http://localhost:3000 https://degenhive.ai" };

// ---- a memory store with one live build and one pending upload ----

const HTML = '<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title></head><body><canvas></canvas><script src="game.js"></script></body></html>';
const JS = "import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';\nDegenHive.ready();\n";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const files = {
  "index.html": HTML,
  "game.js": JS,
  "sub/index.html": "<p>sub</p>",
};
const manifest = (extra = {}) => ({
  slug: "bee-game",
  entry: "index.html",
  files: [
    ...Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text), type: "text/html" })),
    { path: "img/bee.png", sha256: sha(PNG), bytes: PNG.length, type: "image/png" },
  ],
  backends: [],
  ...extra,
});
const LIVE = "a".repeat(64);
const libs = [{ name: "three", version: "0.160.0", file: "build/three.module.js", sha256: sha("THREE"), bytes: 5 }];

function memoryStore({ kv = {}, objects = {}, sdk = "/*sdk*/" } = {}) {
  const all = {
    [`builds/bee-game/${LIVE}/manifest.json`]: JSON.stringify(manifest()),
    "pending/up1/manifest.json": JSON.stringify(manifest({ createdAt: "2026-10-15T00:00:00Z" })),
    [`assets/${sha(PNG)}`]: PNG,
    [`assets/${sha("THREE")}`]: Buffer.from("THREE"),
    ...Object.fromEntries(Object.entries(files).flatMap(([p, t]) => [[`builds/bee-game/${LIVE}/src/${p}`, t], [`pending/up1/src/${p}`, t]])),
    ...objects,
  };
  const kvAll = { "live:bee-game": LIVE, "pr:7": "up1", ...kv };
  return {
    kv: async (k) => kvAll[k] ?? null,
    text: async (k) => (k in all ? String(all[k]) : null),
    object: async (k, range) => {
      if (!(k in all)) return null;
      const b = Buffer.isBuffer(all[k]) ? all[k] : Buffer.from(all[k]);
      return { body: range ? b.subarray(range.offset, range.offset + range.length) : b };
    },
    sdk: async () => sdk,
  };
}

const req = (url, headers = {}, method = "GET") => ({
  method,
  url,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
});
const go = (url, opts = {}) =>
  handle(req(url, opts.headers, opts.method), { ...PROD, now: () => Date.parse(opts.now || "2026-10-15T12:00:00Z"), ...(opts.env || {}) }, memoryStore(opts.store), {
    libIndex: libraryIndex(libs),
  });

// ---- hosts ----

test("parseHost: live and preview hosts", () => {
  assert.deepEqual(parseHost("bee-game.dhplay.net", PROD), { kind: "live", slug: "bee-game" });
  assert.deepEqual(parseHost("Bee-Game.DHPLAY.net:443", PROD), { kind: "live", slug: "bee-game" });
  assert.deepEqual(parseHost("pr-12--bee-game.dhpreview.net", PROD), { kind: "pr", pr: 12, slug: "bee-game" });
  assert.deepEqual(parseHost("up-01hz3k--bee-game.dhpreview.net", PROD), { kind: "up", uploadId: "01hz3k", slug: "bee-game" });
  assert.deepEqual(parseHost("bee-game.localhost:8790", LOCAL), { kind: "live", slug: "bee-game" });
  assert.deepEqual(parseHost("pr-3--bee-game.localhost:8790", LOCAL), { kind: "pr", pr: 3, slug: "bee-game" });
  assert.deepEqual(parseHost("up-a1-b2--bee-game.localhost", LOCAL), { kind: "up", uploadId: "a1-b2", slug: "bee-game" });
});

test("parseHost: refuses everything else", () => {
  for (const h of ["dhplay.net", "a.b.dhplay.net", "pr-1--bee-game.dhplay.net", "bee--game.dhplay.net", "bee-game-.dhplay.net", "pr-1--bee--game.dhpreview.net", "bee-game.dhpreview.net", "bee-game.evil.net", "x.dhplay.net", "pr-0--bee-game.dhpreview.net", "bee_game.dhplay.net", ""]) {
    assert.equal(parseHost(h, PROD), null, h);
  }
});

// ---- headers ----

test("live HTML: headers and SDK injection", async () => {
  const r = await go("https://bee-game.dhplay.net/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Content-Type"], "text/html; charset=utf-8");
  const csp = r.headers["Content-Security-Policy"];
  for (const d of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' blob:",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors https://degenhive.ai https://www.degenhive.ai",
  ]) {
    assert.ok(csp.includes(d), `CSP has ${d}`);
  }
  for (const f of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "serial=()", "hid=()", "bluetooth=()", "clipboard-read=()", "publickey-credentials-get=()"]) {
    assert.ok(r.headers["Permissions-Policy"].includes(f), f);
  }
  assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(r.headers["X-Robots-Tag"], undefined);
  assert.equal(r.body.split(SDK_TAG).length, 2, "SDK tag exactly once");
  assert.ok(r.body.indexOf(SDK_TAG) > r.body.indexOf('<meta charset="utf-8">'), "after <meta charset>");
  assert.ok(r.body.indexOf(SDK_TAG) < r.body.indexOf("<title>"));
  assert.ok(!r.body.includes("dh-preview-mark"));
});

test("backends are added to connect-src for https and wss", () => {
  const csp = contentSecurityPolicy(PROD, { backends: ["https://api.example.com", "javascript:alert(1)"] });
  assert.ok(csp.includes("connect-src 'self' https://api.example.com wss://api.example.com;"));
  assert.ok(!csp.includes("javascript:"));
});

test("frame-ancestors falls back to 'none'", () => {
  assert.ok(contentSecurityPolicy({ ...PROD, FRAME_ANCESTORS: "" }).includes("frame-ancestors 'none'"));
  // Malformed entries are dropped rather than passed into the header.
  assert.ok(contentSecurityPolicy({ ...PROD, FRAME_ANCESTORS: "https://a.example; script-src *" }).endsWith("frame-ancestors 'none'"));
  assert.ok(contentSecurityPolicy({ ...PROD, FRAME_ANCESTORS: "https://a.example,https://b.example" }).endsWith("frame-ancestors https://a.example https://b.example"));
});

test("previews: watermark and noindex", async () => {
  for (const url of ["https://pr-7--bee-game.dhpreview.net/", "https://up-up1--bee-game.dhpreview.net/"]) {
    const r = await go(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers["X-Robots-Tag"], "noindex, nofollow");
    assert.ok(r.body.includes("Preview · no rewards"));
    assert.ok(r.body.indexOf("dh-preview-mark") < r.body.indexOf("</body>"));
  }
  const css = await go("https://pr-7--bee-game.dhpreview.net/__dh/preview.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["Content-Type"], /text\/css/);
  assert.equal((await go("https://bee-game.dhplay.net/__dh/preview.css")).status, 404);
});

test("upload previews expire after 24 hours", async () => {
  assert.equal((await go("https://up-up1--bee-game.dhpreview.net/", { now: "2026-10-15T23:00:00Z" })).status, 200);
  assert.equal((await go("https://up-up1--bee-game.dhpreview.net/", { now: "2026-10-16T01:00:00Z" })).status, 410);
});

test("takedown: off:<slug> serves the unavailable page with Clear-Site-Data", async () => {
  for (const url of ["https://bee-game.dhplay.net/", "https://bee-game.dhplay.net/game.js", "https://pr-7--bee-game.dhpreview.net/"]) {
    const r = await go(url, { store: { kv: { "off:bee-game": "1" } } });
    assert.equal(r.status, 410, url);
    assert.equal(r.headers["Clear-Site-Data"], '"cache", "cookies", "storage"');
    assert.match(r.body, /unavailable/);
    assert.ok(r.headers["Content-Security-Policy"]);
  }
});

test("service-worker requests are refused", async () => {
  const r = await go("https://bee-game.dhplay.net/sw.js", { headers: { "service-worker": "script" } });
  assert.equal(r.status, 403);
});

test("only GET and HEAD", async () => {
  assert.equal((await go("https://bee-game.dhplay.net/", { method: "POST" })).status, 405);
  const head = await go("https://bee-game.dhplay.net/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test("not found cases", async () => {
  assert.equal((await go("https://nope-game.dhplay.net/")).status, 404);
  assert.equal((await go("https://bee-game.dhplay.net/missing.js")).status, 404);
  assert.equal((await go("https://bee-game.dhplay.net/../kv.json")).status, 404);
  assert.equal((await go("https://bee-game.dhplay.net/%2e%2e/%2e%2e/kv.json")).status, 404);
  assert.equal((await go("https://bee-game.dhplay.net/%E0%A4%A")).status, 404);
  assert.equal((await go("https://bee-game.dhplay.net/Game.js")).status, 404);
  assert.equal((await go("https://pr-8--bee-game.dhpreview.net/")).status, 404);
  assert.equal((await go("https://evil.example/")).status, 404);
  // a live pointer that is not a hash is ignored
  assert.equal((await go("https://bee-game.dhplay.net/", { store: { kv: { "live:bee-game": "../../x" } } })).status, 404);
});

test("a manifest for another slug is not served", async () => {
  const r = await go("https://pr-7--wasp-game.dhpreview.net/");
  assert.equal(r.status, 404);
});

test("directories serve index.html", async () => {
  const r = await go("https://bee-game.dhplay.net/sub/");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("<p>sub</p>"));
  assert.ok(r.body.startsWith(SDK_TAG), "no <head>: the tag goes first");
});

test("binary assets come from assets/<sha256>, with ranges and ETags", async () => {
  const r = await go("https://bee-game.dhplay.net/img/bee.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Content-Type"], "image/png");
  assert.equal(r.headers["Accept-Ranges"], "bytes");
  assert.deepEqual(Buffer.from(r.body), PNG);
  const part = await go("https://bee-game.dhplay.net/img/bee.png", { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers["Content-Range"], `bytes 2-5/${PNG.length}`);
  assert.deepEqual(Buffer.from(part.body), PNG.subarray(2, 6));
  const bad = await go("https://bee-game.dhplay.net/img/bee.png", { headers: { range: "bytes=999-" } });
  assert.equal(bad.status, 416);
  const cached = await go("https://bee-game.dhplay.net/img/bee.png", { headers: { "if-none-match": r.headers.ETag } });
  assert.equal(cached.status, 304);
});

test("the SDK is served on every game host, with a stub when it is missing", async () => {
  const r = await go("https://bee-game.dhplay.net/__dh/sdk.js");
  assert.equal(r.status, 200);
  assert.equal(r.body, "/*sdk*/");
  assert.match(r.headers["Content-Type"], /javascript/);
  const stub = await go("https://bee-game.dhplay.net/__dh/sdk.js", { store: { sdk: null } });
  assert.equal(stub.body, SDK_STUB);
});

test("pinned CDN library URLs are rewritten and served from our copy", async () => {
  const js = await go("https://bee-game.dhplay.net/game.js");
  assert.ok(js.body.includes("from '/__dh/lib/three@0.160.0/build/three.module.js'"));
  assert.ok(!js.body.includes("cdn.jsdelivr.net"));
  const lib = await go("https://bee-game.dhplay.net/__dh/lib/three@0.160.0/build/three.module.js");
  assert.equal(lib.status, 200);
  assert.equal(String(lib.body), "THREE");
  assert.match(lib.headers["Cache-Control"], /immutable/);
  assert.equal((await go("https://bee-game.dhplay.net/__dh/lib/three@0.1.0/build/three.module.js")).status, 404);
});

test("injectHtml", () => {
  assert.equal(injectHtml("<html><head></head></html>"), `<html><head>${SDK_TAG}</head></html>`);
  assert.equal(injectHtml("<!DOCTYPE html><p>x</p>"), `<!DOCTYPE html>${SDK_TAG}<p>x</p>`);
  assert.equal(injectHtml("<p>x</p>"), `${SDK_TAG}<p>x</p>`);
  assert.equal(injectHtml('<html lang="en"><body></body></html>'), `<html lang="en">${SDK_TAG}<body></body></html>`);
  assert.equal(injectHtml("<header></header>"), `${SDK_TAG}<header></header>`, "<header> is not <head>");
  const already = '<head><script src="/__dh/sdk.js"></script></head>';
  assert.equal(injectHtml(already), already);
  const preview = injectHtml("<body><p>x</p></body><!-- </body> -->", { preview: true });
  assert.ok(preview.includes("dh-preview-mark"));
});

test("edge-dev's FRAME_ANCESTORS default matches API.md", () => {
  const src = readFileSync(new URL("../tools/edge-dev/server.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('"http://localhost:3000 http://localhost:3300 https://degenhive.ai"'));
});
