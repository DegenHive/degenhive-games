// Layout, game.json, limits and file types: docs/PROTOCOL.md sections 1, 2.1, 2.2 and 3.
import { LIMITS, fileKind, pathProblem, extOf } from "../../lib/protocol.mjs";
import { validateGameJson, formatErrors } from "./schema.mjs";

const MB = 1024 * 1024;
const mb = (n) => `${(n / MB).toFixed(1)} MB`;
const list = (xs, n = 6) => xs.slice(0, n).join(", ") + (xs.length > n ? `, and ${xs.length - n} more` : "");

export function layoutItem(game) {
  const problems = [];
  const fixes = [];
  if (game.gameError === "missing") {
    problems.push("game.json is missing");
    fixes.push(`Add games/${game.slug}/game.json as described in docs/PROTOCOL.md section 3.`);
  }
  if (!game.src.length) {
    problems.push("src/ is missing or empty");
    fixes.push(`Put the game's text files in games/${game.slug}/src/, with the entry file (index.html) at src/index.html.`);
  }
  if (game.extra.length) {
    problems.push(`unexpected entries next to game.json: ${list(game.extra)}`);
    fixes.push(`games/${game.slug}/ may hold only game.json, assets.json and src/. Move ${list(game.extra)} into src/ (text files) or assets.json (binaries), or delete them.`);
  }
  const links = game.src.filter((f) => f.symlink || f.special).map((f) => `src/${f.path}`);
  if (links.length) {
    problems.push(`symbolic links or special files: ${list(links)}`);
    fixes.push(`Replace ${list(links)} with regular files.`);
  }
  return problems.length
    ? { key: "layout", label: "Game folder layout", status: "fail", detail: problems.join("; ") + ".", fixPrompt: fixes.join(" ") }
    : { key: "layout", label: "Game folder layout", status: "pass", detail: `game.json, ${game.assets.length ? "assets.json, " : ""}src/ with ${game.src.length} file(s).` };
}

/** game.json against schemas/game.schema.json plus the rules the schema cannot express. */
export function schemaItem(game, { kind = null, baseGame = null } = {}) {
  const key = "schema";
  const label = "game.json";
  if (game.gameError && game.gameError !== "missing") {
    return { key, label, status: "fail", detail: `game.json is ${game.gameError}.`, fixPrompt: "Make game.json valid JSON (double-quoted keys and strings, no trailing commas, no comments)." };
  }
  if (!game.game) return { key, label, status: "fail", detail: "game.json is missing." };
  const g = game.game;
  const errors = formatErrors(validateGameJson(g), "game.json");
  const warns = [];
  if (typeof g.slug === "string" && g.slug !== game.slug) errors.push(`game.json slug: "${g.slug}" must equal the folder name "${game.slug}"`);
  const srcPaths = new Set(game.src.map((f) => f.path));
  const entry = g.entry || "index.html";
  if (typeof entry === "string" && !srcPaths.has(entry)) errors.push(`game.json entry: src/${entry} does not exist`);
  if (typeof g.sim === "string" && !srcPaths.has(g.sim)) errors.push(`game.json sim: src/${g.sim} does not exist`);
  if (g.scored === false && g.scoring) warns.push("scoring is ignored because scored is false");
  if (Array.isArray(g.backends) && g.backends.length) warns.push(`declares backends (${g.backends.join(", ")}); each needs a human approval`);
  if (kind === "update" && baseGame) {
    if (baseGame.owner && g.owner !== baseGame.owner) warns.push(`owner changed from ${baseGame.owner} to ${g.owner}; only DegenHive changes the owner`);
    const before = new Set(Array.isArray(baseGame.backends) ? baseGame.backends : []);
    const added = (Array.isArray(g.backends) ? g.backends : []).filter((b) => !before.has(b));
    if (added.length) warns.push(`adds backends: ${added.join(", ")}`);
    if (JSON.stringify(baseGame.scoring || null) !== JSON.stringify(g.scoring || null)) warns.push("changes the scoring rules");
  }
  if (errors.length) {
    return {
      key,
      label,
      status: "fail",
      detail: errors.slice(0, 10).join("; ") + ".",
      fixPrompt: `Fix games/${game.slug}/game.json so it matches docs/PROTOCOL.md section 3 and schemas/game.schema.json: ${errors.slice(0, 10).join("; ")}.`,
    };
  }
  if (warns.length) return { key, label, status: "warn", detail: warns.join("; ") + "." };
  return { key, label, status: "pass", detail: `${g.title}: ${g.scored ? `scored (${g.scoring.mode}, max ${g.scoring.maxScore})` : "not scored"}, ${g.mobile ? "mobile" : "desktop only"}.` };
}

