// Sandbox run of docs/PROTOCOL.md and plans/GAMES-BUILD-PLAN.md "checks.yml" step 6.
//
// Serves the game as a live build from a temporary storage root through tools/edge-dev (the
// production headers), frames it in the edge-dev test host (the bridge handshake of PROTOCOL.md
// section 5) and plays it with scripted random input in Playwright Chromium, on a desktop and
// on a phone viewport. Records time to ready, SDK calls and bridge events, runEnd calls per run,
// CSP violations, console errors, network attempts to other origins, JS heap, CPU and frame rate,
// and takes screenshots.
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLocalBuild } from "../lib/local-store.mjs";
import { startEdgeDev } from "../../tools/edge-dev/server.mjs";
import { libraryIndex } from "../lib/cdn.mjs";
import { referencedLibraries, ensureLibraries, DEFAULT_LIBS_DIR } from "../lib/libs.mjs";
import { RULES_PATH } from "./lib/rules.mjs";

export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const READY_LIMIT_MS = 10000;
const DESKTOP_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter", "KeyW", "KeyA", "KeyS", "KeyD", "KeyZ", "KeyX", "KeyJ", "KeyK", "ShiftLeft"];

// Messages the browser prints about our own headers, not about the game.
const BROWSER_NOISE = [/Permissions-Policy header: Unrecognized feature/i, /Error with Permissions-Policy header/i];

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in every frame before the page's scripts. Only acts inside game frames (*.localhost). */
function probe() {
  const h = location.hostname;
  if (!(h.endsWith(".localhost") && h !== "localhost")) return;
  const send = (type, data) => {
    try {
      if (typeof window.__dhProbe === "function") window.__dhProbe(Object.assign({ type, t: Math.round(performance.now()) }, data || {}));
    } catch (e) {
      // the binding can be missing for a moment during navigation
    }
  };
  const cut = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n);
  document.addEventListener("securitypolicyviolation", (e) =>
    send("csp", {
      directive: cut(e.effectiveDirective || e.violatedDirective, 60),
      blocked: cut(e.blockedURI, 200),
      source: cut(e.sourceFile, 200),
      line: e.lineNumber || 0,
      sample: cut(e.sample, 120),
    }),
  );
  addEventListener("error", (e) => send("error", { message: cut(e.message, 300), source: cut(e.filename, 200), line: e.lineno || 0 }), true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send("rejection", { message: cut(r && r.message ? r.message : r, 300) });
  });

  let run = 0;
  const ends = {};
  const wrap = (api) => {
    if (!api || typeof api !== "object") return api;
    const w = Object.assign({}, api);
    w.ready = function () {
      send("call", { fn: "ready" });
      return api.ready.apply(api, arguments);
    };
    w.runStart = function () {
      const n = ++run;
      ends[n] = 0;
      send("call", { fn: "runStart", run: n });
      const p = api.runStart.apply(api, arguments);
      p.then(
        (r) => send("runStarted", { run: n, runId: cut(r && r.runId, 80) }),
        (e) => send("callError", { fn: "runStart", run: n, code: cut(e && e.code, 40), message: cut(e && e.message, 200) }),
      );
      return p;
    };
    w.runEnd = function (res) {
      const n = run;
      ends[n] = (ends[n] || 0) + 1;
      let score;
      try {
        score = res && res.score;
      } catch (e) {
        score = "unreadable";
      }
      send("call", { fn: "runEnd", run: n, count: ends[n], score: typeof score === "number" ? score : cut(score, 40) });
      const p = api.runEnd.apply(api, arguments);
      p.then(
        (r) => send("runEnded", { run: n, accepted: !!(r && r.accepted) }),
        (e) => send("callError", { fn: "runEnd", run: n, code: cut(e && e.code, 40), message: cut(e && e.message, 200) }),
      );
      return p;
    };
    return Object.freeze(w);
  };
  let wrapped;
  try {
    Object.defineProperty(window, "DegenHive", {
      configurable: true,
      enumerable: true,
      get() {
        return wrapped;
      },
      set(v) {
        wrapped = wrap(v);
      },
    });
  } catch (e) {
    // a page that defines DegenHive first is reported by the missing calls
  }
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  Object.defineProperty(window, "__dhProbeStats", {
    value: () => ({ frames, ms: performance.now() - t0, heap: performance.memory ? performance.memory.usedJSHeapSize : null }),
  });
}

