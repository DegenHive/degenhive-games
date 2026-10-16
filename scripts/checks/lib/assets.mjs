// assets.json: shape, and that every listed hash exists in storage with the right bytes.
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "../../lib/hash.mjs";
import { extOf } from "../../lib/protocol.mjs";
import { validateAssetsJson, formatErrors } from "./schema.mjs";

const MAX_DOWNLOAD = 32 * 1024 * 1024;

async function download(url, timeoutMs = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!res.ok) return { status: res.status, bytes: null };
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD) return { status: 413, bytes: null };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) return { status: 413, bytes: null };
  return { status: 200, bytes: buf };
}

/** SVG is XML and can carry script. A game's code belongs in src/ where it is reviewed. */
export function svgProblems(text) {
  const out = [];
  if (/<script\b/i.test(text)) out.push("contains <script>");
  if (/\son[a-z]+\s*=/i.test(text)) out.push("has on* event handlers");
  if (/javascript:/i.test(text)) out.push("has a javascript: URL");
  if (/<foreignObject\b/i.test(text)) out.push("embeds HTML with <foreignObject>");
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//i.test(text)) out.push("links to an outside URL");
  return out;
}

/**
 * @returns {Promise<{ item: object, localRoot: string|null, svgFindings: object[], files: string[] }>}
 *   localRoot: a directory with assets/<sha256> for the sandbox and the malware scan
 *   files: absolute paths of this game's asset files that were found
 */
export async function assetsCheck(game, { assetsRoot = null, assetsUrl = null, downloadDir = null } = {}) {
  const key = "assets";
  const label = "Assets";
  const none = { localRoot: assetsRoot, svgFindings: [], files: [] };
  if (game.assetsError) {
    return { ...none, item: { key, label, status: "fail", detail: `assets.json is ${game.assetsError}.`, fixPrompt: 'Make assets.json valid JSON of the form { "assets": { "img/bee.png": { "sha256": "<hex>", "bytes": 1234, "type": "image/png" } } }.' } };
  }
  if (game.assetsJson) {
    const errors = formatErrors(validateAssetsJson(game.assetsJson), "assets.json");
    if (errors.length) {
      return { ...none, item: { key, label, status: "fail", detail: errors.slice(0, 8).join("; ") + ".", fixPrompt: `Fix assets.json: ${errors.slice(0, 8).join("; ")}. Each entry needs sha256 (64 lower-case hex characters), bytes (a whole number) and type (a MIME type).` } };
    }
  }
  if (!game.assets.length) return { ...none, item: { key, label, status: "pass", detail: "No binary assets." } };

  let root = assetsRoot ? resolve(assetsRoot) : null;
  let via = root ? `--assets-root ${root}` : null;
  if (!root && assetsUrl && downloadDir) {
    root = resolve(downloadDir);
    via = assetsUrl;
    mkdirSync(join(root, "assets"), { recursive: true });
    let total = 0;
    for (const a of game.assets) {
      const dest = join(root, "assets", a.sha256);
      if (existsSync(dest) || !/^[0-9a-f]{64}$/.test(a.sha256)) continue;
      try {
        const r = await download(`${assetsUrl.replace(/\/+$/, "")}/${a.sha256}`);
        if (r.bytes) {
          total += r.bytes.length;
          if (total > MAX_DOWNLOAD) break;
          writeFileSync(dest, r.bytes);
        }
      } catch {
        // reported as missing below
      }
    }
  }
  if (!root) {
    return {
      ...none,
      item: { key, label, status: "warn", detail: `${game.assets.length} asset(s) listed; not verified because no assets store was given (--assets-root or --assets-url).` },
    };
  }

  const missing = [];
  const wrong = [];
  const files = [];
  const svgFindings = [];
  for (const a of game.assets) {
    const f = join(root, "assets", a.sha256);
    if (!/^[0-9a-f]{64}$/.test(a.sha256) || !existsSync(f)) {
      missing.push(a.path);
      continue;
    }
    const bytes = readFileSync(f);
    if (sha256Hex(bytes) !== a.sha256) wrong.push(`${a.path} (hash does not match)`);
    else if (statSync(f).size !== a.bytes) wrong.push(`${a.path} (${statSync(f).size} bytes, assets.json says ${a.bytes})`);
    else files.push(f);
    if (extOf(a.path) === "svg") {
      const problems = svgProblems(bytes.toString("utf8"));
      if (problems.length) {
        svgFindings.push({
          rule: "svg-active-content",
          lens: "security",
          severity: "fail",
          file: `assets.json ${a.path}`,
          line: 0,
          excerpt: "",
          message: `SVG ${problems.join(", ")}.`,
          fixPrompt: `Make ${a.path} a plain image: remove <script>, on* attributes, javascript: URLs, <foreignObject> and outside links, then upload it again and update its sha256 in assets.json.`,
          hits: problems.length,
        });
      }
    }
  }
  const problems = [];
  if (missing.length) problems.push(`not in the assets store: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}`);
  if (wrong.length) problems.push(wrong.slice(0, 6).join(", "));
  const item = problems.length
    ? {
        key,
        label,
        status: "fail",
        detail: problems.join("; ") + ` (checked against ${via}).`,
        fixPrompt: "Upload every file listed in assets.json again through DegenHive (the site or the degenhive CLI), so the store holds bytes with exactly the sha256 and size written in assets.json.",
      }
    : { key, label, status: "pass", detail: `${game.assets.length} asset(s) found with matching hashes.` };
  return { item, localRoot: root, svgFindings, files };
}
