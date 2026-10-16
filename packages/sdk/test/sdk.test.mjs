import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, connected, until, quiet, plain, defaultHandlers, SESSION, VERSION } from "./harness.mjs";

const cleanup = (t, env) => t.after(() => env.close());

describe("handshake", () => {
  test("calls made before hello queue, go out in order after hello.ack, and resolve", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    const sdk = env.sdk;

    // Nothing has said hello yet.
    const session = sdk.session();
    const save = sdk.save.get();
    sdk.ready();
    sdk.track("level_start", { level: 1 });
    const start = sdk.runStart();

    const host = env.hello();
    await until(() => host.msgs.length >= 5, "five queued messages");

    assert.deepEqual(plain(host.received[0]), { v: 1, type: "hello.ack", sdk: VERSION });
    assert.deepEqual(
      host.msgs.map((m) => m.type),
      ["session.get", "save.get", "ready", "track", "run.start"],
    );
    const ids = host.msgs.filter((m) => m.id).map((m) => m.id);
    assert.equal(new Set(ids).size, 3);
    assert.ok(host.msgs.every((m) => m.v === 1));
    assert.deepEqual(plain(host.ofType("track")[0].payload), { name: "level_start", props: { level: 1 } });

    assert.deepEqual(plain(await session), SESSION);
    assert.equal(await save, null);
    assert.deepEqual(plain(await start), { runId: "run-1", seed: 42 });
  });

  test("calls after the handshake use the same port and the session is cached", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    const [a, b] = await Promise.all([sdk.session(), sdk.session()]); // one request, shared
    assert.deepEqual(plain(a), SESSION);
    assert.deepEqual(plain(b), SESSION);
    await sdk.session(); // cached
    assert.equal(host.ofType("session.get").length, 1);

    await sdk.save.set("hello");
    assert.equal(await sdk.save.get(), "hello");
    assert.deepEqual(plain(host.ofType("save.set")[0].payload), { data: "hello" });
  });

  test("the timer starts at window load, so a slow-loading game still gets its hello", async (t) => {
    const env = makeEnv({ readyState: "loading" });
    cleanup(t, env);
    const p = env.sdk.session();
    env.clock.advance(15000); // load has not finished: no countdown yet, and no request timeout either
    env.window.document.readyState = "complete";
    env.fireWindow("load", {});
    env.clock.advance(1000);
    const host = env.hello();
    await until(() => host.acked, "hello.ack");
    assert.equal((await p).mode, "points");
    assert.equal(env.logs.info.length, 0);
  });

  test("hello after local mode has started is ignored", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    env.clock.advance(1500);
    const host = env.hello();
    await quiet();
    assert.equal(host.received.length, 0);
    assert.equal((await env.sdk.session()).mode, "local");
  });

  test("a second hello after the first is ignored", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    const second = env.hello();
    await quiet();
    assert.equal(second.received.length, 0);
    await sdk.session();
    assert.equal(host.ofType("session.get").length, 1);
    assert.equal(second.received.length, 0);
  });
});

