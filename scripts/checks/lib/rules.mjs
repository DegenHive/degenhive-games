// The code rules of docs/PROTOCOL.md section 2.4, driven by rules/static-rules.json.
// Pure functions over text; the caller reads the files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraryIndex, parseCdnUrl, libKey } from "../../lib/cdn.mjs";

export const RULES_PATH = fileURLToPath(new URL("../../../rules/static-rules.json", import.meta.url));

export const CODE_EXT = ["html", "htm", "js", "mjs"];

export function loadRules(path = RULES_PATH) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return compileRules(doc);
}

export function compileRules(doc) {
  const rules = doc.rules.map((r) => {
    const flags = (r.flags || "").replace(/[gy]/g, "");
    return { ...r, re: new RegExp(r.pattern, flags + "g") };
  });
  const libraries = new Map();
  for (const l of doc.libraries || []) libraries.set(l.sha256, l);
  return {
    doc,
    rules,
    libraries,
    libIndex: libraryIndex(doc.libraries || []),
    minified: { ...doc.minified, ignoreRe: new RegExp(doc.minified.ignoreRuns, "g") },
    external: doc.external,
  };
}

// ---- helpers ----

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function excerptAt(text, starts, line, index, length) {
  const from = starts[line - 1];
  const to = line < starts.length ? starts[line] - 1 : text.length;
  let s = text.slice(from, to);
  if (s.length > 160) {
    const col = index - from;
    const a = Math.max(0, Math.min(col - 60, s.length - 160));
    s = (a > 0 ? "…" : "") + s.slice(a, a + 160) + (a + 160 < s.length ? "…" : "");
  }
  // Show invisible characters so a reader can see what matched.
  return s
    .replace(/[\u{E0000}-\u{E007F}‪-‮⁦-⁩​-‏⁠-⁤᠎﻿]/gu, (c) =>
      `<U+${c.codePointAt(0).toString(16).toUpperCase()}>`,
    )
    .trim();
}

// ---- rules ----

/**
 * Scans one file. `group` is "code" for html/htm/js/mjs, otherwise "text".
 * @returns {{rule, lens, severity, file, line, excerpt, message, fixPrompt, hits}[]}
 */
export function scanText({ file, text, group }, compiled, { backends = [] } = {}) {
  const findings = [];
  let starts = null;
  for (const rule of compiled.rules) {
    if (rule.files === "code" && group !== "code") continue;
    rule.re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      hits.push(m);
      if (m[0].length === 0) rule.re.lastIndex++;
      if (hits.length >= 1000) break;
    }
    if (hits.length === 0 || hits.length < (rule.minHits || 1)) continue;
    starts ||= lineStarts(text);
    let severity = rule.severity;
    let message = rule.message;
    if (rule.unlessBackends && backends.length > 0) {
      severity = "warn";
      message += ` game.json declares backends (${backends.join(", ")}); check that it only connects to those.`;
    }
    const first = hits[0];
    const line = lineAt(starts, first.index);
    findings.push({
      rule: rule.id,
      lens: rule.lens,
      severity,
      file,
      line,
      excerpt: excerptAt(text, starts, line, first.index, first[0].length),
      message,
      fixPrompt: rule.fixPrompt,
      hits: hits.length,
      lines: [...new Set(hits.slice(0, 20).map((h) => lineAt(starts, h.index)))],
    });
  }
  return findings;
}

// ---- minified / obfuscated own code ----

export function minifiedStats(code, cfg) {
  const text = code.replace(cfg.ignoreRe, "");
  const bytes = text.length;
  if (bytes < cfg.minBytes) return { minified: false, bytes };
  const lines = text.split("\n");
  let longBytes = 0;
  let codeMarks = 0;
  for (const l of lines) {
    if (l.length > cfg.longLine) {
      longBytes += l.length;
      for (let i = 0; i < l.length; i++) {
        const c = l.charCodeAt(i);
        if (c === 40 /* ( */ || c === 59 /* ; */) codeMarks++;
      }
    }
  }
  let ws = 0;
  for (let i = 0; i < bytes; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) ws++;
  }
  const longShare = longBytes / bytes;
  const wsRatio = ws / bytes;
  const codeDensity = longBytes ? codeMarks / longBytes : 0;
  const minified = longShare >= cfg.longLineShare && wsRatio < cfg.maxWhitespaceRatio && codeDensity >= cfg.minCodeDensity;
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    minified,
    bytes,
    lines: lines.length,
    longLineShare: round(longShare),
    whitespaceRatio: round(wsRatio),
    codeDensity: round(codeDensity),
  };
}

