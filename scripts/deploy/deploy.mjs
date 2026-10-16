#!/usr/bin/env node
// Deploys merged games: plans/GAMES-BUILD-PLAN.md "deploy.yml" and plans/games/API.md section 1.
//
// For each games/<slug>/ changed between --before and --after (or each --game):
//   1. compute the build hash (scripts/lib/hash.mjs);
//   2. check every binary in assets.json, and every pinned library the game loads, is in assets/;
//   3. upload src/ to builds/<slug>/<hash>/src/ and write builds/<slug>/<hash>/manifest.json last;
//   4. POST { slug, buildHash, pr, commit } to <GAMES_API_BASE>/v1/games/deployed, signed with
//      X-DH-Signature: sha256=<hex HMAC-SHA256 of the raw body under GAMES_DEPLOY_SECRET>;
//   5. set KV live:<slug> = <hash>, unless the backend answered 409 stale_deploy (it already has a
//      newer build, so the older one must not replace it at the edge).
//
//   node scripts/deploy/deploy.mjs --before <sha> --after <sha>           Cloudflare (env below)
//   node scripts/deploy/deploy.mjs --game games/<slug> --local <root>     local storage root
//   options: [--assets-root <dir>] [--libs-dir <dir>] [--pr <n>] [--commit <sha>] [--sdk]
//            [--takedown <slug>] [--restore <slug>] [--dry-run]
//
// Env for Cloudflare: CF_API_TOKEN, CF_ACCOUNT_ID, R2_BUCKET (default dh-games), KV_NAMESPACE_ID,
// optional R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY. Callback: GAMES_API_BASE, GAMES_DEPLOY_SECRET.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "../lib/args.mjs";
import { loadGame, buildManifest } from "../lib/game.mjs";
import { SLUG_RE, mimeOf } from "../lib/protocol.mjs";
import { libraryIndex } from "../lib/cdn.mjs";
import { referencedLibraries, ensureLibraries, DEFAULT_LIBS_DIR } from "../lib/libs.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { validateGameJson, formatErrors } from "../checks/lib/schema.mjs";
import { limitsItem, typesItem, layoutItem } from "../checks/lib/limits.mjs";
import { RULES_PATH } from "../checks/lib/rules.mjs";
import { LocalStorage, CloudflareStorage } from "./lib/storage.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ZERO = /^0+$/;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Slugs whose folder changed between two commits; every game when there is no usable before. */
export function changedSlugs({ cwd, before, after = "HEAD" }) {
  let paths;
  if (!before || ZERO.test(before)) {
    paths = git(["ls-tree", "-r", "--name-only", after, "--", "games/"], cwd).split("\n");
  } else {
    paths = git(["diff", "--name-only", "--no-renames", before, after, "--", "games/"], cwd).split("\n");
  }
  const slugs = new Set();
  for (const p of paths) {
    const m = /^games\/([^/]+)\//.exec(p);
    if (m) slugs.add(m[1]);
  }
  return [...slugs].sort();
}

/** X-DH-Signature value for the deploy callback: "sha256=" + hex HMAC-SHA256 of the raw body. */
export function signBody(body, secret) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function findPr({ commit, cwd }) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token && repo && commit) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/commits/${commit}/pulls`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const pulls = await res.json();
        const merged = pulls.find((p) => p.merged_at) || pulls[0];
        if (merged) return merged.number;
      }
    } catch {
      // fall back to the commit message
    }
  }
  try {
    const msg = git(["log", "-1", "--format=%s", commit || "HEAD"], cwd);
    const m = /\(#(\d+)\)\s*$/.exec(msg) || /^Merge pull request #(\d+)/.exec(msg);
    if (m) return Number(m[1]);
  } catch {
    // no git history
  }
  return null;
}

/** Returns "ok", "skipped", "stale" (409 stale_deploy) or "failed". */
async function callback({ slug, buildHash, pr, commit, log }) {
  const base = process.env.GAMES_API_BASE;
  const secret = process.env.GAMES_DEPLOY_SECRET;
  if (!base || !secret) {
    log(`  callback skipped: GAMES_API_BASE or GAMES_DEPLOY_SECRET is not set`);
    return "skipped";
  }
  const body = JSON.stringify({ slug, buildHash, pr, commit });
  const url = `${base.replace(/\/+$/, "")}/v1/games/deployed`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-DH-Signature": signBody(body, secret) },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        log(`  callback ok: ${res.status}`);
        return "ok";
      }
      const text = (await res.text().catch(() => "")).slice(0, 300);
      log(`  callback HTTP ${res.status}: ${text}`);
      if (res.status === 409) return "stale";
      if (res.status < 500 && res.status !== 429) return "failed";
    } catch (e) {
      log(`  callback failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  return "failed";
}

