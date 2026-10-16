#!/usr/bin/env node
// For review.yml: finds the pull request a checks run belongs to and fetches its diff and
// game.json through the GitHub API, as text. Nothing from the pull request is executed.
//
//   node scripts/review/fetch-pr.mjs --artifact <dir> --head-sha <sha> --repo owner/name --out <dir>
//
// Writes <out>/pr.diff, <out>/game.json, <out>/pr.json ({ number, slug, headSha }) or, when the
// review should not run, <out>/skip with the reason. Env: GITHUB_TOKEN.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "../lib/args.mjs";
import { SLUG_RE } from "../lib/protocol.mjs";

const MAX_DIFF = 4 * 1024 * 1024;
const MAX_FILE = 512 * 1024;

async function gh(path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(60000),
  });
  return res;
}

async function json(path) {
  const res = await gh(path);
  if (!res.ok) throw new Error(`GitHub GET ${path}: HTTP ${res.status}`);
  return res.json();
}

async function raw(repo, path, ref) {
  const res = await gh(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, "application/vnd.github.raw");
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > MAX_FILE ? buf.subarray(0, MAX_FILE).toString("utf8") + "\n[... truncated ...]" : buf.toString("utf8");
}

/** A diff built from file contents, for pull requests too large for the diff endpoint. */
async function pseudoDiff(repo, pr, headSha, slug) {
  let out = "";
  for (let page = 1; page <= 30; page++) {
    const files = await json(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!files.length) break;
    for (const f of files) {
      if (!f.filename.startsWith(`games/${slug}/`)) {
        out += `diff --git a/${f.filename} b/${f.filename}\n[outside the game folder: ${f.status}]\n`;
        continue;
      }
      if (f.status === "removed") {
        out += `diff --git a/${f.filename} b/${f.filename}\ndeleted file\n`;
        continue;
      }
      if (f.patch) {
        out += `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`;
        continue;
      }
      const text = await raw(repo, f.filename, headSha);
      if (text === null) continue;
      out += `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n[full file at the head commit]\n` + text.split("\n").map((l) => "+" + l).join("\n") + "\n";
      if (out.length > MAX_DIFF) return out.slice(0, MAX_DIFF);
    }
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs();
  if (!a.artifact || !a.headSha || !a.repo || !a.out) die("usage: fetch-pr.mjs --artifact <dir> --head-sha <sha> --repo owner/name --out <dir>");
  if (!process.env.GITHUB_TOKEN) die("GITHUB_TOKEN is not set");
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });
  const skip = (why) => {
    writeFileSync(join(out, "skip"), why + "\n");
    console.log(`skip: ${why}`);
    process.exit(0);
  };
  if (!/^[0-9a-f]{40}$/.test(a.headSha)) skip("bad head sha");
  if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo)) skip("bad repo name");

  // The artifact says which PR it was for; the API is the source of truth.
  const prFile = join(resolve(a.artifact), "pr.json");
  if (!existsSync(prFile)) skip("the checks artifact has no pr.json");
  let claimed;
  try {
    claimed = JSON.parse(readFileSync(prFile, "utf8"));
  } catch {
    skip("pr.json is not valid JSON");
  }
  const number = Number(claimed && claimed.number);
  if (!Number.isInteger(number) || number <= 0) skip("pr.json has no PR number");
  const pull = await json(`/repos/${a.repo}/pulls/${number}`);
  if (pull.head.sha !== a.headSha) skip(`PR #${number} is now at ${pull.head.sha.slice(0, 7)}, not ${a.headSha.slice(0, 7)}; a newer run will review it`);
  if (pull.state !== "open") skip(`PR #${number} is ${pull.state}`);

  let slug = null;
  try {
    slug = JSON.parse(readFileSync(join(resolve(a.artifact), "checks.json"), "utf8")).slug;
  } catch {
    slug = claimed.slug;
  }
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) skip("no valid slug in the checks artifact");

  let diff = null;
  const res = await gh(`/repos/${a.repo}/pulls/${number}`, "application/vnd.github.diff");
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= MAX_DIFF) diff = buf.toString("utf8");
  }
  if (diff === null) diff = await pseudoDiff(a.repo, number, a.headSha, slug);
  writeFileSync(join(out, "pr.diff"), diff);

  const gameJson = await raw(a.repo, `games/${slug}/game.json`, a.headSha);
  if (gameJson !== null) writeFileSync(join(out, "game.json"), gameJson);
  writeFileSync(join(out, "pr.json"), JSON.stringify({ number, slug, headSha: a.headSha }) + "\n");
  console.log(`PR #${number} (${slug}): ${diff.length} bytes of diff`);
}