export function limitsItem(game) {
  const problems = [];
  const all = [
    ...game.src.filter((f) => !f.symlink && !f.special).map((f) => ({ where: `src/${f.path}`, path: f.path, bytes: f.bytes })),
    ...game.assets.map((a) => ({ where: `assets.json ${a.path}`, path: a.path, bytes: Math.max(0, a.bytes) })),
  ];
  const badPaths = all.map((f) => [f.where, pathProblem(f.path)]).filter(([, p]) => p);
  if (badPaths.length) problems.push(`bad paths: ${list(badPaths.map(([w, p]) => `${w} (${p})`), 5)}`);

  const srcSet = new Set(game.src.map((f) => f.path));
  const dupes = game.assets.filter((a) => srcSet.has(a.path)).map((a) => a.path);
  if (dupes.length) problems.push(`in both src/ and assets.json: ${list(dupes)}`);

  if (all.length > LIMITS.files) problems.push(`${all.length} files; the limit is ${LIMITS.files}`);
  const total = all.reduce((n, f) => n + f.bytes, 0);
  if (total > LIMITS.buildBytes) problems.push(`the build is ${mb(total)}; the limit is ${mb(LIMITS.buildBytes)}`);
  const entry = (game.game && typeof game.game.entry === "string" && game.game.entry) || "index.html";
  const entryFile = game.src.find((f) => f.path === entry);
  if (entryFile && entryFile.bytes > LIMITS.entryBytes) problems.push(`the entry file is ${mb(entryFile.bytes)}; the limit is ${mb(LIMITS.entryBytes)}`);

  return problems.length
    ? {
        key: "limits",
        label: "Size and file limits",
        status: "fail",
        detail: problems.join("; ") + ".",
        fixPrompt: `Keep the build within docs/PROTOCOL.md section 2.1: entry file at most 5 MB, whole build at most 30 MB, at most 300 files, and paths that are relative, lower-case a-z 0-9 - _ . /, at most 200 characters, with no "..". Problems: ${problems.join("; ")}.`,
      }
    : { key: "limits", label: "Size and file limits", status: "pass", detail: `${all.length} files, ${mb(total)}; entry ${entryFile ? mb(entryFile.bytes) : "missing"}.` };
}

/** Returns { item, needsHuman: string[] } */
export function typesItem(game) {
  const fails = [];
  const fixes = [];
  const needsHuman = [];
  for (const f of game.src) {
    if (f.symlink || f.special) continue;
    const kind = fileKind(f.path);
    if (kind === "text") continue;
    if (kind === "binary" || kind === "human") {
      fails.push(`src/${f.path} is a binary file`);
      fixes.push(`Move src/${f.path} out of git: upload it and list it in assets.json by path with its sha256, bytes and type.`);
    } else {
      fails.push(`src/${f.path} has a type that is not allowed (.${extOf(f.path) || "no extension"})`);
      fixes.push(`Remove src/${f.path} or convert it to an allowed type.`);
    }
  }
  for (const a of game.assets) {
    const kind = fileKind(a.path);
    if (kind === "binary") continue;
    if (kind === "human") {
      needsHuman.push(`wasm: ${a.path}`);
      continue;
    }
    fails.push(`assets.json ${a.path} is not a binary type (.${extOf(a.path) || "no extension"})`);
    fixes.push(kind === "text" ? `Put ${a.path} in src/ as a text file instead of assets.json.` : `Remove ${a.path} from assets.json; .${extOf(a.path)} files are not allowed.`);
  }
  const allowed =
    "Text in src/: html htm js mjs css json glsl frag vert txt md csv. Binaries in assets.json: png jpg jpeg webp gif avif svg mp3 ogg wav m4a woff woff2 ttf otf glb gltf bin. wasm only after a human approves it.";
  let item;
  if (fails.length) {
    item = { key: "types", label: "File types", status: "fail", detail: list(fails, 8) + ".", fixPrompt: `${[...new Set(fixes)].slice(0, 10).join(" ")} ${allowed}` };
  } else if (needsHuman.length) {
    item = { key: "types", label: "File types", status: "warn", detail: `wasm needs a human approval: ${list(needsHuman.map((x) => x.slice(6)))}.` };
  } else {
    item = { key: "types", label: "File types", status: "pass", detail: "Only allowed file types." };
  }
  return { item, needsHuman };
}
