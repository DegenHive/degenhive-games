// Routing and headers for game hosts. Pure: storage is injected, so the same code runs in the
// Cloudflare Worker (edge/src/worker.mjs) and in Node (tools/edge-dev/server.mjs).
//
// Contract: docs/PROTOCOL.md section 6 and plans/games/API.md sections 1 and 2.
//
// store = {
//   kv(key)              -> Promise<string | null>          live:<slug>, off:<slug>, pr:<n>
//   text(key)            -> Promise<string | null>          manifest.json and HTML files
//   object(key, range?)  -> Promise<{ body } | null>        any file; range = { offset, length }
//   sdk()                -> Promise<string | null>          the SDK bundle served at /__dh/sdk.js
// }
// env = { GAME_DOMAIN, PREVIEW_DOMAIN, FRAME_ANCESTORS, CSP_REPORT_URI?, now? }
// opts = { libIndex?: Map, libraries?: [] }   pinned libraries from rules/static-rules.json
import { mimeOf, fileKind, pathProblem, extOf, SLUG_RE } from "../../scripts/lib/protocol.mjs";
import { libraryIndex, rewriteCdnUrls, libForPath } from "../../scripts/lib/cdn.mjs";

export const SDK_PATH = "/__dh/sdk.js";
export const PREVIEW_CSS_PATH = "/__dh/preview.css";
export const SDK_TAG = `<script src="${SDK_PATH}"></script>`;
export const PREVIEW_MARK = `<link rel="stylesheet" href="${PREVIEW_CSS_PATH}"><dh-preview-mark aria-hidden="true">Preview · no rewards</dh-preview-mark>`;
export const SDK_STUB = `console.warn("[DegenHive] the SDK is not built here (packages/sdk/dist/sdk.js is missing); DegenHive is undefined");\n`;
export const PREVIEW_CSS =
  "dh-preview-mark{position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:2147483647;" +
  "pointer-events:none;user-select:none;font:600 11px/1.6 system-ui,-apple-system,sans-serif;letter-spacing:.04em;" +
  "color:#fff;background:rgba(0,0,0,.6);padding:2px 10px;border-radius:999px;white-space:nowrap}\n";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;
const UPLOAD_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG = "((?!.*--)[a-z][a-z0-9-]{1,30}[a-z0-9])";
const PR_RE = new RegExp(`^pr-([1-9][0-9]{0,8})--${SLUG}$`);
const UP_RE = new RegExp(`^up-([a-z0-9]+(?:-[a-z0-9]+)*)--${SLUG}$`);

// ---- hosts ----

function stripPort(host) {
  const h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const i = h.lastIndexOf(":");
  return i >= 0 ? h.slice(0, i) : h;
}

function labelUnder(host, domain) {
  if (!domain) return null;
  const suffix = "." + domain.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label && !label.includes(".") ? label : null;
}

/**
 * @returns {{kind: "live", slug} | {kind: "pr", pr: number, slug} | {kind: "up", uploadId, slug} | null}
 */
export function parseHost(hostHeader, env) {
  const host = stripPort(hostHeader);
  const previewLabel = labelUnder(host, env.PREVIEW_DOMAIN);
  if (previewLabel) {
    let m;
    if ((m = PR_RE.exec(previewLabel))) return { kind: "pr", pr: Number(m[1]), slug: m[2] };
    if ((m = UP_RE.exec(previewLabel))) return { kind: "up", uploadId: m[1], slug: m[2] };
  }
  // Locally both domains are "localhost": a label that is not a preview label is a live slug.
  // Slugs cannot contain "--", so the two never overlap.
  const liveLabel = labelUnder(host, env.GAME_DOMAIN);
  if (liveLabel && SLUG_RE.test(liveLabel)) return { kind: "live", slug: liveLabel };
  return null;
}

// ---- headers ----

export function frameAncestors(env) {
  const list = String(env.FRAME_ANCESTORS || "")
    .split(/[\s,]+/)
    .filter((s) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s) || /^https:\/\/\*\.[a-z0-9.-]+$/i.test(s));
  return list.length ? list.join(" ") : "'none'";
}

export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "clipboard-read=()",
  "publickey-credentials-get=()",
  "publickey-credentials-create=()",
].join(", ");