/** Deploys one game. Returns { slug, hash, ok, problems }. */
export async function deployGame({ gameDir, storage, assetsRoot = null, libsDir = DEFAULT_LIBS_DIR, fetchLibs = true, commit = null, pr = null, dryRun = false, log = console.log }) {
  const game = loadGame(gameDir);
  const problems = [];
  if (!SLUG_RE.test(game.slug)) problems.push(`"${game.slug}" is not a valid slug`);
  if (!game.game) problems.push(`game.json is ${game.gameError || "missing"}`);
  else problems.push(...formatErrors(validateGameJson(game.game), "game.json"));
  if (game.game && game.game.slug !== game.slug) problems.push("game.json slug does not match the folder");
  for (const item of [layoutItem(game), limitsItem(game), typesItem(game).item]) if (item.status === "fail") problems.push(item.detail);
  if (problems.length) return { slug: game.slug, hash: null, ok: false, problems };

  const manifest = buildManifest(game, { commit, createdAt: new Date().toISOString() });
  const { hash } = manifest;
  const base = `builds/${game.slug}/${hash}`;
  log(`${game.slug}: build ${hash} (${manifest.files.length} files) to ${storage.describe()}`);

  // Binaries are uploaded by the BE into assets/<sha256>; a local run may copy them from --assets-root.
  for (const a of game.assets) {
    const key = `assets/${a.sha256}`;
    if (await storage.has(key)) continue;
    const local = assetsRoot ? join(resolve(assetsRoot), "assets", a.sha256) : null;
    if (local && existsSync(local) && sha256Hex(readFileSync(local)) === a.sha256) {
      if (!dryRun) await storage.put(key, readFileSync(local), a.type || mimeOf(a.path));
      log(`  asset ${a.path} copied from --assets-root`);
    } else {
      problems.push(`asset ${a.path} (${a.sha256}) is not in the store`);
    }
  }

  // Pinned libraries the game loads by CDN URL, served by the edge from assets/<sha256>.
  const libIndex = libraryIndex(JSON.parse(readFileSync(RULES_PATH, "utf8")).libraries);
  const libs = referencedLibraries(game, libIndex);
  const needLibs = [];
  for (const lib of libs) if (!(await storage.has(`assets/${lib.sha256}`))) needLibs.push(lib);
  if (needLibs.length) {
    const { present, missing } = await ensureLibraries(needLibs, { dir: libsDir, fetchMissing: fetchLibs });
    for (const lib of present) {
      if (!dryRun) await storage.put(`assets/${lib.sha256}`, readFileSync(join(libsDir, "assets", lib.sha256)), "text/javascript; charset=utf-8");
      log(`  library ${lib.name}@${lib.version}/${lib.file} uploaded`);
    }
    for (const m of missing) problems.push(`library ${m.lib.name}@${m.lib.version}/${m.lib.file}: ${m.reason}`);
  }
  if (problems.length) return { slug: game.slug, hash, ok: false, problems };

  if (dryRun) {
    log(`  dry run: would upload ${game.src.length} file(s), write ${base}/manifest.json and set live:${game.slug}`);
    return { slug: game.slug, hash, ok: true, problems, dryRun: true };
  }

  if (await storage.has(`${base}/manifest.json`)) {
    log(`  build already stored`);
  } else {
    for (const f of game.src) {
      if (f.symlink || f.special) continue;
      await storage.put(`${base}/src/${f.path}`, readFileSync(f.abs), mimeOf(f.path));
    }
    await storage.put(`${base}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "application/json");
    log(`  uploaded ${game.src.length} file(s) and the manifest`);
  }
  const cb = await callback({ slug: game.slug, buildHash: hash, pr, commit, log });
  if (cb === "stale") {
    log(`::notice::${game.slug}: the backend already has a newer build; live:${game.slug} was left as it is`);
    return { slug: game.slug, hash, ok: true, stale: true, problems };
  }
  await storage.kvPut(`live:${game.slug}`, hash);
  log(`  live:${game.slug} = ${hash}`);
  if (cb === "failed") problems.push("the deploy callback to the backend failed; the build is live but the site does not know yet");
  return { slug: game.slug, hash, ok: cb !== "failed", problems };
}

function storageFromEnv(a) {
  if (a.local) return new LocalStorage(a.local);
  const env = process.env;
  const missing = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "KV_NAMESPACE_ID"].filter((k) => !env[k]);
  if (missing.length) return { missing };
  return new CloudflareStorage({
    apiToken: env.CF_API_TOKEN,
    accountId: env.CF_ACCOUNT_ID,
    bucket: env.R2_BUCKET || "dh-games",
    kvNamespaceId: env.KV_NAMESPACE_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID || null,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || null,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2), { flags: ["dry-run", "sdk"] });
  const cwd = process.cwd();
  const storage = storageFromEnv(a);
  if (storage.missing) {
    console.log(`::notice::Deploy skipped: ${storage.missing.join(", ")} not set.`);
    process.exit(0);
  }
  const log = (m) => console.log(m);

  if (a.takedown || a.restore) {
    const slug = a.takedown || a.restore;
    if (!SLUG_RE.test(slug)) die(`bad slug: ${slug}`);
    if (a.takedown) await storage.kvPut(`off:${slug}`, "1");
    else await storage.kvDelete(`off:${slug}`);
    log(`${a.takedown ? "took down" : "restored"} ${slug} in ${storage.describe()}`);
    process.exit(0);
  }

  if (a.sdk) {
    const sdk = join(REPO, "packages/sdk/dist/sdk.js");
    if (!existsSync(sdk)) die("packages/sdk/dist/sdk.js is missing");
    if (storage.kind === "local") log("SDK: edge-dev serves packages/sdk/dist/sdk.js directly; nothing to upload");
    else if (!a.dryRun) {
      await storage.put("sdk/sdk.js", readFileSync(sdk), "text/javascript; charset=utf-8");
      log(`SDK uploaded to sdk/sdk.js (${sha256Hex(readFileSync(sdk)).slice(0, 12)})`);
    }
  }

  const games = a.game ? [].concat(a.game) : a.before !== undefined || a.after !== undefined ? changedSlugs({ cwd, before: a.before, after: a.after || "HEAD" }).map((s) => `games/${s}`) : [];
  if (!games.length && !a.sdk) {
    log("No games to deploy.");
    process.exit(0);
  }
  const commit = a.commit || (a.after && !ZERO.test(a.after) ? a.after : null) || (() => {
    try {
      return git(["rev-parse", "HEAD"], cwd).trim();
    } catch {
      return null;
    }
  })();
  const pr = a.pr !== undefined ? Number(a.pr) : await findPr({ commit, cwd });

  let failed = 0;
  for (const g of games) {
    const dir = resolve(cwd, g);
    if (!existsSync(join(dir, "game.json"))) {
      log(`${g}: no game.json at this commit (deleted?); skipped. Use --takedown to stop serving a game.`);
      continue;
    }
    const r = await deployGame({
      gameDir: dir,
      storage,
      assetsRoot: a.assetsRoot || null,
      libsDir: a.libsDir ? resolve(a.libsDir) : DEFAULT_LIBS_DIR,
      fetchLibs: a.fetchLibs !== false,
      commit,
      pr,
      dryRun: !!a.dryRun,
      log,
    });
    if (!r.ok) {
      failed++;
      for (const p of r.problems) console.log(`::error::${r.slug}: ${p}`);
    }
  }
  if (failed) process.exit(1);
}