async function cdpMetrics(session) {
  if (!session) return null;
  try {
    const { metrics } = await session.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { at: m.Timestamp, heap: m.JSHeapUsedSize, task: m.TaskDuration, script: m.ScriptDuration };
  } catch {
    return null;
  }
}

async function playOne(browser, name, { hostUrl, gameOrigin, seconds, shotsDir, seed, log }) {
  const vp = VIEWPORTS[name];
  const context = await browser.newContext({ ...vp, serviceWorkers: "block", locale: "en-US" });
  const out = {
    viewport: name,
    size: `${vp.viewport.width}x${vp.viewport.height}`,
    handshake: null,
    readyMs: null,
    readySource: null,
    calls: { ready: 0, runStart: 0, runEnd: 0 },
    runs: [],
    callErrors: [],
    bridge: null,
    csp: [],
    errors: [],
    console: [],
    network: [],
    heapMb: null,
    cpu: null,
    fps: null,
    screenshots: [],
  };
  const gameHost = new URL(gameOrigin).host;
  const allowedHosts = new Set([gameHost, new URL(hostUrl).host]);
  const probeRuns = new Map();
  let frameT0 = null;

  await context.exposeBinding("__dhProbe", (source, p) => {
    if (!p || typeof p !== "object") return;
    if (p.type === "csp") out.csp.push({ via: "event", directive: p.directive, blocked: p.blocked, source: p.source, line: p.line, sample: p.sample });
    else if (p.type === "error" || p.type === "rejection") out.errors.push({ kind: p.type, message: p.message, source: p.source || "", line: p.line || 0 });
    else if (p.type === "call") {
      if (p.fn in out.calls) out.calls[p.fn]++;
      if (p.fn === "ready" && out.readyMs === null && frameT0 === null) frameT0 = p.t;
      if (p.fn === "runStart") probeRuns.set(p.run, { run: p.run, runId: null, ends: 0, scores: [], startT: p.t });
      if (p.fn === "runEnd") {
        const r = probeRuns.get(p.run) || { run: p.run, runId: null, ends: 0, scores: [], startT: null };
        r.ends = Math.max(r.ends, p.count || 0);
        r.scores.push(p.score);
        r.endT = p.t;
        probeRuns.set(p.run, r);
      }
    } else if (p.type === "runStarted") {
      const r = probeRuns.get(p.run);
      if (r) r.runId = p.runId;
    } else if (p.type === "callError") {
      if (out.callErrors.length < 50) out.callErrors.push({ fn: p.fn, run: p.run, code: p.code, message: p.message });
    }
  });
  await context.addInitScript(probe);

  await context.route("**/*", (route) => {
    const u = route.request().url();
    let host = "";
    try {
      host = new URL(u).host;
    } catch {
      // unparsable URL: treat as external
    }
    if (allowedHosts.has(host)) return route.continue();
    if (out.network.length < 100) out.network.push({ url: u.slice(0, 300), type: route.request().resourceType() });
    return route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    if (BROWSER_NOISE.some((re) => re.test(text))) return;
    const loc = msg.location() || {};
    if (out.console.length < 200) out.console.push({ type, text: text.slice(0, 400), url: String(loc.url || "").slice(0, 200), line: loc.lineNumber || 0 });
  });
  page.on("pageerror", (e) => {
    if (out.errors.length < 200) out.errors.push({ kind: "pageerror", message: String(e && e.message).slice(0, 300), source: "", line: 0 });
  });
  page.on("websocket", (ws) => {
    if (out.network.length < 100) out.network.push({ url: ws.url().slice(0, 300), type: "websocket" });
  });

  const started = Date.now();
  await page.goto(hostUrl, { waitUntil: "load", timeout: 30000 });
  const frameEl = page.locator("#frame");
  let box = await frameEl.boundingBox();

  // Wait for the game frame so input lands in it.
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) {
    frame = page.frames().find((f) => f.url().startsWith(gameOrigin));
    if (!frame) await sleep(50);
  }
  let cdp = null;
  if (frame) {
    try {
      cdp = await context.newCDPSession(frame); // works when the game frame is out of process
    } catch {
      cdp = null;
    }
  }
  if (!cdp) {
    try {
      cdp = await context.newCDPSession(page);
    } catch {
      cdp = null;
    }
  }
  if (cdp) await cdp.send("Performance.enable").catch(() => {});
  const pageCdp = vp.hasTouch ? await context.newCDPSession(page).catch(() => null) : null;

  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const point = () => ({ x: box.x + 8 + rand() * (box.width - 16), y: box.y + 8 + rand() * (box.height - 16) });
  const center = () => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

  const shotTimes = [...new Set([5, Math.round(seconds / 2), seconds].filter((s) => s > 0 && s <= seconds))].sort((a, b) => a - b);
  let nextShot = 0;
  let metricsStart = null;
  let maxHeap = 0;

  const elapsed = () => (Date.now() - started) / 1000;
  const act = async () => {
    const r = rand();
    if (vp.hasTouch) {
      if (r < 0.6) {
        const p = point();
        await page.touchscreen.tap(p.x, p.y);
      } else if (r < 0.85 && pageCdp) {
        const a = point();
        const b = point();
        const steps = 6;
        await pageCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
        for (let i = 1; i <= steps; i++) {
          await pageCdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }],
          });
          await sleep(16);
        }
        await pageCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        const p = point();
        await page.mouse.move(p.x, p.y, { steps: 4 });
      }
    } else if (r < 0.55) {
      const key = pick(DESKTOP_KEYS);
      await page.keyboard.down(key);
      await sleep(60 + rand() * 500);
      await page.keyboard.up(key);
    } else if (r < 0.75) {
      const p = point();
      await page.mouse.move(p.x, p.y, { steps: 5 });
    } else {
      const p = point();
      await page.mouse.click(p.x, p.y);
    }
  };

  // Opening moves: most games start on a click, a tap, Space or Enter.
  await sleep(800);
  try {
    const c = center();
    if (vp.hasTouch) await page.touchscreen.tap(c.x, c.y);
    else {
      await page.mouse.click(c.x, c.y);
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
    }
  } catch (e) {
    log(`${name}: opening input failed: ${e.message}`);
  }

  while (elapsed() < seconds) {
    if (nextShot < shotTimes.length && elapsed() >= shotTimes[nextShot]) {
      const file = join(shotsDir, `${name}-${shotTimes[nextShot]}s.png`);
      try {
        await frameEl.screenshot({ path: file, timeout: 5000 });
        out.screenshots.push(file);
      } catch (e) {
        log(`${name}: screenshot failed: ${e.message}`);
      }
      nextShot++;
    }
    if (metricsStart === null && elapsed() > 2) metricsStart = await cdpMetrics(cdp);
    try {
      box = (await frameEl.boundingBox()) || box;
      await act();
    } catch (e) {
      log(`${name}: input failed: ${e.message}`);
    }
    const m = await cdpMetrics(cdp);
    if (m && m.heap > maxHeap) maxHeap = m.heap;
    await sleep(80 + rand() * 250);
  }
  while (nextShot < shotTimes.length) {
    const file = join(shotsDir, `${name}-${shotTimes[nextShot]}s.png`);
    await frameEl.screenshot({ path: file, timeout: 5000 }).then(() => out.screenshots.push(file)).catch(() => {});
    nextShot++;
  }

  const host = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dh || null))).catch(() => null);
  const end = await cdpMetrics(cdp);
  let stats = null;
  if (frame && !frame.isDetached()) stats = await frame.evaluate(() => (window.__dhProbeStats ? window.__dhProbeStats() : null)).catch(() => null);

  out.bridge = host
    ? {
        hellos: host.hellos,
        ack: host.ack,
        loadedAt: host.loadedAt ?? null,
        readyAt: host.readyAt,
        events: host.events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {}),
        requests: host.requests.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {}),
        errors: host.errors.slice(0, 20),
        drops: host.drops.slice(0, 20),
        links: host.links.slice(0, 10),
        closed: host.closed,
        runs: host.runOrder.map((id) => ({ runId: id, ...host.runs[id] })),
      }
    : null;
  out.handshake = host ? !!host.ack : null;
  if (host && host.readyAt !== null) {
    out.readyMs = host.readyAt;
    out.readySource = "bridge";
  } else if (frameT0 !== null) {
    out.readyMs = frameT0;
    out.readySource = "frame";
  }
  out.runs = [...probeRuns.values()].sort((a, b) => a.run - b.run);
  if (end) {
    maxHeap = Math.max(maxHeap, end.heap || 0);
    if (metricsStart && end.at > metricsStart.at) out.cpu = Math.round(((end.task - metricsStart.task) / (end.at - metricsStart.at)) * 100) / 100;
  }
  if (!maxHeap && stats && stats.heap) maxHeap = stats.heap;
  out.heapMb = maxHeap ? Math.round((maxHeap / 1048576) * 10) / 10 : null;
  if (stats && stats.ms > 0) out.fps = Math.round((stats.frames * 1000) / stats.ms);

  await context.close();
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.game        a loaded game (scripts/lib/game.mjs)
 * @param {string} [opts.assetsRoot] directory with assets/<sha256>
 * @param {number} [opts.seconds=60]
 * @param {string} opts.shotsDir    where screenshots go
 * @param {string[]} [opts.viewports=["desktop","phone"]]
 * @param {string} [opts.libsDir]   cache of pinned library files (assets/<sha256>)
 * @param {boolean} [opts.fetchLibs=true] download missing pinned libraries from jsdelivr (hash-checked)
 * @returns {Promise<{ skipped?: string, viewports: object, missingAssets: string[], missingLibs: string[] }>}
 */