/** Content-Security-Policy for a build. backends are https:// origins from game.json. */
export function contentSecurityPolicy(env, { backends = [], wasm = false } = {}) {
  const connect = ["'self'"];
  for (const b of backends) {
    if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(b)) continue;
    // CSP does not let an https: source cover wss:, so each backend is listed for both.
    connect.push(b, "wss://" + b.slice("https://".length));
  }
  const script = ["'self'", "'unsafe-inline'", "blob:"];
  if (wasm) script.push("'wasm-unsafe-eval'");
  const d = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    // Not in PROTOCOL.md section 6 yet: without it every inline <style> and style="" is blocked.
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors(env)}`,
  ];
  if (env.CSP_REPORT_URI) d.push(`report-uri ${env.CSP_REPORT_URI}`);
  return d.join("; ");
}

export function securityHeaders(env, build = {}) {
  return {
    "Content-Security-Policy": contentSecurityPolicy(env, build),
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

// ---- HTML ----

export function hasSdkTag(html) {
  return /<script\b[^>]*\bsrc\s*=\s*["']?\/__dh\/sdk\.js["'\s>]/i.test(html);
}

/** Adds the SDK tag after <head> (or <html>, or the doctype, or at the start) and the preview mark. */
export function injectHtml(html, { preview = false } = {}) {
  let out = html;
  if (!hasSdkTag(out)) {
    // Keep <meta charset> first when it opens the head, so it stays in the first 1024 bytes.
    const at =
      /<head(?:\s[^>]*)?>\s*<meta\s+charset\s*=[^>]*>/i.exec(out) ||
      /<head(?:\s[^>]*)?>/i.exec(out) ||
      /<html(?:\s[^>]*)?>/i.exec(out) ||
      /^﻿?\s*<!doctype[^>]*>/i.exec(out);
    if (at) out = out.slice(0, at.index + at[0].length) + SDK_TAG + out.slice(at.index + at[0].length);
    else out = out.startsWith("﻿") ? "﻿" + SDK_TAG + out.slice(1) : SDK_TAG + out;
  }
  if (preview) {
    const i = out.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    out = i >= 0 ? out.slice(0, i) + PREVIEW_MARK + out.slice(i) : out + PREVIEW_MARK;
  }
  return out;
}

// ---- responses ----

function page(status, title, text, headers, extra = {}) {
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;` +
    `font:15px/1.5 system-ui,sans-serif;background:#111;color:#ddd"><p>${text}</p></body></html>`;
  return {
    status,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra },
    body,
  };
}

const notFound = (headers) => page(404, "Not found", "Not found.", headers);

export function unavailable(env) {
  return page(410, "Unavailable", "This game is unavailable.", securityHeaders(env), {
    "Clear-Site-Data": '"cache", "cookies", "storage"',
  });
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return { invalid: true };
  return { offset: start, length: end - start + 1, end };
}

async function readManifest(store, base) {
  const raw = await store.text(`${base}/manifest.json`);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || !Array.isArray(m.files)) return null;
    return m;
  } catch {
    return null;
  }
}

function expired(manifest, now) {
  const exp = manifest.expiresAt ? Date.parse(manifest.expiresAt) : manifest.createdAt ? Date.parse(manifest.createdAt) + UPLOAD_TTL_MS : NaN;
  return Number.isFinite(exp) && now > exp;
}

/**
 * Serves one request. req = { method, url, headers: { get(name) } }.
 * Returns { status, headers, body } where body is a string, bytes, a stream or null.
 */