describe("host allowlist", () => {
  const good = ["https://degenhive.ai", "https://www.degenhive.ai", "http://localhost:3000", "http://localhost:3300"];
  for (const origin of good) {
    test("accepts " + origin, async (t) => {
      const env = makeEnv();
      cleanup(t, env);
      const host = env.hello({ origin });
      await until(() => host.acked, "hello.ack");
    });
  }

  const bad = [
    "https://evil.example",
    "https://degenhive.ai.evil.example",
    "https://evildegenhive.ai",
    "http://degenhive.ai",
    "https://sub.degenhive.ai",
    "https://degenhive.ai/",
    "https://degenhive.ai:444",
    "http://localhost:5173", // not on the built-in list and the game is not on *.localhost
    "http://localhost:3000.evil.example",
    null,
    undefined,
    42,
  ];
  for (const origin of bad) {
    test("rejects " + String(origin), async (t) => {
      const env = makeEnv();
      cleanup(t, env);
      const host = env.hello({ origin });
      await quiet();
      assert.equal(host.received.length, 0, "no ack for a bad host");
      env.clock.advance(1500);
      assert.equal((await env.sdk.session()).mode, "local");
    });
  }

  test("rejects a hello whose browser-set origin differs from the claimed one", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    const host = env.hello({ origin: "https://degenhive.ai", eventOrigin: "https://evil.example" });
    await quiet();
    assert.equal(host.received.length, 0);
  });

  test("rejects a hello that does not come from window.parent", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    const host = env.hello({ source: { name: "some other window" } });
    await quiet();
    assert.equal(host.received.length, 0);
  });

  test("rejects a hello with another protocol version or no port", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    const a = env.hello({ v: 2 });
    const b = env.hello({ noPort: true });
    await quiet();
    assert.equal(a.received.length, 0);
    assert.equal(b.received.length, 0);
    // A good hello still works afterwards.
    const c = env.hello();
    await until(() => c.acked, "hello.ack");
  });

  test("any http://localhost:<port> is accepted only when the game runs on *.localhost", async (t) => {
    const dev = makeEnv({ hostname: "hive-runner.localhost" });
    cleanup(t, dev);
    const host = dev.hello({ origin: "http://localhost:5173" });
    await until(() => host.acked, "hello.ack on a dev host");

    for (const origin of ["http://localhost.evil.example:5173", "https://localhost:5173", "http://localhost", "http://localhost:5173/x"]) {
      const env = makeEnv({ hostname: "hive-runner.localhost" });
      cleanup(t, env);
      const h = env.hello({ origin });
      await quiet();
      assert.equal(h.received.length, 0, origin);
    }

    // game.localhost.evil.example and plain "localhost" are not *.localhost
    for (const hostname of ["game.localhost.evil.example", "localhost", "notlocalhost"]) {
      const env = makeEnv({ hostname });
      cleanup(t, env);
      const h = env.hello({ origin: "http://localhost:5173" });
      await quiet();
      assert.equal(h.received.length, 0, hostname);
    }
  });
});

describe("local mode", () => {
  test("falls back after 1500 ms with no hello and answers queued calls", async (t) => {
    const env = makeEnv();
    cleanup(t, env);
    const sdk = env.sdk;
    let settled = false;
    const session = sdk.session().then((s) => ((settled = true), s));
    const start = sdk.runStart();

    env.clock.advance(1499);
    await quiet();
    assert.equal(settled, false, "still waiting at 1499 ms");
    assert.equal(env.logs.info.length, 0);

    env.clock.advance(1);
    const s = await session;
    assert.equal(s.mode, "local");
    assert.equal(s.player.signedIn, false);
    assert.equal(s.lab, null);
    assert.equal(s.locale, "en-GB");
    assert.equal(env.logs.info.length, 1);

    const { runId, seed } = await start;
    assert.match(runId, /^local-\d+$/);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32);
  });

  test("not in a frame: local at once, no waiting", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    assert.equal((await env.sdk.session()).mode, "local");
    assert.equal(env.clock.now, 0);
  });

  test("runEnd logs and resolves { accepted, counted: false, best }", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    const sdk = env.sdk;
    await sdk.runStart();
    assert.deepEqual(plain(await sdk.runEnd({ score: 10 })), { accepted: true, counted: false, best: 10 });
    assert.equal(env.logs.log.length, 1);
    await sdk.runStart();
    assert.deepEqual(plain(await sdk.runEnd({ score: 4 })), { accepted: true, counted: false, best: 10 });
    await sdk.runStart();
    assert.equal((await sdk.runEnd({ score: 25 })).best, 25);
  });

  test("save uses localStorage", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    assert.equal(await env.sdk.save.get(), null);
    await env.sdk.save.set('{"lvl":3}');
    assert.equal(env.storage.get("dh:save"), '{"lvl":3}');
    assert.equal(await env.sdk.save.get(), '{"lvl":3}');
    await assert.rejects(env.sdk.save.set("x".repeat(60 * 1024 + 1)), { code: "too_large" }); // same limit as with a host
  });

  test("save falls back to memory when localStorage throws", async (t) => {
    const env = makeEnv({
      framed: false,
      beforeLoad: (e) => {
        e.window.localStorage = {
          getItem: () => {
            throw new Error("denied");
          },
          setItem: () => {
            throw new Error("denied");
          },
        };
      },
    });
    cleanup(t, env);
    await env.sdk.save.set("abc");
    assert.equal(await env.sdk.save.get(), "abc");
  });

  test("track and ready send nothing and do not throw", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    env.sdk.ready();
    env.sdk.track("level_start");
    env.sdk.track("custom", { a: "b" });
    assert.equal(env.logs.warn.length, 0);
  });

  test("openLink opens a tab", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    assert.equal(await env.sdk.openLink("https://example.org/a b"), true);
    assert.equal(env.opened[0][0], "https://example.org/a%20b");
  });

  test("pause and resume follow tab visibility", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    const seen = [];
    env.sdk.on("pause", () => seen.push("pause"));
    env.sdk.on("resume", () => seen.push("resume"));
    env.setVisibility("hidden");
    env.setVisibility("visible");
    assert.deepEqual(seen, ["pause", "resume"]);
  });

  test("warns when ready() is not called within 10 s of load", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    env.clock.advance(10000);
    assert.ok(env.logs.warn.some((m) => /ready\(\) was not called/.test(m)));

    const env2 = makeEnv({ framed: false });
    cleanup(t, env2);
    env2.sdk.ready();
    env2.clock.advance(10000);
    assert.equal(env2.logs.warn.length, 0);
  });
});

