// The local storage root of plans/games/API.md section 1 (a directory standing in for R2 + KV).
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { buildManifest } from "./game.mjs";
import { sha256Hex } from "./hash.mjs";

export function readKv(root) {
  const f = join(root, "kv.json");
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, "utf8"));
}

export function writeKv(root, kv) {
  mkdirSync(root, { recursive: true });
  const f = join(root, "kv.json");
  const tmp = f + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(kv, null, 2) + "\n");
  renameSync(tmp, f);
}

export function setKv(root, key, value) {
  const kv = readKv(root);
  if (value === null) delete kv[key];
  else kv[key] = value;
  writeKv(root, kv);
}

/**
 * Copies a loaded game (scripts/lib/game.mjs) into <root>/builds/<slug>/<hash>/ and, when
 * asked, points live:<slug> at it. Binaries must already be in <root>/assets/<sha256>, or in
 * <assetsRoot>/assets/<sha256>, from where they are copied (and their hash verified).
 */
export function writeLocalBuild(root, game, { assetsRoot = null, setLive = true, manifestExtra = {} } = {}) {
  const rootAbs = resolve(root);
  const manifest = buildManifest(game, manifestExtra);
  const base = join(rootAbs, "builds", game.slug, manifest.hash);
  for (const f of game.src) {
    if (f.symlink || f.special || !f.sha256) continue;
    const to = join(base, "src", f.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(f.abs, to);
  }
  const missingAssets = [];
  mkdirSync(join(rootAbs, "assets"), { recursive: true });
  for (const a of game.assets) {
    const dest = join(rootAbs, "assets", a.sha256);
    if (existsSync(dest)) continue;
    const from = assetsRoot ? join(resolve(assetsRoot), "assets", a.sha256) : null;
    if (from && existsSync(from) && sha256Hex(readFileSync(from)) === a.sha256) copyFileSync(from, dest);
    else missingAssets.push(a.path);
  }
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (setLive) setKv(rootAbs, `live:${game.slug}`, manifest.hash);
  return { hash: manifest.hash, manifest, base, missingAssets };
}
