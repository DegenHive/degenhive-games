#!/usr/bin/env node
// Renders checks.json and verdict.json as the sticky PR comment, and (with --post) updates that
// comment, the labels and the commit status on GitHub.
//
//   node scripts/review/comment.mjs --checks checks.json --verdict verdict.json [--out comment.md]
//        [--post --repo owner/name --pr <n> [--head-sha <sha>] [--run-url <url>]]
//
// Env for --post: GITHUB_TOKEN (pull-requests: write, issues: write, statuses: write).
// Both input files come from jobs that handled pull-request content: every string from them is
// escaped before it reaches Markdown.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, die } from "../lib/args.mjs";

export const MARKER = "<!-- degenhive-review -->";
export const STATUS_CONTEXT = "degenhive/agent-review";

/** Labels this script owns, by group. */
export const LABELS = {
  checks: ["checks-pass", "checks-fail"],
  agent: ["agent-approved", "agent-changes", "agent-flagged"],
  kind: ["new-game", "update"],
  text: ["text-only"],
  human: ["needs-human"],
};

// ---- escaping ----

/** Escapes text for Markdown prose and table cells: no HTML, links, images, mentions or tables. */
export function md(s, max = 1000) {
  let t = String(s ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩​-‏]/g, "")
    .replace(/[\u{E0000}-\u{E007F}]/gu, "");
  if (t.length > max) t = t.slice(0, max) + "…";
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()#|!~])/g, "\\$1")
    .replace(/@/g, "@​")
    .replace(/\r?\n/g, " ")
    .replace(/:\/\//g, ":​//");
}

/** A fenced code block that the content cannot break out of. */
export function fence(s, lang = "text", max = 4000) {
  let t = String(s ?? "").replace(/[‪-‮⁦-⁩]/g, "").replace(/[\u{E0000}-\u{E007F}]/gu, "");
  if (t.length > max) t = t.slice(0, max) + "\n…";
  const longest = Math.max(2, ...(t.match(/`+/g) || []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${t}\n${f}`;
}

const STATUS_WORD = { pass: "pass", warn: "warn", fail: "**fail**", pending: "pending", running: "running" };
const VERDICT_WORD = { approve: "Approve", changes: "Changes requested", flag: "Flagged for a human" };

// ---- rendering ----

export function renderComment(checks, verdict, { runUrl = null } = {}) {
  const c = checks && Array.isArray(checks.items) ? checks : null;
  const v = verdict && typeof verdict === "object" ? verdict : null;
  const slug = c ? md(c.slug, 40) : "unknown";
  const lines = [MARKER];
  const head = [`checks ${c ? (c.status === "fail" ? "**fail**" : "pass") : "missing"}`, `agent: ${v ? VERDICT_WORD[v.verdict] || "unknown" : "not run"}`];
  lines.push(`## ${slug}: ${head.join(" · ")}`, "");
  if (c) {
    const meta = [c.kind === "new" ? "New game" : c.kind === "update" ? "Update" : null, c.textOnly ? "text only" : null, c.buildHash ? `build \`${String(c.buildHash).replace(/[^0-9a-f]/g, "").slice(0, 12)}\`` : null].filter(Boolean);
    if (meta.length) lines.push(meta.join(" · "), "");
    if (Array.isArray(c.needsHuman) && c.needsHuman.length) lines.push(`Needs a human approval: ${c.needsHuman.slice(0, 10).map((x) => md(x, 120)).join(", ")}`, "");
    lines.push("| Check | Result | Detail |", "|---|---|---|");
    for (const i of c.items.slice(0, 60)) lines.push(`| ${md(i.label, 60)} | ${STATUS_WORD[i.status] || md(i.status, 10)} | ${md(i.detail, 400)} |`);
    lines.push("");
    const fixes = c.items.filter((i) => (i.status === "fail" || i.status === "warn") && i.fixPrompt).slice(0, 20);
    if (fixes.length) {
      lines.push("<details><summary>Fix prompts for the checks</summary>", "");
      for (const i of fixes) lines.push(`**${md(i.label, 60)}**`, "", fence(i.fixPrompt), "");
      lines.push("</details>", "");
    }
  } else {
    lines.push("The checks did not produce results.", "");
  }

  lines.push(`### Agent review: ${v ? VERDICT_WORD[v.verdict] || "unknown" : "not run"}`, "");
  if (v) {
    lines.push(md(v.summary, 2000), "");
    const issues = Array.isArray(v.issues) ? v.issues.slice(0, 30) : [];
    if (issues.length) {
      lines.push("#### Issues", "");
      issues.forEach((i, n) => {
        const where = i.file ? ` \`${String(i.file).replace(/[`\n]/g, "").slice(0, 200)}${Number.isInteger(i.line) && i.line > 0 ? ":" + i.line : ""}\`` : "";
        lines.push(`${n + 1}. **${md(i.severity, 10)}** · ${md(i.lens, 10)}${where}: ${md(i.plain, 1000)}`);
        if (i.fixPrompt) lines.push("", "   <details><summary>Fix prompt</summary>", "", fence(i.fixPrompt).replace(/^/gm, "   "), "", "   </details>", "");
      });
      lines.push("");
    }
    if (v.model) lines.push(`<sub>Reviewed by ${md(v.model, 60)}. The verdict is advice; a human merges.</sub>`, "");
  }
  if (runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl)) {
    lines.push(`Screenshots and \`checks.json\` are in the [checks run artifacts](${runUrl}).`, "");
  }
  return lines.join("\n");
}