export async function runSandbox({
  game,
  assetsRoot = null,
  seconds = 60,
  shotsDir,
  viewports = ["desktop", "phone"],
  seed = 1,
  libsDir = DEFAULT_LIBS_DIR,
  fetchLibs = true,
  log = () => {},
}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { skipped: "Playwright is not installed (npm install)", viewports: {} };
  }
  mkdirSync(shotsDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "dh-sandbox-"));
  let dev = null;
  let browser = null;
  try {
    const staged = writeLocalBuild(root, game, { assetsRoot, setLive: true });
    // Pinned libraries the game loads by CDN URL are served by the edge from assets/<sha256>.
    const libIndex = libraryIndex(JSON.parse(readFileSync(RULES_PATH, "utf8")).libraries);
    const libs = referencedLibraries(game, libIndex);
    const libState = libs.length ? await ensureLibraries(libs, { dir: libsDir, fetchMissing: fetchLibs }) : { present: [], missing: [] };
    for (const lib of libState.present) {
      const dest = join(root, "assets", lib.sha256);
      if (!existsSync(dest)) copyFileSync(join(libsDir, "assets", lib.sha256), dest);
    }
    const missingLibs = libState.missing.map((m) => `${m.lib.name}@${m.lib.version}/${m.lib.file} (${m.reason})`);
    dev = await startEdgeDev({ root, port: 0 });
    try {
      browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
    } catch (e) {
      return { skipped: `Chromium did not start (${String(e.message).split("\n")[0]}). Run: npx playwright install chromium`, viewports: {} };
    }
    const gameOrigin = `http://${game.slug}.localhost:${dev.port}`;
    const hostUrl = `${dev.origin}/__host?slug=${game.slug}`;
    const results = {};
    for (const name of viewports) {
      log(`sandbox: ${name} for ${seconds}s`);
      results[name] = await playOne(browser, name, { hostUrl, gameOrigin, seconds, shotsDir, seed, log });
    }
    // CSP reports posted to report-uri, added to the viewport they belong to by time.
    const reports = dev.reports.map((r) => ({
      via: "report",
      directive: r.report["effective-directive"] || r.report["violated-directive"] || "",
      blocked: String(r.report["blocked-uri"] || "").slice(0, 200),
      source: String(r.report["source-file"] || "").slice(0, 200),
      line: r.report["line-number"] || 0,
      sample: String(r.report["script-sample"] || "").slice(0, 120),
    }));
    return { viewports: results, cspReports: reports, missingAssets: staged.missingAssets, missingLibs, buildHash: staged.hash };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dev) await dev.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- CheckItems ----

