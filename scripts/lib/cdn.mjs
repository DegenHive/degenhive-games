// Library URLs from public CDNs, swapped for the pinned copies we host (docs/PROTOCOL.md 2.5).
// Pure: used by the edge (Worker and edge-dev) and by the checks.
//
// A game may write
//   import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
// The edge serves that module from /__dh/lib/three@0.160.0/build/three.module.js, whose bytes are
// stored by hash in assets/<sha256>, but only when name, version and file are in the libraries
// list of rules/static-rules.json. Anything else stays as written and the CSP blocks it.

export const LIB_PREFIX = "/__dh/lib/";

// jsdelivr and unpkg use the npm package layout, so the path maps straight to the npm file.
// TODO: cdnjs (https://cdnjs.cloudflare.com/ajax/libs/<name>/<version>/<file>) uses its own names
// and folders (three.js/r128/three.min.js); it needs a per-library table checked byte for byte.
const CDN_RE = /(?:https?:)?\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@([0-9A-Za-z.+_-]+)\/([A-Za-z0-9._/-]+?\.(?:m?js|cjs))(?=["'`\s)?#]|$)/g;

export function libKey(name, version, file) {
  return `${name}@${version}/${file}`;
}

/** @param {{name, version, file, sha256, bytes}[]} libraries */
export function libraryIndex(libraries = []) {
  const m = new Map();
  for (const l of libraries) m.set(libKey(l.name, l.version, l.file), l);
  return m;
}

/** Parses a CDN URL into { name, version, file } or null. */
export function parseCdnUrl(url) {
  CDN_RE.lastIndex = 0;
  const m = CDN_RE.exec(url);
  CDN_RE.lastIndex = 0;
  return m && m.index === 0 ? { name: m[1], version: m[2], file: m[3] } : null;
}

/** Finds every pinned library URL in a text, as [{ url, lib }]. */
export function findCdnLibraries(text, index) {
  const out = [];
  CDN_RE.lastIndex = 0;
  let m;
  while ((m = CDN_RE.exec(text)) !== null) {
    const lib = index.get(libKey(m[1], m[2], m[3]));
    if (lib) out.push({ url: m[0], lib });
  }
  return out;
}

/** Rewrites pinned library URLs to LIB_PREFIX paths. Returns { text, count }. */
export function rewriteCdnUrls(text, index) {
  let count = 0;
  const out = text.replace(CDN_RE, (all, name, version, file) => {
    if (!index.has(libKey(name, version, file))) return all;
    count++;
    return `${LIB_PREFIX}${libKey(name, version, file)}`;
  });
  return { text: out, count };
}

/** The library for a /__dh/lib/... request path, or null. */
export function libForPath(pathname, index) {
  if (!pathname.startsWith(LIB_PREFIX)) return null;
  return index.get(pathname.slice(LIB_PREFIX.length)) || null;
}
