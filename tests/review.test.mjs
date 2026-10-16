import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeVerdict, review, buildRequest, trimDiff, checksSummary, VERDICT_TOOL } from "../scripts/review/review.mjs";
import { renderComment, desiredLabels, commitStatus, md, fence, MARKER } from "../scripts/review/comment.mjs";

const REVIEW = fileURLToPath(new URL("../scripts/review/review.mjs", import.meta.url));
const checks = {
  version: 1,
  slug: "tiny-canvas",
  kind: "new",
  textOnly: false,
  needsHuman: [],
  status: "pass",
  buildHash: "a".repeat(64),
  items: [
    { key: "scope", label: "One game per PR", status: "pass", detail: "New game." },
    { key: "rules", label: "Code rules", status: "warn", detail: "src/a.js:1 eval-any", fixPrompt: "Replace eval." },
  ],
};

test("a blocker or failed checks never leave the verdict at approve", () => {
  const blocker = normalizeVerdict({ verdict: "approve", summary: "ok", issues: [{ lens: "security", severity: "blocker", file: "src/a.js", line: 3, plain: "Calls window.ethereum.", fixPrompt: "Remove it." }] });
  assert.equal(blocker.verdict, "changes");
  assert.match(blocker.summary, /blocker/);
  assert.deepEqual(blocker.issues[0], { lens: "security", severity: "blocker", file: "src/a.js", line: 3, plain: "Calls window.ethereum.", fixPrompt: "Remove it." });
  assert.equal(normalizeVerdict({ verdict: "approve", summary: "ok", issues: [] }, { checks: { status: "fail" } }).verdict, "changes");
  assert.equal(normalizeVerdict({ verdict: "approve", summary: "ok", issues: [] }, { checks }).verdict, "approve");
});

test("verdict input is normalized", () => {
  const v = normalizeVerdict({ verdict: "yes", summary: "a‮b", issues: [{ lens: "x", severity: "y", plain: "p", file: "", line: 0, fixPrompt: "" }, { plain: "" }, null] });
  assert.equal(v.verdict, "flag");
  assert.equal(v.summary, "ab");
  assert.deepEqual(v.issues, [{ lens: "quality", severity: "major", plain: "p" }]);
});

test("no API key: flag, not configured", async () => {
  const v = await review({ rubric: "r", gameJson: "{}", checks, diff: { text: "" }, shotPaths: [], apiKey: undefined });
  assert.deepEqual(v, { verdict: "flag", summary: "Agent review not configured", issues: [] });
});

test("the request: strict verdict tool, untrusted wrappers, images, fallbacks", () => {
  const { body, headers } = buildRequest({ rubric: "RUBRIC", gameJson: '{"slug":"x"}', checks, diff: { text: "+code" }, shots: [{ name: "desktop-5s.png", data: "AAAA" }], model: "claude-sonnet-5-5" });
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.tools[0].name, "submit_verdict");
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tool_choice.type, "auto");
  assert.ok(body.system.includes("RUBRIC"));
  const texts = body.messages[0].content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.ok(texts.includes("<untrusted_diff>\n+code\n</untrusted_diff>"));
  assert.ok(texts.includes("<untrusted_game_json>"));
  const img = body.messages[0].content.find((c) => c.type === "image");
  assert.deepEqual(img.source, { type: "base64", media_type: "image/png", data: "AAAA" });
  assert.equal(body.fallbacks, "default");
  assert.equal(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const other = buildRequest({ rubric: "", gameJson: null, checks: null, diff: { text: "" }, shots: [], model: "claude-haiku-5-5" });
  assert.equal(other.body.fallbacks, undefined);
  // every object in the tool schema is closed and lists all its properties as required (strict)
  const walk = (s) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === "array") walk(s.items);
  };
  walk(VERDICT_TOOL.input_schema);
});

