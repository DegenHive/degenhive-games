// Hashes from plans/games/API.md section 1.
//   File hash:  sha256 of the bytes, hex.
//   Build hash: sha256 over the lines "<path>\t<sha256>\n" of every file of the build
//               (text files from src/ and binaries from assets.json), sorted by path, hex.
// Paths are relative to src/, the same paths the game uses in URLs.
import { createHash } from "node:crypto";

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Code-unit order, the same in every runtime (no locale). */
export function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The exact text the build hash is taken over. Exported for tests and for other runtimes. */
export function buildHashInput(files) {
  const seen = new Set();
  const rows = files.map((f) => {
    if (typeof f.path !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      throw new Error(`bad file entry: ${JSON.stringify(f)}`);
    }
    if (seen.has(f.path)) throw new Error(`duplicate path in build: ${f.path}`);
    seen.add(f.path);
    return [f.path, f.sha256];
  });
  rows.sort((x, y) => comparePaths(x[0], y[0]));
  return rows.map(([p, h]) => `${p}\t${h}\n`).join("");
}

/** @param {{path: string, sha256: string}[]} files */
export function buildHash(files) {
  return sha256Hex(buildHashInput(files));
}