describe("runs", () => {
  test("runStart / runEnd send the run id, score and duration", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    const { runId, seed } = await sdk.runStart();
    assert.deepEqual([runId, seed], ["run-1", 42]);
    env.clock.advance(3000);
    const result = await sdk.runEnd({ score: 120 });
    assert.deepEqual(plain(result), { accepted: true, counted: true, best: 120 });
    assert.deepEqual(plain(host.ofType("run.end")[0].payload), { runId: "run-1", score: 120, durationMs: 3000 });
  });

  test("runEnd twice for the same run rejects with run_unknown without sending", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await sdk.runStart();
    await sdk.runEnd({ score: 5 });
    await assert.rejects(sdk.runEnd({ score: 5 }), { code: "run_unknown" });
    await quiet();
    assert.equal(host.ofType("run.end").length, 1);
    assert.ok(env.logs.warn.some((m) => m.includes("runEnd was already called for this run")));
  });

  test("two runEnd calls in the same tick: one goes out", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await sdk.runStart();
    const first = sdk.runEnd({ score: 1 });
    const second = sdk.runEnd({ score: 2 });
    await assert.rejects(second, { code: "run_unknown" });
    assert.equal((await first).accepted, true);
    assert.equal(host.ofType("run.end").length, 1);
    assert.equal(host.ofType("run.end")[0].payload.score, 1);
  });

  test("a new runStart allows a new runEnd", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await sdk.runStart();
    await sdk.runEnd({ score: 1 });
    await sdk.runStart();
    await sdk.runEnd({ score: 2 });
    assert.deepEqual(
      host.ofType("run.end").map((m) => m.payload.runId),
      ["run-1", "run-2"],
    );
  });

  test("runEnd without runStart rejects with run_unknown without sending", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await assert.rejects(sdk.runEnd({ score: 1 }), { code: "run_unknown" });
    await quiet();
    assert.equal(host.ofType("run.end").length, 0);
  });

  test("the guard also works in local mode", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    await env.sdk.runStart();
    await env.sdk.runEnd({ score: 1 });
    await assert.rejects(env.sdk.runEnd({ score: 1 }), { code: "run_unknown" });
  });

  test("runEnd can be called before the runStart promise is awaited", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    sdk.runStart(); // not awaited
    const r = await sdk.runEnd({ score: 7 });
    assert.equal(r.best, 7);
    assert.equal(host.ofType("run.end")[0].payload.runId, "run-1");
  });

  test("score must be a whole number from 0 to 1,000,000", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await sdk.runStart();
    for (const score of [1.5, -1, 1000001, NaN, Infinity, "5", null, undefined, {}]) {
      await assert.rejects(sdk.runEnd({ score }), { code: "bad_request" }, String(score));
    }
    await assert.rejects(sdk.runEnd(undefined), { code: "bad_request" });
    await assert.rejects(sdk.runEnd({ score: 1, log: 5 }), { code: "bad_request" });
    await quiet();
    assert.equal(host.ofType("run.end").length, 0, "bad scores never reach the host");
    // The run is still open: valid scores at the edges are fine.
    assert.equal((await sdk.runEnd({ score: 0 })).accepted, true);
    await sdk.runStart();
    assert.equal((await sdk.runEnd({ score: 1000000 })).accepted, true);
  });

  test("a run.end that times out can be retried; one the host answered cannot", async (t) => {
    const handlers = defaultHandlers();
    let answer = false;
    const base = handlers["run.end"];
    handlers["run.end"] = (p, m) => (answer ? base(p, m) : undefined);
    const { env, host, sdk } = await connected({ handlers });
    cleanup(t, env);
    await sdk.runStart();
    const lost = sdk.runEnd({ score: 9 });
    await until(() => host.ofType("run.end").length === 1, "first run.end");
    env.clock.advance(10000);
    await assert.rejects(lost, { code: "unavailable" });
    answer = true;
    assert.equal((await sdk.runEnd({ score: 9 })).accepted, true);
    assert.equal(host.ofType("run.end").length, 2);
    await assert.rejects(sdk.runEnd({ score: 9 }), { code: "run_unknown" });
  });

  test("errors from the host keep their code and message", async (t) => {
    const handlers = defaultHandlers();
    const { env, host, sdk } = await connected({ handlers });
    cleanup(t, env);
    host.handlers["run.end"] = (p, m) => void host.fail(m.id, "run_rejected", "score grew too fast");
    await sdk.runStart();
    await assert.rejects(sdk.runEnd({ score: 999 }), { code: "run_rejected", message: "score grew too fast" });
  });

  test("a malformed run.start reply rejects with unavailable", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    host.handlers["run.start"] = () => ({ nope: true });
    await assert.rejects(sdk.runStart(), { code: "unavailable" });
  });
});

