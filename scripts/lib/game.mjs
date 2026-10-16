// Reads one games/<slug>/ directory into a plain description. Never runs anything in it.
import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { sha256Hex, buildHash } from "./hash.mjs";
import { extOf, mimeOf, fileKind, GAME_ROOT_FILES } from "./protocol.mjs";

function readJson(abs) {
  if (!existsSync(abs)) return { value: null, error: "missing" };
  const raw = readFileSync(abs, "utf8");
  try {
    return { value: JSON.parse(raw), error: null, raw };
  } catch (e) {
    return { value: null, error: `not valid JSON: ${e.message}`, raw };
  }
}

/** Walks a directory without following symlinks. Returns paths relative to `root`. */
function walk(root, rel = "", out = []) {
  const abs = rel ? join(root, rel) : root;
  for (const name of readdirSync(abs).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, r));
    if (st.isSymbolicLink()) out.push({ path: r, symlink: true, bytes: 0 });
    else if (st.isDirectory()) walk(root, r, out);
    else if (st.isFile()) out.push({ path: r, symlink: false, bytes: st.size });
    else out.push({ path: r, special: true, bytes: 0 });
  }
  return out;
}

/**
 * @param {string} gameDir path to games/<slug>
 * @returns {{
 *   dir: string, slug: string,
 *   game: object|null, gameError: string|null, gameRaw: string|null,
 *   assetsJson: object|null, assetsError: string|null,
 *   src: {path: string, abs: string, bytes: number, symlink: boolean, ext: string, sha256: string|null}[],
 *   assets: {path: string, sha256: string, bytes: number, type: string}[],
 *   extra: string[],
 * }}
 */
export function loadGame(gameDir) {
  const dir = resolve(gameDir);
  const slug = basename(dir);
  const g = readJson(join(dir, "game.json"));
  const a = readJson(join(dir, "assets.json"));

  const extra = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name === "src" || GAME_ROOT_FILES.includes(name)) continue;
      extra.push(name);
    }
  }

  const srcRoot = join(dir, "src");
  const src = existsSync(srcRoot)
    ? walk(srcRoot).map((f) => {
        const abs = join(srcRoot, f.path);
        const hash = f.symlink || f.special ? null : sha256Hex(readFileSync(abs));
        return { ...f, abs, ext: extOf(f.path), sha256: hash };
      })
    : [];

  let assets = [];
  let assetsError = a.error === "missing" ? null : a.error;
  if (a.value) {
    const map = a.value.assets;
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      assetsError = 'assets.json needs an "assets" object';
    } else {
      assets = Object.keys(map)
        .sort()
        .map((p) => ({
          path: p,
          sha256: map[p] && typeof map[p].sha256 === "string" ? map[p].sha256 : "",
          bytes: map[p] && Number.isInteger(map[p].bytes) ? map[p].bytes : -1,
          type: map[p] && typeof map[p].type === "string" ? map[p].type : "",
        }));
    }
  }

  return {
    dir,
    slug,
    game: g.value,
    gameError: g.error,
    gameRaw: g.raw ?? null,
    assetsJson: a.value,
    assetsError,
    src,
    assets,
    extra,
  };
}

/** Every file of the build as { path, sha256, bytes, type, store }. store is "src" or "asset". */
export function buildFiles(game) {
  const files = [];
  for (const f of game.src) {
    if (f.symlink || f.special || !f.sha256) continue;
    files.push({ path: f.path, sha256: f.sha256, bytes: f.bytes, type: mimeOf(f.path), store: "src" });
  }
  for (const a of game.assets) {
    files.push({ path: a.path, sha256: a.sha256, bytes: a.bytes, type: a.type || mimeOf(a.path), store: "asset" });
  }
  return files;
}

export function gameBuildHash(game) {
  return buildHash(buildFiles(game));
}

/** The manifest written next to a build: builds/<slug>/<hash>/manifest.json. */
export function buildManifest(game, extra = {}) {
  const files = buildFiles(game);
  const hash = buildHash(files);
  const g = game.game || {};
  return {
    slug: game.slug,
    hash,
    entry: g.entry || "index.html",
    files: files.map(({ path, sha256, bytes, type }) => ({ path, sha256, bytes, type })),
    bytes: files.reduce((n, f) => n + Math.max(0, f.bytes), 0),
    backends: Array.isArray(g.backends) ? g.backends : [],
    wasm: files.some((f) => fileKind(f.path) === "human"),
    ...extra,
  };
}
