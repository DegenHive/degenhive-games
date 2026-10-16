// Pinned library files (rules/static-rules.json "libraries") on disk, for the sandbox and deploy.
// Files are kept by hash in <dir>/assets/<sha256>, the same layout as the storage root.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./hash.mjs";
import { findCdnLibraries } from "./cdn.mjs";

export const DEFAULT_LIBS_DIR = process.env.DH_LIBS_DIR || fileURLToPath(new URL("../../node_modules/.cache/degenhive-libs/", import.meta.url));

const CODE = /\.(html?|m?js)$/;

/** Pinned libraries a game loads by CDN URL. */
export function referencedLibraries(game, libIndex, readText = (f) => readFileSync(f.abs, "utf8")) {
  const found = new Map();
  for (const f of game.src) {
    if (f.symlink || f.special || !CODE.test(f.path)) continue;
    for (const { lib } of findCdnLibraries(readText(f), libIndex)) found.set(lib.sha256, lib);
  }
  return [...found.values()];
}

export function jsdelivrUrl(lib) {
  return `https://cdn.jsdelivr.net/npm/${lib.name}@${lib.version}/${lib.file}`;
}

/**
 * Makes sure every library is in <dir>/assets/<sha256>, downloading it from jsdelivr when
 * allowed. Downloads are kept only when their sha256 matches the pinned one.
 * @returns {Promise<{ present: object[], missing: {lib: object, reason: string}[] }>}
 */
export async function ensureLibraries(libs, { dir = DEFAULT_LIBS_DIR, fetchMissing = true } = {}) {
  const present = [];
  const missing = [];
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const lib of libs) {
    const dest = join(dir, "assets", lib.sha256);
    if (existsSync(dest)) {
      present.push(lib);
      continue;
    }
    if (!fetchMissing) {
      missing.push({ lib, reason: "not in the local library cache" });
      continue;
    }
    try {
      const res = await fetch(jsdelivrUrl(lib), { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256Hex(buf) !== lib.sha256) throw new Error("the downloaded file does not match the pinned sha256");
      const tmp = `${dest}.tmp-${process.pid}`;
      writeFileSync(tmp, buf);
      renameSync(tmp, dest);
      present.push(lib);
    } catch (e) {
      missing.push({ lib, reason: e.message });
    }
  }
  return { present, missing };
}