const fmtMs = (ms) => (ms === null || ms === undefined ? "never" : `${(ms / 1000).toFixed(1)} s`);

function cspKey(v) {
  return `${v.directive}|${v.blocked}`;
}

/** Turns a runSandbox result into CheckItems (plans/games/API.md section 5). */
export function sandboxItems(result, game, { backends = [] } = {}) {
  const g = game.game || {};
  if (!result || result.skipped) {
    const why = result ? result.skipped : "not run";
    return [{ key: "sandbox", label: "Sandbox run", status: "warn", detail: `Skipped: ${why}.` }];
  }
  const vps = Object.values(result.viewports);
  const items = [];

  // Ready
  {
    const fails = [];
    const parts = [];
    for (const v of vps) {
      const mustWork = v.viewport === "desktop" || g.mobile === true;
      const ok = v.readyMs !== null && v.readyMs <= READY_LIMIT_MS;
      parts.push(`${v.viewport} ${fmtMs(v.readyMs)}${v.handshake === false ? " (no handshake)" : ""}`);
      if (!ok && mustWork) fails.push(v.viewport);
    }
    const noHandshake = vps.filter((v) => v.handshake === false && v.calls.ready + v.calls.runStart > 0);
    let status = fails.length ? "fail" : "pass";
    let detail = `Time to DegenHive.ready(): ${parts.join(", ")}. Limit 10 s.`;
    if (noHandshake.length && status === "pass") {
      status = "warn";
      detail += " The SDK did not answer the host's hello, so the game ran in local mode.";
    }
    items.push({
      key: "sandbox.ready",
      label: "Ready within 10 s",
      status,
      detail,
      ...(status === "fail"
        ? {
            fixPrompt:
              "Call DegenHive.ready() exactly once, as soon as the first screen can take input, and within 10 seconds of the page loading. Do not wait for a click or for every asset to load before calling it." +
              (fails.includes("phone") ? " The game did not get ready on a 390x844 phone screen; make sure it loads and lays out on small touch screens, or set \"mobile\": false in game.json." : ""),
          }
        : {}),
    });
  }

  // Runs
  {
    const allRuns = vps.flatMap((v) => v.runs.map((r) => ({ ...r, viewport: v.viewport })));
    const doubles = allRuns.filter((r) => r.ends > 1);
    const ends = allRuns.filter((r) => r.ends > 0);
    const max = g.scoring && Number.isInteger(g.scoring.maxScore) ? g.scoring.maxScore : 1000000;
    const badScores = ends.flatMap((r) => r.scores).filter((s) => !(Number.isInteger(s) && s >= 0 && s <= max));
    const bridgeDoubles = vps.flatMap((v) => (v.bridge ? v.bridge.runs.filter((r) => r.ends > 1) : []));
    const fast = [];
    if (g.scoring && g.scoring.maxPointsPerSecond > 0) {
      for (const v of vps) {
        for (const r of v.bridge ? v.bridge.runs : []) {
          if (r.score !== null && r.durationMs > 0 && r.score / (r.durationMs / 1000) > g.scoring.maxPointsPerSecond) fast.push(r);
        }
      }
    }
    const summary = vps.map((v) => `${v.viewport}: ${v.calls.runStart} started, ${v.runs.filter((r) => r.ends > 0).length} ended`).join("; ");
    let status = "pass";
    let detail = summary + ".";
    let fixPrompt;
    if (doubles.length || bridgeDoubles.length) {
      status = "fail";
      detail += ` runEnd was called more than once for ${doubles.length || bridgeDoubles.length} run(s).`;
      fixPrompt =
        "runEnd is called more than once for the same run. Call DegenHive.runEnd({ score }) exactly once per run: guard it with a flag (for example `if (ended) return; ended = true;`) set when the run ends, and only start the next run with DegenHive.runStart() after that. Check every path that ends a run (game over, timer, quit, restart, tab hidden).";
    } else if (badScores.length) {
      status = "fail";
      detail += ` Invalid scores: ${badScores.slice(0, 5).join(", ")} (must be whole numbers from 0 to ${max}).`;
      fixPrompt = `Pass a whole number from 0 to ${max} to DegenHive.runEnd({ score }). Round the score with Math.floor and clamp it to scoring.maxScore from game.json.`;
    } else if (g.scored && ends.length === 0) {
      status = "warn";
      detail += " No run ended during the random-input run. A human should check that runs start and end.";
    } else if (fast.length) {
      status = "warn";
      detail += ` ${fast.length} run(s) scored faster than scoring.maxPointsPerSecond (${g.scoring.maxPointsPerSecond}).`;
    } else if (!g.scored && ends.length) {
      detail += " The game is not scored but reports runs.";
    }
    if (ends.length) {
      const scores = ends.flatMap((r) => r.scores).filter((s) => typeof s === "number");
      if (scores.length) detail += ` Scores: ${scores.slice(0, 8).join(", ")}${scores.length > 8 ? ", ..." : ""}.`;
    }
    items.push({ key: "sandbox.runs", label: "Runs and scores", status, detail, ...(fixPrompt ? { fixPrompt } : {}) });
  }

  // Errors
  {
    const errs = vps.flatMap((v) => [
      ...v.errors.map((e) => ({ ...e, viewport: v.viewport })),
      ...v.console.filter((c) => c.type === "error").map((c) => ({ kind: "console", message: c.text, source: c.url, line: c.line, viewport: v.viewport })),
    ]);
    const unique = [];
    const seen = new Set();
    for (const e of errs) {
      const k = e.message;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(e);
    }
    items.push({
      key: "sandbox.errors",
      label: "No script errors",
      status: unique.length ? "warn" : "pass",
      detail: unique.length
        ? `${unique.length} distinct error(s): ` + unique.slice(0, 5).map((e) => `${e.message}${e.source ? ` (${e.source.replace(/^https?:\/\/[^/]+/, "")}:${e.line})` : ""}`).join(" | ")
        : "No uncaught errors or console errors.",
      ...(unique.length ? { fixPrompt: `Fix these errors seen while the game ran: ${unique.slice(0, 5).map((e) => e.message).join(" | ")}` } : {}),
    });
  }

  // CSP
  {
    const all = [...vps.flatMap((v) => v.csp), ...(result.cspReports || [])];
    const unique = new Map();
    for (const v of all) if (!unique.has(cspKey(v))) unique.set(cspKey(v), v);
    const list = [...unique.values()];
    const serious = list.filter((v) => /^(script-src|connect-src|frame-src|form-action|base-uri|object-src)/.test(v.directive));
    items.push({
      key: "sandbox.csp",
      label: "Content policy",
      status: serious.length ? "fail" : list.length ? "warn" : "pass",
      detail: list.length
        ? `${list.length} blocked request(s): ` + list.slice(0, 6).map((v) => `${v.directive} blocked ${v.blocked || "inline"}`).join(" | ")
        : "Nothing was blocked.",
      ...(list.length
        ? {
            fixPrompt:
              "The game's content policy blocked these: " +
              list.slice(0, 6).map((v) => `${v.directive} ${v.blocked}`).join("; ") +
              ". Load every script, style, image, sound and font from the build with relative paths (binaries go in assets.json), connect only to your own origin or the https:// origins in game.json \"backends\", and do not use eval, frames, forms or <base>.",
          }
        : {}),
    });
  }

  // Network
  {
    const attempts = vps.flatMap((v) => v.network.map((n) => ({ ...n, viewport: v.viewport })));
    const undeclared = attempts.filter((n) => {
      try {
        const u = new URL(n.url);
        const origin = `${u.protocol === "wss:" ? "https:" : u.protocol}//${u.host}`;
        return !backends.includes(origin);
      } catch {
        return true;
      }
    });
    items.push({
      key: "sandbox.network",
      label: "No outside network",
      status: undeclared.length ? "fail" : "pass",
      detail: attempts.length
        ? `${attempts.length} request(s) to other origins (blocked in the sandbox): ` + [...new Set(attempts.map((n) => n.url.slice(0, 120)))].slice(0, 6).join(" | ")
        : "No requests left the game's origin.",
      ...(undeclared.length
        ? { fixPrompt: `The game tried to reach ${[...new Set(undeclared.map((n) => n.url.slice(0, 120)))].slice(0, 4).join(", ")}. Remove those requests, or declare the origin in game.json "backends" for human approval.` }
        : {}),
    });
  }

  // Performance
  {
    const heap = Math.max(...vps.map((v) => v.heapMb || 0));
    const fpsList = vps.filter((v) => v.fps !== null).map((v) => `${v.viewport} ${v.fps} fps`);
    const cpuList = vps.filter((v) => v.cpu !== null).map((v) => `${v.viewport} CPU ${Math.round(v.cpu * 100)}%`);
    const lowFps = vps.filter((v) => v.fps !== null && v.fps < 15);
    let status = "pass";
    if (heap > 512) status = "fail";
    else if (heap > 256 || lowFps.length) status = "warn";
    items.push({
      key: "sandbox.performance",
      label: "Memory and frame rate",
      status,
      detail: `JS heap peak ${heap ? heap + " MB" : "unknown"}${fpsList.length ? ", " + fpsList.join(", ") : ""}${cpuList.length ? ", " + cpuList.join(", ") : ""}. Headless runners draw without a GPU, so frame rates here are lower than on a phone.`,
      ...(status !== "pass"
        ? { fixPrompt: "Reduce memory use and per-frame work: reuse objects instead of allocating each frame, cap particle counts, unload unused textures and audio, and keep the JS heap under 256 MB." }
        : {}),
    });
  }

  if (result.missingLibs && result.missingLibs.length) {
    items.push({
      key: "sandbox.libraries",
      label: "Libraries in the sandbox",
      status: "warn",
      detail: `Ran without ${result.missingLibs.length} pinned library file(s): ${result.missingLibs.slice(0, 4).join(", ")}.`,
    });
  }
  if (result.missingAssets && result.missingAssets.length) {
    items.push({
      key: "sandbox.assets",
      label: "Assets in the sandbox",
      status: "warn",
      detail: `Ran without ${result.missingAssets.length} asset(s) that were not available locally: ${result.missingAssets.slice(0, 5).join(", ")}.`,
    });
  }
  return items;
}