describe("requests", () => {
  test("a request with no answer rejects with unavailable after 10 s", async (t) => {
    const { env, host, sdk } = await connected({ handlers: null });
    cleanup(t, env);
    let result;
    const p = sdk.session().then(
      () => (result = "resolved"),
      (e) => (result = e),
    );
    await until(() => host.ofType("session.get").length === 1, "session.get");
    env.clock.advance(9999);
    await quiet();
    assert.equal(result, undefined, "not yet at 9.999 s");
    env.clock.advance(1);
    await p;
    assert.equal(result.code, "unavailable");

    // A late answer is ignored and the next call works.
    host.reply(host.ofType("session.get")[0].id, SESSION);
    await quiet();
    host.handlers = defaultHandlers();
    assert.equal((await sdk.session()).mode, "points");
  });

  test("replies are matched by id, out of order", async (t) => {
    const { env, host, sdk } = await connected({ handlers: null });
    cleanup(t, env);
    const a = sdk.save.get();
    const b = sdk.session();
    await until(() => host.msgs.length === 2, "two requests");
    const [reqA, reqB] = host.msgs;
    host.reply(reqB.id, SESSION);
    host.reply(reqA.id, { data: "saved" });
    assert.equal(await a, "saved");
    assert.equal((await b).player.name, "Ada");
  });

  test("an error without a code becomes unavailable", async (t) => {
    const { env, host, sdk } = await connected({ handlers: null });
    cleanup(t, env);
    const p = sdk.save.get();
    await until(() => host.msgs.length === 1, "save.get");
    host.send({ re: host.msgs[0].id, ok: false, error: {} });
    await assert.rejects(p, { code: "unavailable" });
  });

  test("messages that break the size limits reject with too_large and are not sent", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await assert.rejects(sdk.save.set("x".repeat(70000)), { code: "too_large" });
    await assert.rejects(sdk.save.set("€".repeat(30000)), { code: "too_large" }); // 90,000 bytes
    await assert.rejects(sdk.save.set("x".repeat(65536)), { code: "too_large" }); // the envelope makes it just over
    await assert.rejects(sdk.save.set("x".repeat(60 * 1024 + 1)), { code: "too_large" }); // a save is at most 60 KB
    await sdk.save.set("x".repeat(60 * 1024));
    await sdk.runStart();
    await assert.rejects(sdk.runEnd({ score: 1, log: "x".repeat(300 * 1024) }), { code: "too_large" });
    await sdk.runEnd({ score: 1, log: "x".repeat(200 * 1024) }); // a log gets 256 KB
    assert.equal(host.ofType("save.set").length, 1);
    assert.equal(host.ofType("run.end").length, 1);
    assert.equal(host.ofType("run.end")[0].payload.log.length, 200 * 1024);
  });

  test("link.open waits for a person: no 10 s timeout, 10 minutes at most", async (t) => {
    const { env, host, sdk } = await connected({ handlers: null });
    cleanup(t, env);
    let result;
    const settle = (p) =>
      p.then(
        (v) => (result = v),
        (e) => (result = e.code),
      );

    // The player takes a minute to answer the confirm sheet.
    const a = settle(sdk.openLink("https://example.org"));
    await until(() => host.ofType("link.open").length === 1, "link.open");
    env.clock.advance(10000);
    env.clock.advance(50000);
    await quiet();
    assert.equal(result, undefined, "still waiting after 60 s");
    host.reply(host.ofType("link.open")[0].id, { opened: true });
    await a;
    assert.equal(result, true);

    // Nobody answers: it gives up at 10 minutes.
    result = undefined;
    const b = settle(sdk.openLink("https://example.org/two"));
    await until(() => host.ofType("link.open").length === 2, "second link.open");
    env.clock.advance(599999);
    await quiet();
    assert.equal(result, undefined, "not yet at 9 min 59.999 s");
    env.clock.advance(1);
    await b;
    assert.equal(result, "unavailable");

    // Everything else still times out at 10 s.
    result = undefined;
    const c = settle(sdk.save.get());
    await until(() => host.ofType("save.get").length === 1, "save.get");
    env.clock.advance(10000);
    await c;
    assert.equal(result, "unavailable");
  });

  test("bad arguments reject with bad_request", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    await assert.rejects(sdk.save.set(123), { code: "bad_request" });
    await assert.rejects(sdk.save.set(undefined), { code: "bad_request" });
    for (const url of ["javascript:alert(1)", "ftp://example.org", "/relative", "", undefined, "data:text/html,hi"]) {
      await assert.rejects(sdk.openLink(url), { code: "bad_request" }, String(url));
    }
    await quiet();
    assert.equal(host.msgs.length, 0);
  });

  test("openLink resolves what the host says", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    assert.equal(await sdk.openLink("https://example.org"), true);
    assert.deepEqual(plain(host.ofType("link.open")[0].payload), { url: "https://example.org/" });
    host.handlers["link.open"] = () => ({ opened: false });
    assert.equal(await sdk.openLink("https://example.org"), false);
  });
});