/** Inline <script> blocks of an HTML file, with the line each starts on. */
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  let starts = null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(?:module|text\/javascript|application\/javascript)$/i.test(type[1])) continue;
    starts ||= lineStarts(html);
    const bodyIndex = m.index + m[0].indexOf(">") + 1;
    out.push({ code: m[2], line: lineAt(starts, bodyIndex) });
  }
  return out;
}

// ---- resources from outside the build ----

const URL_IN = String.raw`["'\x60]?\s*((?:https?:|wss?:)?\/\/[^"'\x60\s)>]+)`;

/** Finds references to resources outside the build. kind: script | import | connect | style | media | frame */
export function externalRefs(text, group) {
  const refs = [];
  const add = (kind, url, index) => refs.push({ kind, url, index });
  const scan = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) add(kind, m[1], m.index);
  };
  if (group === "code") {
    scan(new RegExp(String.raw`<script\b[^>]*?\bsrc\s*=\s*` + URL_IN, "gi"), "script");
    scan(new RegExp(String.raw`<link\b[^>]*?\bhref\s*=\s*` + URL_IN, "gi"), "style");
    scan(new RegExp(String.raw`<(?:img|audio|video|source|track|image)\b[^>]*?\bsrc\s*=\s*` + URL_IN, "gi"), "media");
    scan(new RegExp(String.raw`<(?:iframe|frame|embed|object)\b[^>]*?\b(?:src|data)\s*=\s*` + URL_IN, "gi"), "frame");
    scan(new RegExp(String.raw`\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?\(?\s*` + URL_IN, "g"), "import");
    scan(new RegExp(String.raw`\bimportScripts\s*\(\s*` + URL_IN, "g"), "script");
    scan(
      new RegExp(String.raw`\b(?:fetch|new\s+(?:WebSocket|EventSource|WebTransport)|navigator\s*\.\s*sendBeacon)\s*\(\s*` + URL_IN, "g"),
      "connect",
    );
    scan(new RegExp(String.raw`\.\s*open\s*\(\s*["'\x60][A-Z]+["'\x60]\s*,\s*` + URL_IN, "g"), "connect");
  }
  if (group === "code" || group === "css") {
    scan(new RegExp(String.raw`@import\s+(?:url\(\s*)?` + URL_IN, "gi"), "style");
    scan(new RegExp(String.raw`\burl\(\s*` + URL_IN, "gi"), "media");
  }
  // The same URL can be found by two patterns (an import inside a <script>); keep one per spot.
  const seen = new Set();
  return refs.filter((r) => {
    const k = r.url + "@" + r.index;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function originOf(url) {
  try {
    const u = new URL(url.startsWith("//") ? "https:" + url : url);
    return { origin: `${u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol}//${u.host}`, host: u.hostname, path: u.pathname };
  } catch {
    return null;
  }
}

/** Library name served from a CDN URL, when it is one of ours. */
export function cdnLibrary(url, external) {
  const o = originOf(url);
  if (!o || !external.cdnHosts.includes(o.host)) return null;
  const names = external.libraryNames;
  let m;
  if ((m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\//.exec(o.path))) return names.includes(m[1]) ? { name: m[1], version: m[2] } : null;
  if ((m = /^\/ajax\/libs\/([^/]+)\/([^/]+)\//.exec(o.path))) return names.includes(m[1]) ? { name: m[1], version: m[2] } : null;
  if ((m = /^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\//.exec(o.path))) return names.includes(m[1]) ? { name: m[1], version: m[2] } : null;
  return null;
}

/** { severity: "fail" | "warn" | null, message } for one external reference. */
export function classifyExternal(ref, compiled, backends = []) {
  const o = originOf(ref.url);
  const where = o ? o.origin : ref.url;
  if (ref.kind === "connect") {
    if (o && backends.includes(o.origin)) return { severity: null, message: `connects to declared backend ${where}` };
    return {
      severity: "fail",
      message: `connects to ${where}, which is not in game.json "backends"`,
      fixPrompt: `Remove the request to ${where}, or add "${where}" to "backends" in game.json so a human can approve it. A game may only connect to its own origin and approved backends.`,
    };
  }
  if (ref.kind === "script" || ref.kind === "import") {
    const pinned = parseCdnUrl(ref.url);
    if (pinned && compiled.libIndex.has(libKey(pinned.name, pinned.version, pinned.file))) {
      return { severity: null, message: `${pinned.name}@${pinned.version} ${pinned.file} is served from our pinned copy` };
    }
    const lib = cdnLibrary(ref.url, compiled.external);
    if (lib) {
      const versions = [...compiled.libIndex.values()]
        .filter((l) => l.name === lib.name || (lib.name === "three.js" && l.name === "three"))
        .map((l) => `${l.name}@${l.version}/${l.file}`);
      const jsdelivr = versions.length ? ` Pinned files: ${versions.slice(0, 12).join(", ")}.` : "";
      return {
        severity: "fail",
        message: `loads ${lib.name}@${lib.version} from ${where}, which is not a pinned copy we host.`,
        fixPrompt: `Load ${lib.name} from https://cdn.jsdelivr.net/npm/<name>@<version>/<file> with a version and file listed in rules/static-rules.json "libraries" (the server swaps that URL for its own copy), or copy an unmodified pinned build into src/lib/.${jsdelivr}`,
      };
    }
    return {
      severity: "fail",
      message: `loads code from ${where}. No code may load from outside the build.`,
      fixPrompt: `Copy the script from ${ref.url} into src/ (only if it is a readable library or your own code) and load it with a relative path, or remove it.`,
    };
  }
  if (ref.kind === "frame") {
    return {
      severity: "fail",
      message: `embeds ${where} in a frame or object. Games cannot frame other pages.`,
      fixPrompt: `Remove the iframe/embed/object pointing at ${where}.`,
    };
  }
  return {
    severity: "warn",
    message: `loads a ${ref.kind === "style" ? "stylesheet or font" : "file"} from ${where}; the content policy blocks it at run time.`,
    fixPrompt: `Put the file from ${ref.url} in the build (images, audio and fonts go in assets.json, CSS in src/) and use a relative path.`,
  };
}

/**
 * Scans a loaded game (scripts/lib/game.mjs). Library files matched by hash are skipped.
 * @returns {{ findings: object[], libraries: object[], minified: object[], external: object[] }}
 */
export function scanBuild(game, compiled, { backends = [], extraLibraries = [], readText } = {}) {
  const libs = new Map(compiled.libraries);
  for (const l of extraLibraries) libs.set(l.sha256, l);
  const findings = [];
  const libraries = [];
  const minified = [];
  const external = [];
  const read = readText || ((f) => readFileSync(f.abs, "utf8"));

  for (const f of game.src) {
    if (f.symlink || f.special || !f.sha256) continue;
    const lib = libs.get(f.sha256);
    if (lib) {
      libraries.push({ file: `src/${f.path}`, name: lib.name, version: lib.version, libFile: lib.file });
      continue;
    }
    const group = CODE_EXT.includes(f.ext) ? "code" : f.ext === "css" ? "css" : "text";
    const text = read(f);
    const file = `src/${f.path}`;
    findings.push(...scanText({ file, text, group: group === "css" ? "text" : group }, compiled, { backends }));

    const starts = lineStarts(text);
    for (const ref of externalRefs(text, group)) {
      const c = classifyExternal(ref, compiled, backends);
      external.push({ file, line: lineAt(starts, ref.index), kind: ref.kind, url: ref.url, ...c });
    }

    if (f.ext === "js" || f.ext === "mjs") {
      const s = minifiedStats(text, compiled.minified);
      if (s.minified) minified.push({ file, ...s });
    } else if (f.ext === "html" || f.ext === "htm") {
      for (const block of inlineScripts(text)) {
        const s = minifiedStats(block.code, compiled.minified);
        if (s.minified) minified.push({ file, line: block.line, inline: true, ...s });
      }
    }
  }

  if (game.gameRaw) findings.push(...scanText({ file: "game.json", text: game.gameRaw, group: "text" }, compiled, { backends }));

  return { findings, libraries, minified, external };
}

// ---- CheckItems ----

function findingLine(f) {
  return `${f.file}${f.line ? ":" + f.line : ""} ${f.rule}: ${f.message}`;
}

function fixList(findings) {
  const byFix = new Map();
  for (const f of findings) {
    const where = `${f.file}${f.line ? " line " + (f.lines && f.lines.length > 1 ? f.lines.slice(0, 5).join(", ") : f.line) : ""}`;
    if (!byFix.has(f.fixPrompt)) byFix.set(f.fixPrompt, []);
    byFix.get(f.fixPrompt).push(where);
  }
  return [...byFix.entries()].map(([fix, wheres], i) => `${i + 1}. In ${wheres.slice(0, 4).join("; ")}: ${fix}`).join("\n");
}

/** Turns a scanBuild result into CheckItems: rules, external, minified, libraries. */
export function rulesItems(scan) {
  const items = [];
  const fails = scan.findings.filter((f) => f.severity === "fail");
  const warns = scan.findings.filter((f) => f.severity !== "fail");
  if (fails.length || warns.length) {
    const shown = [...fails, ...warns];
    items.push({
      key: "rules",
      label: "Code rules",
      status: fails.length ? "fail" : "warn",
      detail: shown.slice(0, 8).map(findingLine).join(" | ") + (shown.length > 8 ? ` | and ${shown.length - 8} more` : ""),
      fixPrompt: "Fix these in the game's own code (docs/PROTOCOL.md section 2.4):\n" + fixList(shown.slice(0, 12)),
    });
  } else {
    items.push({ key: "rules", label: "Code rules", status: "pass", detail: "No wallet, outer-page, socket, eval, miner, phishing or reviewer-directed code found." });
  }

  const extFail = scan.external.filter((e) => e.severity === "fail");
  const extWarn = scan.external.filter((e) => e.severity === "warn");
  if (extFail.length || extWarn.length) {
    const shown = [...extFail, ...extWarn];
    items.push({
      key: "external",
      label: "Outside resources",
      status: extFail.length ? "fail" : "warn",
      detail: shown.slice(0, 6).map((e) => `${e.file}:${e.line} ${e.message}`).join(" | "),
      fixPrompt: [...new Set(shown.slice(0, 8).map((e) => e.fixPrompt))].join(" "),
    });
  } else {
    items.push({ key: "external", label: "Outside resources", status: "pass", detail: "Everything loads from the build." });
  }

  if (scan.minified.length) {
    const files = scan.minified.map((m) => `${m.file}${m.inline ? ` (inline script at line ${m.line})` : ""}`);
    items.push({
      key: "minified",
      label: "Readable code",
      status: "fail",
      detail: `Minified code of the game's own: ${files.slice(0, 6).join(", ")}. Libraries are only accepted when they match a pinned build in rules/static-rules.json.`,
      fixPrompt: `Replace ${files.slice(0, 6).join(", ")} with readable, unminified source. If a file is a library (three, phaser, pixi.js, howler, matter-js, tone), use an exact, unmodified build of a version listed in rules/static-rules.json "libraries" so it is recognised by its hash.`,
    });
  } else {
    items.push({ key: "minified", label: "Readable code", status: "pass", detail: "No minified or obfuscated code of the game's own." });
  }

  items.push({
    key: "libraries",
    label: "Libraries",
    status: "pass",
    detail: scan.libraries.length
      ? scan.libraries.map((l) => `${l.file} = ${l.name}@${l.version} ${l.libFile}`).join(", ") + " (not checked by the code rules)."
      : "No known library files.",
  });
  return items;
}
