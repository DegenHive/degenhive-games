#!/usr/bin/env node
// For checks.yml: names the game a pull request touches, so the checks know what to run on.
//
//   node scripts/checks/detect.mjs --base <sha>      (run inside the pull request checkout)
//
// Prints the folder name and, under GitHub Actions, writes slug=<name> to $GITHUB_OUTPUT. When the
// PR touches several games, the first is named and run.mjs fails the scope check; when the name
// is not safe to pass around, "invalid" is named and the layout check fails.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs, die } from "../lib/args.mjs";

const a = parseArgs();
if (!a.base) die("usage: node scripts/checks/detect.mjs --base <sha>");
const mergeBase = execFileSync("git", ["merge-base", a.base, "HEAD"], { encoding: "utf8" }).trim();
const changed = execFileSync("git", ["diff", "--name-only", "--no-renames", mergeBase, "HEAD"], { encoding: "utf8" }).split("\n");
const names = [...new Set(changed.map((p) => /^games\/([^/]+)\//.exec(p)).filter(Boolean).map((m) => m[1]))].sort();
let slug = names[0] || "none";
if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug) || slug.startsWith(".")) slug = "invalid";
if (names.length > 1) console.error(`this PR touches ${names.length} games: ${names.slice(0, 5).join(", ")}`);
console.log(slug);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `slug=${slug}\n`);