describe("rate limit and queue", () => {
  test("at most 20 messages leave per second; the rest wait and follow", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    for (let i = 0; i < 45; i++) sdk.track("custom", { i });
    await until(() => host.msgs.length >= 20, "first 20");
    await quiet();
    assert.equal(host.msgs.length, 20, "only 20 in the first second");

    let seen = 20;
    for (let step = 0; step < 5 && seen < 45; step++) {
      env.clock.advance(1100);
      await quiet();
      const now = host.msgs.length;
      assert.ok(now - seen <= 20, "no burst over 20");
      seen = now;
    }
    assert.equal(host.msgs.length, 45, "nothing was lost");
    assert.deepEqual(
      host.msgs.map((m) => m.payload.props.i),
      Array.from({ length: 45 }, (_, i) => i),
      "in order",
    );
  });

  test("when the queue overflows, track events are dropped first and requests survive", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    for (let i = 0; i < 250; i++) sdk.track("custom", { i });
    const session = sdk.session();
    const save = sdk.save.get();
    for (let step = 0; step < 12; step++) {
      env.clock.advance(1100);
      await quiet();
    }
    assert.equal((await session).mode, "points");
    assert.equal(await save, null);
    const tracks = host.ofType("track");
    assert.ok(tracks.length <= 20 + 100, "bounded: " + tracks.length);
    assert.ok(tracks.length >= 100);
    assert.ok(tracks.at(-1).payload.props.i === 249, "the newest events are kept");
    assert.ok(!env.logs.warn.some((m) => /dropped/.test(m)), "dropping track events is silent");
  });

  test("when the queue is full of requests, the next one rejects with rate_limited", async (t) => {
    const { env, sdk } = await connected({ handlers: null });
    cleanup(t, env);
    const outcome = [];
    for (let i = 0; i < 130; i++) {
      sdk.save.get().then(
        () => (outcome[i] = "ok"),
        (e) => (outcome[i] = e.code),
      );
    }
    await quiet();
    // 20 went out, 100 wait, 10 are refused at once and nothing is dropped silently.
    assert.equal(outcome.filter((r) => r === "rate_limited").length, 10);
    assert.equal(outcome.slice(0, 120).filter((r) => r !== undefined).length, 0);
  });
});

