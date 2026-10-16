import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployGame, signBody, changedSlugs } from "../scripts/deploy/deploy.mjs";
import { LocalStorage } from "../scripts/deploy/lib/storage.mjs";
import { signRequest } from "../scripts/deploy/lib/sigv4.mjs";
import { loadGame, gameBuildHash } from "../scripts/lib/game.mjs";
import { startEdgeDev } from "../tools/edge-dev/server.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/games/tiny-canvas", import.meta.url));
const ASSETS = fileURLToPath(new URL("./fixtures/assets-root", import.meta.url));
const quiet = () => {};

/** GET with an explicit Host header (fetch does not let a caller set Host). */
function get(port, host, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("deploy callback signature is sha256=<hex HMAC-SHA256 of the raw body>", () => {
  const body = JSON.stringify({ slug: "tiny-canvas", buildHash: "a".repeat(64), pr: 3, commit: "abc" });
  const expected = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(signBody(body, "s3cret"), expected);
  assert.match(signBody("x", "k"), /^sha256=[0-9a-f]{64}$/);
});

test("SigV4 matches the AWS S3 GET Object example", () => {
  const h = signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    h.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

async function withCallbackServer(status, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, sig: req.headers["x-dh-signature"], type: req.headers["content-type"], body });
      res.writeHead(status, { "Content-Type": "application/json" }).end(status === 409 ? '{"error":{"code":"stale_deploy"}}' : "{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const old = { base: process.env.GAMES_API_BASE, secret: process.env.GAMES_DEPLOY_SECRET };
  process.env.GAMES_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.GAMES_DEPLOY_SECRET = "test-secret";
  try {
    return await fn(seen);
  } finally {
    if (old.base === undefined) delete process.env.GAMES_API_BASE;
    else process.env.GAMES_API_BASE = old.base;
    if (old.secret === undefined) delete process.env.GAMES_DEPLOY_SECRET;
    else process.env.GAMES_DEPLOY_SECRET = old.secret;
    await new Promise((r) => server.close(r));
  }
}

test("local deploy writes the build, sets live and signs the callback; edge-dev serves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "dh-deploy-"));
  try {
    await withCallbackServer(200, async (seen) => {
      const r = await deployGame({ gameDir: FIXTURE, storage: new LocalStorage(root), assetsRoot: ASSETS, commit: "c0ffee", pr: 12, log: quiet });
      assert.equal(r.ok, true, r.problems.join("; "));
      const hash = gameBuildHash(loadGame(FIXTURE));
      assert.equal(r.hash, hash);
      for (const f of ["src/index.html", "src/game.js", "manifest.json"]) assert.ok(existsSync(join(root, "builds/tiny-canvas", hash, f)), f);
      const manifest = JSON.parse(readFileSync(join(root, "builds/tiny-canvas", hash, "manifest.json"), "utf8"));
      assert.equal(manifest.hash, hash);
      assert.equal(manifest.entry, "index.html");
      assert.deepEqual(manifest.files.map((f) => f.path).sort(), ["game.js", "img/dot.png", "index.html"]);
      assert.equal(JSON.parse(readFileSync(join(root, "kv.json"), "utf8"))["live:tiny-canvas"], hash);

      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/v1/games/deployed");
      assert.equal(seen[0].type, "application/json");
      assert.deepEqual(JSON.parse(seen[0].body), { slug: "tiny-canvas", buildHash: hash, pr: 12, commit: "c0ffee" });
      assert.equal(seen[0].sig, "sha256=" + createHmac("sha256", "test-secret").update(seen[0].body).digest("hex"));
    });

    const dev = await startEdgeDev({ root, port: 0 });
    try {
      const game = `tiny-canvas.localhost:${dev.port}`;
      const page = await get(dev.port, game, "/");
      assert.equal(page.status, 200);
      assert.ok(page.body.toString().includes('<script src="/__dh/sdk.js"></script>'));
      assert.match(page.headers["content-security-policy"], new RegExp(`frame-ancestors .*http://localhost:${dev.port}`));
      const png = await get(dev.port, game, "/img/dot.png");
      assert.equal(png.status, 200);
      assert.equal(png.headers["content-type"], "image/png");
      const sdk = await get(dev.port, game, "/__dh/sdk.js");
      assert.equal(sdk.status, 200);
      const host = await get(dev.port, `localhost:${dev.port}`, "/__host?slug=tiny-canvas");
      assert.equal(host.status, 200);
      assert.ok(host.body.toString().includes("hello.ack"));
    } finally {
      await dev.close();
    }

    // A second deploy of the same build is a no-op upload.
    const again = await deployGame({ gameDir: FIXTURE, storage: new LocalStorage(root), assetsRoot: ASSETS, log: quiet });
    assert.equal(again.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 409 stale_deploy leaves live:<slug> alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "dh-deploy-"));
  try {
    writeFileSync(join(root, "kv.json"), JSON.stringify({ "live:tiny-canvas": "b".repeat(64) }));
    await withCallbackServer(409, async () => {
      const r = await deployGame({ gameDir: FIXTURE, storage: new LocalStorage(root), assetsRoot: ASSETS, log: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.stale, true);
    });
    assert.equal(JSON.parse(readFileSync(join(root, "kv.json"), "utf8"))["live:tiny-canvas"], "b".repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy refuses a game whose assets are not in the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "dh-deploy-"));
  try {
    const r = await deployGame({ gameDir: FIXTURE, storage: new LocalStorage(root), log: quiet });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" "), /img\/dot\.png/);
    assert.ok(!existsSync(join(root, "kv.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changedSlugs reads the games touched by a push", () => {
  const repo = mkdtempSync(join(tmpdir(), "dh-git-"));
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    mkdirSync(join(repo, "games"), { recursive: true });
    cpSync(FIXTURE, join(repo, "games/tiny-canvas"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "x");
    g("add", ".");
    g("commit", "-q", "-m", "one");
    const first = g("rev-parse", "HEAD");
    cpSync(FIXTURE, join(repo, "games/other-game"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "y");
    g("add", ".");
    g("commit", "-q", "-m", "two");
    assert.deepEqual(changedSlugs({ cwd: repo, before: first, after: "HEAD" }), ["other-game"]);
    assert.deepEqual(changedSlugs({ cwd: repo, before: "0000000000000000000000000000000000000000", after: "HEAD" }), ["other-game", "tiny-canvas"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
