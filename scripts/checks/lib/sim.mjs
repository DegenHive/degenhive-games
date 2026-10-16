// The sim module of docs/PROTOCOL.md section 3: an ES module that exports init(seed),
// step(state, input, dt), score(state) and isOver(state), with no Math.random, Date or
// performance.now, and nothing else from the outside world.
import { readFileSync } from "node:fs";

/** Removes // and /* *\/ comments, keeping strings and line breaks (so line numbers hold). */
export function stripComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        if (code[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === "\\") {
          out += code[i] + (code[i + 1] || "");
          i += 2;
          continue;
        }
        if (q !== "`" && code[i] === "\n") break;
        out += code[i++];
      }
      if (i < n) out += code[i++];
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const FORBIDDEN = [
  [/\bMath\s*\.\s*random\b/, "Math.random"],
  [/\bDate\b/, "Date"],
  [/\bperformance\b/, "performance"],
  [/\b(?:window|document|globalThis|self|navigator|location)\b/, "the browser (window, document, navigator)"],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, "storage"],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/, "the network"],
  [/\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/, "timers"],
  [/\bDegenHive\b/, "the DegenHive SDK"],
  [/\bcrypto\b/, "crypto"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\bimport\b[^;]*?\bfrom\s*["'](?!\.\.?\/)/, "imports that are not relative files"],
  [/\beval\s*\(|\bnew\s+Function\b/, "eval"],
];
const EXPORTS = ["init", "step", "score", "isOver"];

function exportsName(code, name) {
  return new RegExp(
    String.raw`export\s+(?:async\s+)?function\s*\*?\s*${name}\b|export\s+(?:const|let|var)\s+${name}\b|export\s*\{[^}]*\b${name}\b[^}]*\}`,
  ).test(code);
}

/** Problems with a sim module's source, as plain strings. */
export function simProblems(source) {
  const code = stripComments(source);
  const problems = [];
  const lines = code.split("\n");
  for (const [re, what] of FORBIDDEN) {
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) problems.push(`uses ${what} (line ${at + 1})`);
  }
  const missing = EXPORTS.filter((e) => !exportsName(code, e));
  if (missing.length) problems.push(`does not export ${missing.join(", ")}`);
  return problems;
}

export function simItem(game) {
  const g = game.game || {};
  const key = "sim";
  const label = "Simulation module";
  if (typeof g.sim !== "string") {
    return { key, label, status: "pass", detail: g.scored ? "No sim module (optional until replay checks ship)." : "Not a scored game." };
  }
  const f = game.src.find((x) => x.path === g.sim && !x.symlink && !x.special);
  if (!f) return { key, label, status: "fail", detail: `src/${g.sim} does not exist.`, fixPrompt: `Add src/${g.sim}, or set "sim": null in game.json.` };
  const problems = simProblems(readFileSync(f.abs, "utf8"));
  if (!problems.length) return { key, label, status: "pass", detail: `src/${g.sim} exports init, step, score and isOver and uses nothing from outside.` };
  return {
    key,
    label,
    status: "fail",
    detail: `src/${g.sim} ${problems.join("; ")}.`,
    fixPrompt:
      `Make src/${g.sim} a pure ES module (docs/PROTOCOL.md section 3): export init(seed), step(state, input, dt), score(state) and isOver(state); ` +
      "take all randomness from a generator seeded by init's seed (for example mulberry32); do not use Math.random, Date, performance.now, timers, the DOM, storage, the network or DegenHive; " +
      `import only other relative files. Problems: ${problems.join("; ")}.`,
  };
}