describe("host events", () => {
  test("pause, resume, mute, sessionChanged and sessionEnding reach on() listeners", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    const seen = [];
    sdk.on("pause", (p) => seen.push(["pause", p]));
    sdk.on("resume", (p) => seen.push(["resume", p]));
    sdk.on("mute", (p) => seen.push(["mute", p]));
    sdk.on("sessionChanged", (p) => seen.push(["sessionChanged", p.mode]));
    sdk.on("sessionEnding", (p) => seen.push(["sessionEnding", p.secondsLeft]));

    host.send({ type: "pause", payload: {} });
    host.send({ type: "resume", payload: {} });
    host.send({ type: "mute", payload: { muted: true } });
    host.send({ type: "session.changed", payload: { ...SESSION, mode: "practice" } });
    host.send({ type: "session.ending", payload: { secondsLeft: 30 } });
    host.send({ type: "something.new", payload: {} }); // unknown: ignored
    await until(() => seen.length === 5, "five events");
    assert.deepEqual(plain(seen), [
      ["pause", {}],
      ["resume", {}],
      ["mute", { muted: true }],
      ["sessionChanged", "practice"],
      ["sessionEnding", 30],
    ]);
  });

  test("the cached session follows session.changed and mute", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    assert.equal((await sdk.session()).mode, "points");
    host.send({ type: "mute", payload: { muted: true } });
    await quiet();
    assert.equal((await sdk.session()).muted, true);
    host.send({ type: "session.changed", payload: { ...SESSION, mode: "practice" } });
    await quiet();
    assert.equal((await sdk.session()).mode, "practice");
    assert.equal(host.ofType("session.get").length, 1);
  });

  test("on() returns an unsubscribe function; a throwing listener does not stop the others", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    const seen = [];
    const off = sdk.on("pause", () => seen.push("a"));
    sdk.on("pause", () => {
      throw new Error("listener bug");
    });
    sdk.on("pause", () => seen.push("c"));
    host.send({ type: "pause", payload: {} });
    await until(() => seen.length === 2, "two listeners");
    assert.deepEqual(seen, ["a", "c"]);
    assert.equal(env.logs.error.length, 1);
    off();
    off(); // twice is fine
    host.send({ type: "pause", payload: {} });
    await until(() => seen.length === 3, "one more");
    assert.deepEqual(seen, ["a", "c", "c"]);
  });

  test("on() rejects unknown event names and non-functions", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    assert.throws(() => env.sdk.on("paused", () => {}), { name: "TypeError" });
    assert.throws(() => env.sdk.on("pause", "nope"), { name: "TypeError" });
  });

  test("garbage on the port is ignored", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    host.send({ v: 2, type: "pause" });
    host.send({ type: "pause", v: 1, payload: "not an object" });
    host.send({ re: "nobody-asked", ok: true });
    await quiet();
    assert.equal((await sdk.session()).mode, "points");
  });
});