export function desiredLabels(checks, verdict) {
  const out = [];
  if (checks && checks.status) out.push(checks.status === "fail" ? "checks-fail" : "checks-pass");
  if (verdict && verdict.verdict) out.push({ approve: "agent-approved", changes: "agent-changes", flag: "agent-flagged" }[verdict.verdict]);
  if (checks && checks.kind === "new") out.push("new-game");
  if (checks && checks.kind === "update") out.push("update");
  if (checks && checks.textOnly) out.push("text-only");
  if ((checks && Array.isArray(checks.needsHuman) && checks.needsHuman.length) || (verdict && verdict.verdict === "flag")) out.push("needs-human");
  return out.filter(Boolean);
}

/** The degenhive/agent-review status, or null when the review did not run (no API key yet). */
export function commitStatus(verdict) {
  if (!verdict || verdict.summary === "Agent review not configured") return null;
  const v = verdict.verdict;
  if (v === "approve") return { state: "success", description: "Agent review: approve" };
  if (v === "changes") return { state: "failure", description: "Agent review: changes requested" };
  return { state: "failure", description: "Agent review: flagged for a human" };
}

// ---- GitHub ----

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function post({ repo, pr, body, labels, headSha, status }) {
  // Sticky comment: the one this bot wrote with the marker.
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const list = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!list || !list.length) break;
    existing = list.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER) && c.user && c.user.type === "Bot");
  }
  if (existing) await gh("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  else await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });

  const managed = Object.values(LABELS).flat();
  const current = ((await gh("GET", `/repos/${repo}/issues/${pr}/labels?per_page=100`)) || []).map((l) => l.name);
  for (const name of current) if (managed.includes(name) && !labels.includes(name)) await gh("DELETE", `/repos/${repo}/issues/${pr}/labels/${encodeURIComponent(name)}`);
  const add = labels.filter((l) => !current.includes(l));
  if (add.length) await gh("POST", `/repos/${repo}/issues/${pr}/labels`, { labels: add });

  if (headSha && status) await gh("POST", `/repos/${repo}/statuses/${headSha}`, { ...status, context: STATUS_CONTEXT });
}

function readJson(p) {
  if (!p || !existsSync(resolve(p))) return null;
  try {
    return JSON.parse(readFileSync(resolve(p), "utf8"));
  } catch {
    return null;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2), { flags: ["post"] });
  const checks = readJson(a.checks);
  const verdict = readJson(a.verdict);
  const body = renderComment(checks, verdict, { runUrl: a.runUrl || null });
  if (a.out) writeFileSync(resolve(a.out), body + "\n");
  else if (!a.post) console.log(body);
  if (a.post) {
    if (!process.env.GITHUB_TOKEN || !a.repo || !/^\d+$/.test(String(a.pr))) die("--post needs GITHUB_TOKEN, --repo and --pr");
    if (a.headSha && !/^[0-9a-f]{40}$/.test(a.headSha)) die("bad --head-sha");
    const labels = desiredLabels(checks, verdict);
    await post({ repo: a.repo, pr: Number(a.pr), body, labels, headSha: a.headSha || null, status: verdict ? commitStatus(verdict) : null });
    console.log(`posted the review comment on #${a.pr} with labels: ${labels.join(", ")}`);
  }
}
