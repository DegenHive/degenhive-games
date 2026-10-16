#!/usr/bin/env node
// The checks of a game pull request. Writes checks.json (plans/games/API.md section 5, CheckItem).
//
//   node scripts/checks/run.mjs --game games/<slug> [--base <ref>] [--out checks.json]
//        [--shots <dir>] [--assets-root <dir>] [--assets-url <url>] [--seconds 60]
//        [--viewports desktop,phone] [--libs-dir <dir>] [--no-fetch-libs] [--no-sandbox] [--no-fail]
//
// Exit code 1 when a check fails (unless --no-fail), 2 on bad usage.
import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "../lib/args.mjs";
import { loadGame, gameBuildHash } from "../lib/game.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { SLUG_RE } from "../lib/protocol.mjs";
import { scopeCheck } from "./lib/scope.mjs";
import { layoutItem, schemaItem, limitsItem, typesItem } from "./lib/limits.mjs";
import { assetsCheck } from "./lib/assets.mjs";
import { loadRules, scanBuild, rulesItems } from "./lib/rules.mjs";
import { secretsItem, malwareItem } from "./lib/tools.mjs";
import { runSandbox, sandboxItems } from "./sandbox.mjs";

const SDK_DIST = fileURLToPath(new URL("../../packages/sdk/dist/sdk.js", import.meta.url));

/** The SDK, if someone vendors it into a game, counts as a library rather than own code. */
function sdkLibraries(cwd) {
  const out = [];
  for (const p of [SDK_DIST, join(cwd, "packages/sdk/dist/sdk.js")]) {
    if (existsSync(p)) out.push({ name: "@degenhive/game-sdk", version: "local", file: "dist/sdk.js", sha256: sha256Hex(readFileSync(p)) });
  }
  return out;
}

/**
 * Runs every check. Returns the checks.json object.
 * @param {object} o
 */
export async function runChecks(o) {
  const cwd = resolve(o.cwd || process.cwd());
  const gameDir = resolve(cwd, o.game);
  const log = o.log || (() => {});
  const game = loadGame(gameDir);
  const items = [];
  const needsHuman = [];

  const scope = scopeCheck({ cwd, slug: game.slug, base: o.base, currentGame: game.game });
  items.push(...scope.items);

  if (!existsSync(gameDir)) {
    items.push({ key: "layout", label: "Game folder layout", status: "fail", detail: `${o.game} does not exist.` });
    return finish({ game, scope, items, needsHuman, o });
  }

  items.push(layoutItem(game));
  items.push(schemaItem(game, { kind: scope.kind, baseGame: scope.baseGame }));
  items.push(limitsItem(game));
  const types = typesItem(game);
  items.push(types.item);
  needsHuman.push(...types.needsHuman);
  const backends = game.game && Array.isArray(game.game.backends) ? game.game.backends.filter((b) => typeof b === "string") : [];
  if (backends.length) needsHuman.push(...backends.map((b) => `backend: ${b}`));
  if (scope.kind === "update" && scope.baseGame && game.game && scope.baseGame.owner !== game.game.owner) needsHuman.push("owner change");

  let tmpAssets = null;
  if (!o.assetsRoot && o.assetsUrl) tmpAssets = mkdtempSync(join(tmpdir(), "dh-assets-"));
  const assets = await assetsCheck(game, { assetsRoot: o.assetsRoot, assetsUrl: o.assetsUrl, downloadDir: tmpAssets });
  items.push(assets.item);

  const compiled = loadRules();
  const scan = scanBuild(game, compiled, { backends, extraLibraries: sdkLibraries(cwd) });
  scan.findings.push(...assets.svgFindings);
  items.push(...rulesItems(scan));

  items.push(secretsItem(gameDir));
  items.push(malwareItem([gameDir, ...assets.files]));

  let sandbox = null;
  let screenshots = [];
  const entry = (game.game && typeof game.game.entry === "string" && game.game.entry) || "index.html";
  if (o.sandbox === false) {
    items.push({ key: "sandbox", label: "Sandbox run", status: "warn", detail: "Skipped (--no-sandbox)." });
  } else if (!game.src.some((f) => f.path === entry) || !SLUG_RE.test(game.slug)) {
    items.push({ key: "sandbox", label: "Sandbox run", status: "fail", detail: "Not run: the entry file or the slug is not valid." });
  } else {
    const shotsDir = resolve(o.shots || join(dirname(resolve(o.out || "checks.json")), "screenshots"));
    try {
      sandbox = await runSandbox({
        game,
        assetsRoot: assets.localRoot,
        seconds: Number(o.seconds || 60),
        shotsDir,
        viewports: o.viewports ? String(o.viewports).split(",") : ["desktop", "phone"],
        ...(o.libsDir ? { libsDir: resolve(o.libsDir) } : {}),
        fetchLibs: o.fetchLibs !== false,
        log,
      });
    } catch (e) {
      sandbox = { skipped: `the sandbox crashed: ${String(e && e.message).split("\n")[0]}`, viewports: {} };
    }
    items.push(...sandboxItems(sandbox, game, { backends }));
    screenshots = Object.values(sandbox.viewports || {}).flatMap((v) => v.screenshots.map((s) => basename(s)));
  }
  if (tmpAssets) rmSync(tmpAssets, { recursive: true, force: true });

  return finish({ game, scope, items, needsHuman, o, sandbox, screenshots, scan });
}