describe("heartbeat and errors", () => {
  test("a heartbeat every 30 s while the tab is visible", async (t) => {
    const { env, host } = await connected();
    cleanup(t, env);
    env.clock.advance(29999);
    await quiet();
    assert.equal(host.ofType("heartbeat").length, 0);
    env.clock.advance(1);
    await until(() => host.ofType("heartbeat").length === 1, "first heartbeat");
    assert.deepEqual(plain(host.ofType("heartbeat")[0].payload), { visible: true }, "no rAF: no fps");

    env.setVisibility("hidden");
    env.clock.advance(60000);
    await quiet();
    assert.equal(host.ofType("heartbeat").length, 1, "none while hidden");

    env.setVisibility("visible");
    env.clock.advance(30000);
    await until(() => host.ofType("heartbeat").length === 2, "heartbeat after the tab is back");
  });

  test("heartbeat carries an fps estimate from requestAnimationFrame", async (t) => {
    const { env, host } = await connected({ raf: true });
    cleanup(t, env);
    env.clock.advance(30000);
    env.clock.advance(1000);
    await until(() => host.ofType("heartbeat").length === 1, "heartbeat");
    const { visible, fps } = host.ofType("heartbeat")[0].payload;
    assert.equal(visible, true);
    assert.ok(fps >= 55 && fps <= 70, "fps " + fps); // the fake rAF runs every 16 ms
  });

  test("window errors are sent once each, with source and line", async (t) => {
    const { env, host } = await connected();
    cleanup(t, env);
    env.fireWindow("error", { message: "boom", filename: "https://g.example/a.js", lineno: 7 });
    env.fireWindow("error", { message: "boom", filename: "https://g.example/a.js", lineno: 7 }); // duplicate
    env.fireWindow("error", { message: "inline", filename: "", lineno: 0 });
    await until(() => host.ofType("error").length === 2, "two error events");
    await quiet();
    assert.deepEqual(plain(host.ofType("error").map((m) => m.payload)), [
      { message: "boom", source: "https://g.example/a.js", line: 7 },
      { message: "inline" },
    ]);
  });

  test("unhandled rejections are reported", async (t) => {
    const { env, host } = await connected();
    cleanup(t, env);
    env.fireWindow("unhandledrejection", { reason: new Error("lost promise") });
    env.fireWindow("unhandledrejection", { reason: "plain string" });
    await until(() => host.ofType("error").length === 2, "two error events");
    assert.deepEqual(
      host.ofType("error").map((m) => m.payload.message),
      ["lost promise", "plain string"],
    );
  });

  test("at most 20 distinct errors per session; long messages are cut", async (t) => {
    const { env, host } = await connected();
    cleanup(t, env);
    for (let i = 0; i < 40; i++) env.fireWindow("error", { message: "error " + i, filename: "", lineno: 0 });
    env.fireWindow("error", { message: "late", filename: "", lineno: 0 });
    for (let step = 0; step < 4; step++) {
      env.clock.advance(1100);
      await quiet();
    }
    assert.equal(host.ofType("error").length, 20);

    const env2 = await connected();
    cleanup(t, env2.env);
    env2.env.fireWindow("error", { message: "y".repeat(5000), filename: "", lineno: 0 });
    await until(() => env2.host.ofType("error").length === 1, "long error");
    assert.equal(env2.host.ofType("error")[0].payload.message.length, 500);
  });

  test("errors are not sent in local mode", async (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    env.fireWindow("error", { message: "boom", filename: "", lineno: 0 });
    assert.equal(env.logs.warn.length, 0);
  });
});

