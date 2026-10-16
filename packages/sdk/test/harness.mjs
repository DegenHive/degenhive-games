// Runs the built dist/sdk.js in a vm context with a fake browser and a fake host page.
// Time is fake (Clock); MessageChannel is the real Node one, so message delivery needs
// a real event-loop turn: use until() / quiet() after anything that posts a message.
import vm from "node:vm";
import { readFileSync } from "node:fs";

export const SOURCE = readFileSync(new URL("../dist/sdk.js", import.meta.url), "utf8");
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until cond() is truthy (real time, polling). */
export async function until(cond, what = "condition", ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setImmediate(r));
  }
}

/** Let pending messages and promise reactions land, for "nothing happened" checks. */
export const quiet = () => sleep(20);

/** Plain-object copy, so assert.deepStrictEqual does not trip on vm-realm prototypes. */
export const plain = (x) => JSON.parse(JSON.stringify(x));

export class Clock {
  now = 0;
  #id = 0;
  #timers = new Map();
  setTimeout = (fn, ms = 0) => this.#add(fn, ms, 0);
  setInterval = (fn, ms = 0) => this.#add(fn, ms, ms);
  clearTimeout = (id) => void this.#timers.delete(id);
  clearInterval = (id) => void this.#timers.delete(id);
  get pendingTimers() {
    return this.#timers.size;
  }
  #add(fn, ms, every) {
    const id = ++this.#id;
    this.#timers.set(id, { fn, at: this.now + Math.max(0, ms), every });
    return id;
  }
  /** Move time forward, running every timer that comes due, in order. */
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of this.#timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      this.now = Math.max(this.now, next.t.at);
      if (next.t.every) next.t.at = this.now + next.t.every;
      else this.#timers.delete(next.id);
      next.t.fn();
    }
    this.now = end;
  }
}

/**
 * Build a fake browser, load the SDK into it.
 * opts: framed, hostname, readyState, visibility, raf, beforeLoad(env)
 */
export function makeEnv(opts = {}) {
  const { framed = true, hostname = "game.example", readyState = "complete", visibility = "visible", raf = false } = opts;
  const clock = new Clock();
  const winET = new EventTarget();
  const docET = new EventTarget();
  const logs = { warn: [], info: [], log: [], error: [] };
  const storage = new Map();
  const opened = [];
  const channels = [];
  const parent = { name: "host window" };
  const fmt = (a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

  const sandbox = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    performance: { now: () => clock.now },
    console: {
      warn: (...a) => logs.warn.push(fmt(a)),
      info: (...a) => logs.info.push(fmt(a)),
      log: (...a) => logs.log.push(fmt(a)),
      error: (...a) => logs.error.push(fmt(a)),
    },
    TextEncoder,
    URL,
    CustomEvent,
    location: { hostname },
    navigator: { language: "en-GB" },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => void storage.set(k, String(v)),
    },
    document: {
      readyState,
      visibilityState: visibility,
      addEventListener: (...a) => docET.addEventListener(...a),
      removeEventListener: (...a) => docET.removeEventListener(...a),
    },
    addEventListener: (...a) => winET.addEventListener(...a),
    removeEventListener: (...a) => winET.removeEventListener(...a),
    dispatchEvent: (e) => winET.dispatchEvent(e),
    open: (...a) => void opened.push(a),
  };
  sandbox.window = sandbox;
  sandbox.parent = framed ? parent : sandbox;
  if (raf) sandbox.requestAnimationFrame = (cb) => clock.setTimeout(() => cb(clock.now), 16);
  const ctx = vm.createContext(sandbox);

  const env = {
    clock,
    logs,
    opened,
    storage,
    parent,
    window: sandbox,
    get sdk() {
      return sandbox.DegenHive;
    },
    load() {
      vm.runInContext(SOURCE, ctx);
    },
    setVisibility(v) {
      sandbox.document.visibilityState = v;
      docET.dispatchEvent(new Event("visibilitychange"));
    },
    fireWindow(type, props) {
      winET.dispatchEvent(Object.assign(new Event(type), props));
    },
    /**
     * Play the host side of the handshake. Returns the host object.
     * origin: the host origin claimed in the hello (default degenhive.ai)
     * Overrides: eventOrigin, source, v, noPort, handlers
     */
    hello(o = {}) {
      const host = makeHost(o.handlers);
      const origin = "origin" in o ? o.origin : "https://degenhive.ai";
      const data = { dh: "hello", v: "v" in o ? o.v : 1, origin };
      const ports = o.noPort ? [] : [host.port2];
      env.fireWindow("message", {
        data,
        source: "source" in o ? o.source : parent,
        origin: "eventOrigin" in o ? o.eventOrigin : origin,
        ports,
      });
      return host;
    },
  };

  function makeHost(handlers = defaultHandlers()) {
    const ch = new MessageChannel();
    channels.push(ch);
    const host = {
      port2: ch.port2,
      received: [],
      handlers,
      /** Messages from the SDK other than the hello.ack. */
      get msgs() {
        return host.received.filter((m) => m.type !== "hello.ack");
      },
      ofType: (type) => host.received.filter((m) => m.type === type),
      get acked() {
        return host.received.some((m) => m.type === "hello.ack");
      },
      send: (msg) => ch.port1.postMessage({ v: 1, ...msg }),
      reply: (re, payload = {}) => ch.port1.postMessage({ v: 1, re, ok: true, payload }),
      fail: (re, code, message = code) => ch.port1.postMessage({ v: 1, re, ok: false, error: { code, message } }),
    };
    ch.port1.onmessage = (e) => {
      const m = e.data;
      host.received.push(m);
      const h = m.id && host.handlers && host.handlers[m.type];
      if (h) {
        const out = h(m.payload, m);
        if (out !== undefined) host.reply(m.id, out);
      }
    };
    return host;
  }

  env.close = () => {
    for (const ch of channels) {
      ch.port1.close();
      ch.port2.close();
    }
  };
  if (opts.beforeLoad) opts.beforeLoad(env);
  env.load();
  return env;
}

export const SESSION = {
  mode: "points",
  player: { name: "Ada", avatar: null, signedIn: true },
  lab: { id: "lab-1", name: "Honey Lab" },
  muted: false,
  locale: "en-US",
};

/** A host that answers every request the way the real one would on success. */
export function defaultHandlers() {
  let runs = 0;
  let saved = null;
  return {
    "session.get": () => SESSION,
    "run.start": () => ({ runId: "run-" + ++runs, seed: 42 }),
    "run.end": (p) => ({ accepted: true, counted: true, best: p.score }),
    "save.get": () => ({ data: saved }),
    "save.set": (p) => {
      saved = p.data;
      return {};
    },
    "link.open": () => ({ opened: true }),
  };
}

/** A framed env that has already finished the handshake. */
export async function connected(opts = {}) {
  const env = makeEnv(opts);
  const host = env.hello({ handlers: opts.handlers });
  await until(() => host.acked, "hello.ack");
  return { env, host, sdk: env.sdk };
}
