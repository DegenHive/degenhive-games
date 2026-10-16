// Build rules from docs/PROTOCOL.md section 2, shared by the checks, the deploy script
// and the edge server. Pure data and pure functions: no Node APIs, so the Worker can
// import this file too.

export const TEXT_EXT = ["html", "htm", "js", "mjs", "css", "json", "glsl", "frag", "vert", "txt", "md", "csv"];
export const BINARY_EXT = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "svg",
  "mp3", "ogg", "wav", "m4a",
  "woff", "woff2", "ttf", "otf",
  "glb", "gltf", "bin",
];
/** Allowed only after a human approves it for that game. */
export const HUMAN_EXT = ["wasm"];

export const LIMITS = {
  entryBytes: 5 * 1024 * 1024,
  buildBytes: 30 * 1024 * 1024,
  files: 300,
  pathLength: 200,
};

// 3 to 32 characters, starts with a letter, no trailing - and no -- (preview hosts use <prefix>--<slug>).
export const SLUG_RE = /^(?!.*--)[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const PATH_CHARS_RE = /^[a-z0-9_.\-/]+$/;
/** Paths under this prefix belong to the edge server (/__dh/sdk.js and friends). */
export const RESERVED_PREFIX = "__dh/";

export const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  glsl: "text/plain; charset=utf-8",
  frag: "text/plain; charset=utf-8",
  vert: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  bin: "application/octet-stream",
  wasm: "application/wasm",
};

export function extOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function mimeOf(path) {
  return MIME[extOf(path)] || "application/octet-stream";
}

/** "text" | "binary" | "human" | null (refused). */
export function fileKind(path) {
  const ext = extOf(path);
  if (TEXT_EXT.includes(ext)) return "text";
  if (BINARY_EXT.includes(ext)) return "binary";
  if (HUMAN_EXT.includes(ext)) return "human";
  return null;
}

/** Null when the path is fine, otherwise a plain reason. Section 2.1. */
export function pathProblem(path) {
  if (typeof path !== "string" || path.length === 0) return "empty path";
  if (path.length > LIMITS.pathLength) return `longer than ${LIMITS.pathLength} characters`;
  if (path.startsWith("/")) return "starts with /";
  if (!PATH_CHARS_RE.test(path)) return "uses characters other than a-z 0-9 - _ . /";
  if (path.includes("..")) return "contains ..";
  if (path.includes("//") || path.endsWith("/")) return "has an empty path segment";
  if (path.split("/").some((s) => s === ".")) return "has a . segment";
  if (path.startsWith(RESERVED_PREFIX)) return `${RESERVED_PREFIX} is reserved for the server`;
  return null;
}

export const GAME_ROOT_FILES = ["game.json", "assets.json"];