function finish({ game, scope, items, needsHuman, o, sandbox = null, screenshots = [], scan = null }) {
  const status = items.some((i) => i.status === "fail") ? "fail" : "pass";
  let buildHash = null;
  try {
    buildHash = gameBuildHash(game);
  } catch {
    buildHash = null; // an assets.json entry without a valid sha256
  }
  return {
    version: 1,
    slug: game.slug,
    kind: scope.kind,
    textOnly: scope.textOnly,
    needsHuman,
    buildHash,
    base: o.base || null,
    changed: scope.changed,
    status,
    items,
    findings: scan ? scan.findings.map(({ rule, lens, severity, file, line, excerpt, message }) => ({ rule, lens, severity, file, line, excerpt, message })) : [],
    external: scan ? scan.external.filter((e) => e.severity) : [],
    sandbox: sandbox
      ? {
          skipped: sandbox.skipped || null,
          viewports: Object.fromEntries(
            Object.entries(sandbox.viewports || {}).map(([k, v]) => [k, { ...v, screenshots: v.screenshots.map((s) => basename(s)) }]),
          ),
        }
      : null,
    screenshots,
    generatedAt: new Date().toISOString(),
  };
}

const ICON = { pass: "pass", warn: "WARN", fail: "FAIL", pending: "....", running: "...." };

function printSummary(result) {
  console.log(`\nchecks for ${result.slug} (${result.kind || "scope not checked"}): ${result.status.toUpperCase()}`);
  for (const i of result.items) console.log(`  ${ICON[i.status].padEnd(4)}  ${i.label.padEnd(24)} ${i.detail ? i.detail.slice(0, 160) : ""}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2), { flags: ["no-sandbox", "no-fail", "quiet"] });
  if (!a.game) die("usage: node scripts/checks/run.mjs --game games/<slug> [--base <ref>] [--out checks.json] [--assets-root <dir>] [--assets-url <url>] [--seconds 60] [--no-sandbox]");
  const out = resolve(a.out || "checks.json");
  const result = await runChecks({
    game: a.game,
    base: a.base,
    out,
    shots: a.shots,
    assetsRoot: a.assetsRoot,
    assetsUrl: a.assetsUrl,
    seconds: a.seconds,
    viewports: a.viewports,
    sandbox: a.sandbox,
    libsDir: a.libsDir,
    fetchLibs: a.fetchLibs,
    log: a.quiet ? () => {} : (m) => console.error(m),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  if (!a.quiet) printSummary(result);
  console.log(`\nwrote ${out}`);
  if (result.status === "fail" && a.fail !== false) process.exit(1);
}