describe("ready and track", () => {
  test("ready() sends one ready event, however often it is called", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    sdk.ready();
    sdk.ready();
    await until(() => host.ofType("ready").length >= 1, "ready");
    await quiet();
    assert.equal(host.ofType("ready").length, 1);
    assert.deepEqual(plain(host.ofType("ready")[0]), { v: 1, type: "ready", payload: {} });
  });

  test("sends the name and props", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    sdk.track("level_complete", { level: 3, perfect: true, mode: "hard" });
    sdk.track("gameplay_start");
    await until(() => host.ofType("track").length === 2, "two tracks");
    assert.deepEqual(plain(host.ofType("track").map((m) => m.payload)), [
      { name: "level_complete", props: { level: 3, perfect: true, mode: "hard" } },
      { name: "gameplay_start" },
    ]);
  });

  test("unknown names and bad props are dropped with a warning", async (t) => {
    const { env, host, sdk } = await connected();
    cleanup(t, env);
    sdk.track("not_a_name");
    sdk.track("custom", { nested: { a: 1 } });
    sdk.track("custom", { n: NaN });
    sdk.track("custom", [1, 2]);
    sdk.track("custom", null);
    await quiet();
    assert.equal(host.ofType("track").length, 0);
    assert.equal(env.logs.warn.length, 5);
  });
});

describe("random", () => {
  // First five values per seed. These are the reference mulberry32 sequence; if they change,
  // every game that replays a seed changes with them.
  const known = {
    1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849],
    42: [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423],
    123456789: [0.2577907438389957, 0.9707721115555614, 0.7853280142880976, 0.20616457983851433, 0.30307188746519387],
    4294967295: [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489],
  };

  test("same seed, same first five values (documented)", (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    for (const [seed, expected] of Object.entries(known)) {
      const r = env.sdk.random(Number(seed));
      assert.deepEqual([r(), r(), r(), r(), r()], expected, "seed " + seed);
    }
  });

  test("two instances, and two environments, agree", (t) => {
    const a = makeEnv({ framed: false });
    const b = makeEnv({ framed: false });
    cleanup(t, a);
    cleanup(t, b);
    const x = a.sdk.random(7);
    const y = a.sdk.random(7);
    const z = b.sdk.random(7);
    for (let i = 0; i < 1000; i++) {
      const v = x();
      assert.equal(v, y());
      assert.equal(v, z());
    }
  });

  test("values are in [0, 1) and different seeds differ", (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    const r = env.sdk.random(99);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 100000; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    assert.ok(min < 0.001 && max > 0.999, "covers the range");
    assert.notEqual(env.sdk.random(1)(), env.sdk.random(2)());
  });

  test("a seed from the host works as is; bad seeds throw", (t) => {
    const env = makeEnv({ framed: false });
    cleanup(t, env);
    assert.equal(env.sdk.random(1.9)(), env.sdk.random(1)(), "fractions are truncated");
    for (const bad of ["1", NaN, Infinity, undefined, null]) assert.throws(() => env.sdk.random(bad), { name: "TypeError" });
  });
});

describe("the global", () => {
  test("window.DegenHive is set, version matches package.json, degenhive:ready fires once", (t) => {
    let fired = 0;
    let detail;
    const env = makeEnv({
      framed: false,
      beforeLoad: (e) =>
        e.window.addEventListener("degenhive:ready", (ev) => {
          fired++;
          detail = ev.detail;
        }),
    });
    cleanup(t, env);
    assert.equal(fired, 1);
    assert.equal(detail, env.sdk);
    assert.equal(env.sdk.version, VERSION);
    assert.equal(VERSION, "1.0.0");
    assert.deepEqual(Object.keys(env.sdk).sort(), ["ready", "on", "openLink", "random", "runEnd", "runStart", "save", "session", "track", "version"].sort());
    assert.deepEqual(Object.keys(env.sdk.save).sort(), ["get", "set"]);

    // A second copy of the script reuses the first one.
    const first = env.sdk;
    env.load();
    assert.equal(env.sdk, first);
    assert.equal(fired, 1);
  });
});
