// The ESM build must load in a bundler's world: `import DegenHive from "dist/sdk.mjs"`.
// Run it in a child process with a minimal fake browser global (no frame: local mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const mjs = fileURLToPath(new URL("../dist/sdk.mjs", import.meta.url));
const dts = readFileSync(new URL("../dist/sdk.d.ts", import.meta.url), "utf8");
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("dist/sdk.mjs default and named export are the same object, in local mode", () => {
  const script = `
    const g = globalThis;
    g.window = g; g.parent = g;
    g.location = { hostname: "game.localhost" };
    g.document = { readyState: "complete", visibilityState: "visible", addEventListener() {} };
    g.addEventListener = () => {};
    g.removeEventListener = () => {};
    g.dispatchEvent = () => true;
    const m = await import(${JSON.stringify(mjs)});
    const out = {
      same: m.default === m.DegenHive && m.default === g.DegenHive,
      version: m.default.version,
      mode: (await m.default.session()).mode,
      r: m.default.random(1)(),
    };
    console.log("RESULT " + JSON.stringify(out));
    process.exit(0);
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.deepEqual(JSON.parse(line.slice(7)), { same: true, version, mode: "local", r: 0.6270739405881613 });
});

test("dist/sdk.d.ts declares the whole API of PROTOCOL.md section 4", () => {
  for (const needle of [
    "readonly version: string",
    "ready(): void",
    "session(): Promise<Session>",
    "runStart(): Promise<RunStart>",
    "runEnd(result: { score: number; log?: string }): Promise<RunResult>",
    "get(): Promise<string | null>",
    "set(data: string): Promise<void>",
    "track(name: TrackName, props?: TrackProps): void",
    "openLink(url: string): Promise<boolean>",
    "on<E extends DegenHiveEvent>",
    "random(seed: number): () => number",
    '"practice" | "points" | "preview" | "local"',
    "declare global",
  ]) {
    assert.ok(dts.includes(needle), "missing in sdk.d.ts: " + needle);
  }
});