export async function handle(req, env, store, opts = {}) {
  const libIndex = opts.libIndex || libraryIndex(opts.libraries || []);
  const method = String(req.method || "GET").toUpperCase();
  const url = new URL(req.url);
  const get = (n) => (req.headers && typeof req.headers.get === "function" ? req.headers.get(n) : null);
  const target = parseHost(get("host") || url.host, env);
  const base0 = securityHeaders(env);

  if (!target) return notFound(base0);
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...base0, Allow: "GET, HEAD", "Content-Type": "text/plain" }, body: "Method not allowed\n" };
  }
  // Service-worker scripts are fetched with this header. Refusing them keeps a game from
  // installing code that outlives a takedown.
  if (get("service-worker")) {
    return { status: 403, headers: { ...base0, "Content-Type": "text/plain", "Cache-Control": "no-store" }, body: "Service workers are not allowed\n" };
  }

  const { slug } = target;
  if (await store.kv(`off:${slug}`)) return unavailable(env);

  const preview = target.kind !== "live";
  let base;
  if (target.kind === "live") {
    const hash = await store.kv(`live:${slug}`);
    if (!hash || !HASH_RE.test(hash)) return notFound(base0);
    base = `builds/${slug}/${hash}`;
  } else {
    const id = target.kind === "pr" ? await store.kv(`pr:${target.pr}`) : target.uploadId;
    if (!id || !UPLOAD_ID_RE.test(id) || id.length > 64) return notFound(base0);
    base = `pending/${id}`;
  }

  const manifest = await readManifest(store, base);
  if (!manifest) return notFound(base0);
  if (manifest.slug && manifest.slug !== slug) return notFound(base0);
  if (target.kind === "up" && expired(manifest, env.now ? env.now() : Date.now())) {
    return page(410, "Expired", "This preview has expired.", base0);
  }

  const build = { backends: Array.isArray(manifest.backends) ? manifest.backends : [], wasm: !!manifest.wasm };
  const headers = securityHeaders(env, build);
  if (preview) headers["X-Robots-Tag"] = "noindex, nofollow";

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(headers);
  }

  if (pathname === SDK_PATH) {
    const sdk = (await store.sdk()) || SDK_STUB;
    return { status: 200, headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }, body: method === "HEAD" ? null : sdk };
  }
  if (pathname === PREVIEW_CSS_PATH && preview) {
    return { status: 200, headers: { ...headers, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" }, body: method === "HEAD" ? null : PREVIEW_CSS };
  }

  const lib = libForPath(pathname, libIndex);
  if (lib) {
    // Content-addressed and pinned: the bytes behind this URL never change.
    const obj = method === "HEAD" ? { body: null } : await store.object(`assets/${lib.sha256}`);
    if (!obj) return notFound(headers);
    return {
      status: 200,
      headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${lib.sha256}"` },
      body: obj.body,
    };
  }

  let path = pathname.replace(/^\/+/, "");
  if (path === "") path = manifest.entry || "index.html";
  else if (path.endsWith("/")) path += "index.html";
  if (pathProblem(path)) return notFound(headers);

  const file = manifest.files.find((f) => f && f.path === path);
  if (!file || !HASH_RE.test(file.sha256 || "")) return notFound(headers);
  const kind = fileKind(path);
  if (!kind) return notFound(headers);
  const key = kind === "text" ? `${base}/src/${path}` : `assets/${file.sha256}`;
  const type = mimeOf(path);
  const isHtml = type.startsWith("text/html");

  const isScript = extOf(path) === "js" || extOf(path) === "mjs";
  const etag = `"${file.sha256}${isHtml ? (preview ? "-p" : "-h") : isScript ? "-s" : ""}"`;
  const common = { ...headers, "Content-Type": type, "Cache-Control": "no-cache", ETag: etag };
  const inm = get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return { status: 304, headers: common, body: null };
  }

  if (isHtml || isScript) {
    const text = await store.text(key);
    if (text === null || text === undefined) return notFound(headers);
    const swapped = libIndex.size ? rewriteCdnUrls(text, libIndex).text : text;
    const body = isHtml ? injectHtml(swapped, { preview }) : swapped;
    return { status: 200, headers: common, body: method === "HEAD" ? null : body };
  }

  const size = Number.isInteger(file.bytes) && file.bytes >= 0 ? file.bytes : null;
  common["Accept-Ranges"] = "bytes";
  const rangeHeader = get("range");
  if (rangeHeader && size !== null) {
    const r = parseRange(rangeHeader, size);
    if (r && r.invalid) {
      return { status: 416, headers: { ...common, "Content-Range": `bytes */${size}` }, body: null };
    }
    if (r) {
      const obj = method === "HEAD" ? { body: null } : await store.object(key, { offset: r.offset, length: r.length });
      if (!obj) return notFound(headers);
      return {
        status: 206,
        headers: { ...common, "Content-Range": `bytes ${r.offset}-${r.end}/${size}`, "Content-Length": String(r.length) },
        body: obj.body,
      };
    }
  }
  const obj = method === "HEAD" ? { body: null } : await store.object(key);
  if (!obj) return notFound(headers);
  if (size !== null) common["Content-Length"] = String(size);
  return { status: 200, headers: common, body: obj.body };
}
