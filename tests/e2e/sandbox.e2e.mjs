// End to end: a game PR in a throwaway git repo, the full checks with the sandbox run in
// Playwright Chromium, the review without a key, and the PR comment.
//   npm run test:e2e        (needs: npx playwright install chromium)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(ROOT, "tests/fixtures/games/tiny-canvas");
const ASSETS = join(ROOT, "tests/fixtures/assets-root");
const SECONDS = process.env.E2E_SECONDS || "10";

function repoWithGame() {
  const repo = mkdtempSync(join(tmpdir(), "dh-e2e-"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "README.md"), "games\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "build/tiny-canvas/1");
  mkdirSync(join(repo, "games"), { recursive: true });
  cpSync(FIXTURE, join(repo, "games/tiny-canvas"), { recursive: true });
  git("add", ".");
  git("commit", "-q", "-m", "tiny-canvas: build 1");
  return { repo, git };
}

function runChecks(repo, extra = []) {
  const out = join(repo, ".out");
  const r = spawnSync("node", [join(ROOT, "scripts/checks/run.mjs"), "--game", "games/tiny-canvas", "--base", "main", "--assets-root", ASSETS, "--out", join(out, "checks.json"), "--quiet", ...extra], {
    cwd: repo,
    encoding: "utf8",
    timeout: 300000,
  });
  const checks = existsSync(join(out, "checks.json")) ? JSON.parse(readFileSync(join(out, "checks.json"), "utf8")) : null;
  return { code: r.status, stderr: r.stderr, checks, out };
}

const item = (checks, key) => checks.items.find((i) => i.key === key);

test("a clean game passes every check, on desktop and phone", { timeout: 300000 }, () => {
  const { repo } = repoWithGame();
  try {
    const detect = spawnSync("node", [join(ROOT, "scripts/checks/detect.mjs"), "--base", "main"], { cwd: repo, encoding: "utf8" });
    assert.equal(detect.stdout.trim(), "tiny-canvas");

    const { code, checks, out, stderr } = runChecks(repo, ["--seconds", SECONDS]);
    assert.ok(checks, stderr);
    const failed = checks.items.filter((i) => i.status === "fail");
    assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
    assert.equal(code, 0);
    assert.equal(checks.kind, "new");
    assert.equal(checks.status, "pass");
    assert.equal(item(checks, "scope").status, "pass");
    assert.equal(item(checks, "assets").status, "pass");
    assert.equal(item(checks, "sandbox.ready").status, "pass");
    assert.equal(item(checks, "sandbox.runs").status, "pass");
    assert.equal(item(checks, "sandbox.csp").status, "pass");
    assert.equal(item(checks, "sandbox.network").status, "pass");
    for (const vp of ["desktop", "phone"]) {
      const v = checks.sandbox.viewports[vp];
      assert.equal(v.handshake, true, `${vp} handshake`);
      assert.ok(v.readyMs !== null && v.readyMs < 10000, `${vp} ready`);
      assert.ok(v.calls.runEnd >= 1, `${vp} ended a run`);
      assert.ok(v.runs.every((r) => r.ends <= 1), `${vp} runEnd once per run`);
      assert.ok(existsSync(join(out, "screenshots", `${vp}-5s.png`)), `${vp} screenshot`);
    }
    assert.match(checks.buildHash, /^[0-9a-f]{64}$/);

    // Review without a key, then the comment.
    execFileSync("node", [join(ROOT, "scripts/review/review.mjs"), "--game", "games/tiny-canvas", "--base", "main", "--checks", join(out, "checks.json"), "--out", join(out, "verdict.json")], {
      cwd: repo,
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      stdio: "pipe",
    });
    const verdict = JSON.parse(readFileSync(join(out, "verdict.json"), "utf8"));
    assert.equal(verdict.verdict, "flag");
    const comment = execFileSync("node", [join(ROOT, "scripts/review/comment.mjs"), "--checks", join(out, "checks.json"), "--verdict", join(out, "verdict.json")], { encoding: "utf8" });
    assert.match(comment, /Ready within 10 s \| pass/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("calling runEnd twice for one run fails the sandbox check", { timeout: 300000 }, () => {
  const { repo, git } = repoWithGame();
  try {
    const file = join(repo, "games/tiny-canvas/src/game.js");
    const src = readFileSync(file, "utf8").replace("DegenHive.runEnd({ score }).then(", "DegenHive.runEnd({ score }); DegenHive.runEnd({ score }).then(");
    assert.ok(src.includes("DegenHive.runEnd({ score }); DegenHive.runEnd"));
    writeFileSync(file, src);
    git("commit", "-q", "-am", "double end");
    const { code, checks } = runChecks(repo, ["--seconds", "8", "--viewports", "desktop"]);
    assert.equal(code, 1);
    const runs = item(checks, "sandbox.runs");
    assert.equal(runs.status, "fail");
    assert.match(runs.fixPrompt, /exactly once per run/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("wallet code and files outside the game fail the static checks", { timeout: 120000 }, () => {
  const { repo, git } = repoWithGame();
  try {
    writeFileSync(join(repo, "games/tiny-canvas/src/connect.js"), "export async function connect() {\n  return window.ethereum.request({ method: 'eth_requestAccounts' });\n}\n");
    writeFileSync(join(repo, "README.md"), "changed\n");
    git("add", ".");
    git("commit", "-q", "-m", "wallet");
    const { code, checks } = runChecks(repo, ["--no-sandbox"]);
    assert.equal(code, 1);
    assert.equal(item(checks, "scope").status, "fail");
    const rules = item(checks, "rules");
    assert.equal(rules.status, "fail");
    assert.match(rules.detail, /src\/connect\.js:2 wallet-ethereum/);
    assert.ok(checks.findings.some((f) => f.rule === "wallet-rpc-method"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