test("the API call: a tool call becomes the verdict; a missing one is asked for again; refusals flag", async () => {
  const realFetch = globalThis.fetch;
  const replies = [];
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    const r = replies.shift();
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    replies.push({ model: "claude-sonnet-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "submit_verdict", input: { verdict: "approve", summary: "Fine.", issues: [] } }] });
    const v1 = await review({ rubric: "r", gameJson: "{}", checks, diff: { text: "" }, shotPaths: [], apiKey: "k", model: "claude-sonnet-5-5" });
    assert.equal(v1.verdict, "approve");
    assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(sent[0].init.headers["x-api-key"], "k");
    assert.equal(sent[0].init.headers["anthropic-version"], "2023-06-01");

    sent.length = 0;
    replies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Thinking it over." }] });
    replies.push({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "submit_verdict", input: { verdict: "changes", summary: "Fix it.", issues: [] } }] });
    const v2 = await review({ rubric: "r", gameJson: "{}", checks, diff: { text: "" }, shotPaths: [], apiKey: "k" });
    assert.equal(v2.verdict, "changes");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.messages.length, 3, "the reply is appended, then a user nudge");

    replies.push({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] });
    const v3 = await review({ rubric: "r", gameJson: "{}", checks, diff: { text: "" }, shotPaths: [], apiKey: "k" });
    assert.equal(v3.verdict, "flag");
    assert.match(v3.summary, /cyber/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("trimDiff puts code first and keeps within budget", () => {
  const diff = ["diff --git a/games/x/src/style.css b/games/x/src/style.css\n+a{}\n", "diff --git a/games/x/src/game.js b/games/x/src/game.js\n+" + "x".repeat(500) + "\n", "diff --git a/games/x/game.json b/games/x/game.json\n+{}\n"].join("");
  const t = trimDiff(diff, { maxFile: 200, maxTotal: 10000 });
  assert.ok(t.text.indexOf("game.json") < t.text.indexOf("game.js b/") && t.text.indexOf("game.js b/") < t.text.indexOf("style.css"));
  assert.match(t.text, /more lines of games\/x\/src\/game\.js not shown/);
  const small = trimDiff(diff, { maxFile: 1000, maxTotal: 100 });
  assert.match(small.text, /over the size budget/);
});

test("checksSummary survives junk", () => {
  assert.match(checksSummary(null), /missing/);
  assert.match(checksSummary({ items: [{ status: "fail", label: "x".repeat(500), detail: { a: 1 } }] }), /\[fail\]/);
});

test("the CLI writes a not-configured verdict without a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-review-"));
  try {
    writeFileSync(join(dir, "checks.json"), JSON.stringify(checks));
    writeFileSync(join(dir, "pr.diff"), "diff --git a/games/x/src/a.js b/games/x/src/a.js\n+1\n");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    execFileSync("node", [REVIEW, "--diff", join(dir, "pr.diff"), "--checks", join(dir, "checks.json"), "--out", join(dir, "verdict.json")], { env, stdio: "pipe" });
    const v = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
    assert.equal(v.verdict, "flag");
    assert.equal(v.summary, "Agent review not configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- comment ----

test("comment: table, verdict, issues with fix prompts", () => {
  const verdict = { verdict: "changes", summary: "Needs work.", issues: [{ lens: "scoring", severity: "blocker", file: "src/game.js", line: 40, plain: "runEnd is called twice.", fixPrompt: "Guard runEnd with a flag." }], model: "claude-sonnet-5-5" };
  const c = renderComment(checks, verdict, { runUrl: "https://github.com/DegenHive/degenhive-games/actions/runs/123" });
  assert.ok(c.startsWith(MARKER));
  assert.match(c, /\| One game per PR \| pass \| New game\. \|/);
  assert.match(c, /Agent review: Changes requested/);
  assert.match(c, /`src\/game\.js:40`/);
  assert.match(c, /<details><summary>Fix prompt<\/summary>/);
  assert.match(c, /Guard runEnd with a flag\./);
  assert.match(c, /actions\/runs\/123/);
});

test("comment: untrusted text cannot inject HTML, mentions, links or table cells", () => {
  const evil = '<img src=x onerror=alert(1)> @org/team [click](https://evil.example) | cell ![i](https://t.example/p.png)';
  const c = renderComment({ ...checks, slug: evil, items: [{ label: evil, status: "fail", detail: evil, fixPrompt: "```\n</details><b>x</b>" }] }, { verdict: "flag", summary: evil, issues: [{ lens: "security", severity: "blocker", plain: evil, file: "a`b", fixPrompt: "````" }] });
  assert.ok(!c.includes("<img"));
  assert.ok(!c.includes("@org"));
  assert.ok(!c.includes("](https://"));
  assert.ok(!/[^\\]\| cell/.test(c));
  // fences are longer than any backtick run inside them
  assert.ok(c.includes("````text\n```\n</details><b>x</b>\n````"));
  assert.ok(c.includes("   `````text\n   ````\n   `````"));
});

test("md and fence", () => {
  assert.equal(md("a|b"), "a\\|b");
  assert.equal(md("x".repeat(20), 5), "xxxxx…");
  assert.equal(fence("a"), "```text\na\n```");
});

test("labels and commit status", () => {
  assert.deepEqual(desiredLabels(checks, { verdict: "approve" }), ["checks-pass", "agent-approved", "new-game"]);
  assert.deepEqual(desiredLabels({ ...checks, status: "fail", kind: "update", textOnly: true, needsHuman: ["backend: https://a.example"] }, { verdict: "flag" }), [
    "checks-fail",
    "agent-flagged",
    "update",
    "text-only",
    "needs-human",
  ]);
  assert.equal(commitStatus({ verdict: "approve" }).state, "success");
  assert.equal(commitStatus({ verdict: "changes" }).state, "failure");
  assert.equal(commitStatus({ verdict: "flag" }).state, "failure");
});
