// Scope of a pull request: it changes exactly one games/<slug>/ directory.
import { execFileSync } from "node:child_process";
import { SLUG_RE } from "../../lib/protocol.mjs";

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

const TEXT_ONLY_FIELDS = ["title", "pitch", "tags"];

/**
 * @param {{ cwd: string, slug: string, base?: string, currentGame?: object|null }} opts
 * @returns {{ items: object[], kind: "new"|"update"|null, changed: string[], textOnly: boolean, baseGame: object|null, mergeBase: string|null }}
 */
export function scopeCheck({ cwd, slug, base, currentGame = null }) {
  const items = [];
  const out = { items, kind: null, changed: [], textOnly: false, baseGame: null, mergeBase: null };

  if (!SLUG_RE.test(slug)) {
    items.push({
      key: "slug",
      label: "Slug",
      status: "fail",
      detail: `"${slug}" is not a valid slug: 3 to 32 characters, a-z, 0-9 and -, starting with a letter, not ending with - and with no --.`,
      fixPrompt: `Rename the folder games/${slug}/ to a valid slug (3 to 32 characters: lower-case letters, digits and single hyphens, starting with a letter and not ending with a hyphen) and set the same value as "slug" in game.json.`,
    });
  }

  if (!base) {
    items.push({ key: "scope", label: "One game per PR", status: "warn", detail: "No --base given, so the PR scope was not checked." });
    return out;
  }

  const mergeBase = (git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }) || "").trim();
  if (!mergeBase) {
    items.push({ key: "scope", label: "One game per PR", status: "fail", detail: `Could not find a common commit with ${base}.` });
    return out;
  }
  out.mergeBase = mergeBase;

  // Committed and uncommitted changes since the merge base, plus untracked files.
  const diff = git(cwd, ["diff", "--name-only", "--no-renames", mergeBase]).split("\n").filter(Boolean);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  const changed = [...new Set([...diff, ...untracked])].sort();
  out.changed = changed;

  const games = new Set();
  const outside = [];
  for (const p of changed) {
    const m = /^games\/([^/]+)\//.exec(p);
    if (m) games.add(m[1]);
    else outside.push(p);
  }

  const problems = [];
  if (outside.length) problems.push(`changes files outside games/: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`);
  if (games.size > 1) problems.push(`changes ${games.size} games: ${[...games].slice(0, 5).join(", ")}`);
  if (games.size === 1 && !games.has(slug)) problems.push(`changes games/${[...games][0]}/, not games/${slug}/`);
  if (games.size === 0) problems.push("changes no game");

  const baseGameRaw = git(cwd, ["show", `${mergeBase}:games/${slug}/game.json`], { allowFail: true });
  out.kind = baseGameRaw === null ? "new" : "update";
  if (baseGameRaw) {
    try {
      out.baseGame = JSON.parse(baseGameRaw);
    } catch {
      out.baseGame = null;
    }
  }
  if (out.kind === "update" && changed.includes(`games/${slug}/game.json`) && git(cwd, ["cat-file", "-e", `HEAD:games/${slug}/game.json`], { allowFail: true }) === null) {
    problems.push("deletes the game; takedowns are done with off:<slug>, not by deleting the folder");
  }

  items.push(
    problems.length
      ? {
          key: "scope",
          label: "One game per PR",
          status: "fail",
          detail: `This PR ${problems.join("; ")}.`,
          fixPrompt: `Change only files inside games/${slug}/ in this pull request. Move other changes to their own pull request.`,
        }
      : {
          key: "scope",
          label: "One game per PR",
          status: "pass",
          detail: `${out.kind === "new" ? "New game" : "Update"}: ${changed.length} file(s) in games/${slug}/.`,
        },
  );

  // Text-only: an update that touches only prose files and the title, pitch or tags.
  if (out.kind === "update" && !problems.length) {
    const own = changed.filter((p) => p.startsWith(`games/${slug}/`)).map((p) => p.slice(`games/${slug}/`.length));
    const proseOnly = own.every((p) => p === "game.json" || /^src\/.+\.(md|txt|csv)$/.test(p));
    let gameOk = true;
    if (own.includes("game.json")) {
      try {
        const head = currentGame || JSON.parse(git(cwd, ["show", `HEAD:games/${slug}/game.json`]));
        const keys = new Set([...Object.keys(head), ...Object.keys(out.baseGame || {})]);
        gameOk = [...keys].every((k) => TEXT_ONLY_FIELDS.includes(k) || JSON.stringify(head[k]) === JSON.stringify((out.baseGame || {})[k]));
      } catch {
        gameOk = false;
      }
    }
    out.textOnly = proseOnly && gameOk && own.length > 0;
  }
  return out;
}
