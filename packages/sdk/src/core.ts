import type { DegenHiveApi, ErrorCode, RunResult, RunStart, Session, TrackName, TrackProps } from "./types";
import { mulberry32 } from "./rng";

declare const __VERSION__: string;

// Protocol constants (docs/PROTOCOL.md section 5).
const HOSTS = ["https://degenhive.ai", "https://www.degenhive.ai", "http://localhost:3000", "http://localhost:3300"];
const DEV_HOST = /^http:\/\/localhost:\d{1,5}$/; // only when the game itself runs on *.localhost
const HELLO_WAIT = 1500;
const REQUEST_TIMEOUT = 10000;
// link.open waits for a person to answer a confirm sheet in the host, so it gets far longer.
const LINK_TIMEOUT = 600000;
const HEARTBEAT = 30000;
const READY_WAIT = 10000;
const MAX_MSG = 64 * 1024;
const MAX_SAVE = 60 * 1024;
const MAX_RUN_END = 256 * 1024;
const MAX_SCORE = 1000000;
const MAX_ERRORS = 20;
// The host allows 20 messages a second. Counting over a slightly longer window keeps
// us under that even when the two sides measure the second differently.
const RATE = 20;
const RATE_WINDOW = 1100;
const MAX_QUEUE = 100;

const TRACK_NAMES = ["level_start", "level_complete", "level_fail", "funnel_step", "gameplay_start", "gameplay_stop", "custom"];
const HOST_EVENTS: Record<string, string> = {
  pause: "pause",
  resume: "resume",
  mute: "mute",
  "session.changed": "sessionChanged",
  "session.ending": "sessionEnding",
};
const LISTEN = Object.values(HOST_EVENTS);
// Order in which queued events are dropped when the queue is full.
const DROP_ORDER = ["track", "heartbeat", "error"];

type Fn = (payload: any) => void;

interface Msg {
  v: 1;
  id?: string;
  type: string;
  payload: any;
}

interface Out {
  msg: Msg;
  kind: string; // event type, "" for a request
  ms?: number; // how long a request may wait for its answer
  res?: (value: any) => void;
  rej?: (error: Error) => void;
  local?: () => any; // answers a request when there is no host
}

function fail(code: ErrorCode, message: string): Error {
  const e: any = new Error(message);
  e.name = "DegenHiveError";
  e.code = code;
  return e;
}

function warn(message: string): void {
  console.warn("[DegenHive] " + message);
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const no = (code: ErrorCode, message: string): Promise<never> => Promise.reject(fail(code, message));

function hostAllowed(origin: unknown): boolean {
  return (
    typeof origin === "string" &&
    (HOSTS.indexOf(origin) >= 0 || (/\.localhost$/.test(location.hostname) && DEV_HOST.test(origin)))
  );
}

/** Null when the message fits its limit, otherwise the error to reject with. */
function check(msg: Msg): Error | null {
  let s: string;
  try {
    s = JSON.stringify(msg);
  } catch {
    return fail("bad_request", "the payload cannot be serialized");
  }
  const max = msg.type === "run.end" && msg.payload.log !== undefined ? MAX_RUN_END : MAX_MSG;
  // A UTF-16 unit is at most 3 bytes in UTF-8, so short strings need no encoding.
  if (s.length * 3 > max && new TextEncoder().encode(s).length > max) {
    return fail("too_large", "the message is over " + max / 1024 + " KB");
  }
  return null;
}

export function createSDK(): DegenHiveApi {
  const w: any = window;
  let mode = 0; // 0 waiting for the host, 1 host, 2 local
  let port: MessagePort | null = null;
  let seq = 0;
  let run: { start: Promise<RunStart>; ended: boolean; t0: number } | null = null;
  let sess: Session | null = null;
  let sessReq: Promise<Session> | null = null;
  let readySent = false;
  let helloTimer: any;
  let pumpTimer: any = 0;
  let nErr = 0;
  let helloWarned = false;
  let localRuns = 0;
  const outbox: Out[] = [];
  const pending: Record<string, { res: Fn; rej: (e: Error) => void; t: any }> = {};
  const sentAt: number[] = [];
  const seenErr: Record<string, 1> = {};
  const listeners: Record<string, Fn[]> = {};
  const mem: Record<string, string> = {};

  // ---- local storage with an in-memory fallback (sandboxed or private windows) ----
  function lget(k: string): string | null {
    if (k in mem) return mem[k];
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function lset(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
      delete mem[k];
    } catch {
      mem[k] = v;
    }
  }

  // ---- outgoing queue and rate limit ----
  function post(o: Out): void {
    if (o.res) {
      const id = o.msg.id as string;
      pending[id] = {
        res: o.res,
        rej: o.rej as (e: Error) => void,
        t: setTimeout(() => {
          const p = take(id);
          if (p) p.rej(fail("unavailable", "the host did not answer in time"));
        }, o.ms),
      };
    }
    try {
      (port as MessagePort).postMessage(o.msg);
    } catch {
      const p = o.res && take(o.msg.id as string);
      if (p) p.rej(fail("bad_request", "the message could not be sent"));
    }
  }

  function take(id: string) {
    const p = pending[id];
    if (p) {
      delete pending[id];
      clearTimeout(p.t);
    }
    return p;
  }

  function pump(): void {
    if (mode !== 1) return;
    const now = performance.now();
    while (sentAt.length && now - sentAt[0] >= RATE_WINDOW) sentAt.shift();
    while (outbox.length && sentAt.length < RATE) {
      sentAt.push(now);
      post(outbox.shift() as Out);
    }
    if (outbox.length && !pumpTimer) {
      pumpTimer = setTimeout(() => {
        pumpTimer = 0;
        pump();
      }, Math.max(1, sentAt[0] + RATE_WINDOW - now));
    }
  }

  function enqueue(o: Out): void {
    if (outbox.length >= MAX_QUEUE) {
      let i = -1;
      for (const k of DROP_ORDER) {
        i = outbox.findIndex((x) => x.kind === k);
        if (i >= 0) break;
      }
      if (i < 0) {
        if (o.rej) o.rej(fail("rate_limited", "too many messages are waiting"));
        else warn("dropped " + o.kind + ": too many messages are waiting");
        return;
      }
      outbox.splice(i, 1);
    }
    outbox.push(o);
    pump();
  }

  /** Fire-and-forget message to the host. Dropped in local mode. */
  function ev(type: string, payload: object): void {
    if (mode === 2) return;
    const msg: Msg = { v: 1, type, payload };
    const bad = check(msg);
    if (bad) warn(type + " was dropped: " + bad.message);
    else enqueue({ msg, kind: type });
  }

  /** Request to the host. In local mode `local` answers it. */
  function ask<T>(type: string, payload: object, local: () => any, ms = REQUEST_TIMEOUT): Promise<T> {
    return new Promise((res, rej) => {
      const msg: Msg = { v: 1, id: String(++seq), type, payload };
      const bad = check(msg);
      if (bad) return rej(bad);
      if (mode === 2) return res(local());
      enqueue({ msg, kind: "", res, rej, local, ms });
    });
  }

  // ---- host events ----
  function emit(name: string, payload: unknown): void {
    (listeners[name] || []).slice().forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function onPort(e: MessageEvent): void {
    const d = e.data;
    if (!d || d.v !== 1) return;
    if (typeof d.re === "string") {
      const p = take(d.re);
      if (!p) return;
      if (d.ok === true) p.res(d.payload || {});
      else if (d.error && typeof d.error.code === "string") p.rej(fail(d.error.code as ErrorCode, String(d.error.message)));
      else p.rej(fail("unavailable", "the host sent an error without a code"));
      return;
    }
    const name = HOST_EVENTS[d.type];
    if (typeof name !== "string") return;
    const p = d.payload && typeof d.payload === "object" ? d.payload : {};
    if (name === "sessionChanged") sess = clone(p);
    else if (name === "mute" && sess) sess.muted = !!p.muted;
    emit(name, clone(p));
  }

  // ---- handshake ----
  function toHost(p: MessagePort): void {
    port = p;
    mode = 1;
    w.removeEventListener("message", onMsg);
    p.onmessage = onPort;
    p.postMessage({ v: 1, type: "hello.ack", sdk: __VERSION__ });
    setInterval(beat, HEARTBEAT);
    pump();
  }

  function toLocal(): void {
    mode = 2;
    clearTimeout(helloTimer);
    console.info("[DegenHive] local mode: no host page");
    for (const o of outbox.splice(0)) {
      if (o.res && o.rej && o.local) {
        try {
          o.res(o.local());
        } catch (e) {
          o.rej(e as Error);
        }
      }
    }
  }

  function onMsg(e: MessageEvent): void {
    const d = e.data;
    if (mode === 1 || e.source !== w.parent || !d || d.dh !== "hello") return;
    const p = e.ports && e.ports[0];
    // e.origin is set by the browser; d.origin is what the host claims. Both must agree.
    if (d.v !== 1 || !p || e.origin !== d.origin || !hostAllowed(d.origin)) {
      if (!helloWarned) {
        helloWarned = true;
        warn("ignored a hello from " + String(d.origin).slice(0, 80));
      }
      return;
    }
    if (mode) return; // local mode has started: a late hello is ignored
    clearTimeout(helloTimer);
    toHost(p);
  }

  function onLoad(fn: () => void): void {
    if (document.readyState === "complete") fn();
    else w.addEventListener("load", fn, { once: true });
  }

  // ---- heartbeat, errors ----
  function fps(cb: (n?: number) => void): void {
    const raf = w.requestAnimationFrame;
    if (!raf) return cb();
    let n = 0;
    let t0 = 0;
    let done = false;
    const end = (v?: number) => {
      if (!done) {
        done = true;
        cb(v);
      }
    };
    const tick = (t: number) => {
      if (!t0) t0 = t;
      else n++;
      if (t - t0 >= 500) end(Math.round((n * 1000) / (t - t0)));
      else raf.call(w, tick);
    };
    raf.call(w, tick);
    setTimeout(end, 1500);
  }

  function beat(): void {
    if (document.visibilityState !== "visible") return;
    fps((n) => {
      if (document.visibilityState === "visible") ev("heartbeat", n ? { visible: true, fps: n } : { visible: true });
    });
  }

  function report(message: unknown, source?: unknown, line?: unknown): void {
    if (nErr >= MAX_ERRORS) return;
    const m = String(message).slice(0, 500);
    const s = typeof source === "string" && source ? source.slice(0, 300) : "";
    const l = typeof line === "number" && line > 0 ? line : 0;
    const k = m + "|" + s + "|" + l;
    if (seenErr[k]) return;
    seenErr[k] = 1;
    nErr++;
    const p: any = { message: m };
    if (s) p.source = s;
    if (l) p.line = l;
    ev("error", p);
  }

  // ---- local mode answers ----
  const localSession = (): Session => ({
    mode: "local",
    player: { name: "Local Player", avatar: null, signedIn: false },
    lab: null,
    muted: false,
    locale: (w.navigator && w.navigator.language) || "en",
  });

  function localEnd(p: { runId: string; score: number; durationMs: number }): RunResult {
    const old = lget("dh:best");
    const best = old === null ? p.score : Math.max(+old || 0, p.score);
    lset("dh:best", String(best));
    console.log("[DegenHive local] run ended", p, "best", best);
    return { accepted: true, counted: false, best };
  }

  // ---- public API ----
  function runStart(): Promise<RunStart> {
    const r = { start: null as unknown as Promise<RunStart>, ended: false, t0: 0 };
    r.start = ask<RunStart>("run.start", {}, () => ({
      runId: "local-" + ++localRuns,
      seed: (Math.random() * 4294967296) >>> 0,
    })).then((v) => {
      if (!v || typeof v.runId !== "string" || typeof v.seed !== "number") {
        throw fail("unavailable", "bad run.start reply");
      }
      r.t0 = performance.now();
      return { runId: v.runId, seed: v.seed };
    });
    run = r;
    return r.start;
  }

  function runEnd(result: { score: number; log?: string }): Promise<RunResult> {
    const r = run;
    if (!r) {
      warn("runEnd was called before runStart");
      return no("run_unknown", "no run in progress");
    }
    if (r.ended) {
      warn("runEnd was already called for this run. Call it once per run; start the next with runStart().");
      return no("run_unknown", "runEnd was already called for this run");
    }
    const score = result && result.score;
    const log = result && result.log;
    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return no("bad_request", "score must be a whole number from 0 to 1,000,000");
    }
    if (log !== undefined && typeof log !== "string") {
      return no("bad_request", "log must be a string");
    }
    r.ended = true;
    return r.start
      .then((s) => {
        const payload: any = { runId: s.runId, score, durationMs: Math.max(0, Math.round(performance.now() - r.t0)) };
        if (log !== undefined) payload.log = log;
        return ask<RunResult>("run.end", payload, () => localEnd(payload));
      })
      .catch((e) => {
        // Unless the host used up the run, a failed call can be retried.
        if (e.code !== "run_unknown" && e.code !== "run_rejected") r.ended = false;
        throw e;
      });
  }

  const api: DegenHiveApi = {
    version: __VERSION__,

    ready() {
      if (readySent) return;
      readySent = true;
      ev("ready", {});
    },

    session() {
      if (sess) return Promise.resolve(clone(sess));
      if (!sessReq) {
        sessReq = ask<Session>("session.get", {}, localSession)
          .then((s) => sess || (sess = s))
          .finally(() => {
            sessReq = null;
          });
      }
      return sessReq.then(clone);
    },

    runStart,
    runEnd,

    save: {
      get() {
        return ask<{ data: string | null }>("save.get", {}, () => ({ data: lget("dh:save") })).then((r) =>
          typeof r.data === "string" ? r.data : null,
        );
      },
      set(data: string) {
        if (typeof data !== "string") return no("bad_request", "save.set needs a string");
        if (new TextEncoder().encode(data).length > MAX_SAVE) return no("too_large", "a save is at most 60 KB");
        return ask<object>("save.set", { data }, () => {
          lset("dh:save", data);
          return {};
        }).then(() => undefined);
      },
    },

    track(name: TrackName, props?: TrackProps) {
      if (TRACK_NAMES.indexOf(name) < 0) return warn('track: unknown name "' + String(name).slice(0, 40) + '"');
      if (props !== undefined) {
        if (!props || typeof props !== "object" || Array.isArray(props)) return warn("track: props must be an object");
        for (const k in props) {
          const v: unknown = props[k];
          if (typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && isFinite(v))) {
            return warn('track: prop "' + k + '" must be a string, number or boolean');
          }
        }
      }
      ev("track", props ? { name, props } : { name });
    },

    openLink(url: string) {
      let u: URL | undefined;
      try {
        u = new URL(url);
      } catch {
        // falls through to the check below
      }
      if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
        return no("bad_request", "openLink needs an http or https URL");
      }
      const href = u.href;
      return ask<{ opened: boolean }>("link.open", { url: href }, () => {
        try {
          w.open(href, "_blank", "noopener,noreferrer");
          return { opened: true };
        } catch {
          return { opened: false };
        }
      }, LINK_TIMEOUT).then((r) => !!r.opened);
    },

    on(event, fn) {
      if (LISTEN.indexOf(event) < 0) throw new TypeError('DegenHive.on: unknown event "' + String(event) + '"');
      if (typeof fn !== "function") throw new TypeError("DegenHive.on needs a function");
      (listeners[event] = listeners[event] || []).push(fn);
      return () => {
        const l = listeners[event];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      };
    },

    random: mulberry32,
  };

  // ---- start ----
  w.addEventListener("error", (e: ErrorEvent) => report(e.message || "error", e.filename, e.lineno));
  w.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    report(r && r.message ? r.message : r);
  });
  // Without a host, the page lets games test their pause handling by hiding the tab.
  document.addEventListener("visibilitychange", () => {
    if (mode === 2) emit(document.visibilityState === "hidden" ? "pause" : "resume", {});
  });
  onLoad(() => {
    setTimeout(() => {
      if (!readySent) warn("ready() was not called within 10 s of load");
    }, READY_WAIT);
  });
  if (w.parent === w) {
    toLocal(); // not in a frame: nobody will say hello
  } else {
    w.addEventListener("message", onMsg);
    // The host says hello after the iframe's load event, so the 1,500 ms start at load.
    onLoad(() => {
      helloTimer = setTimeout(() => {
        if (!mode) toLocal();
      }, HELLO_WAIT);
    });
  }

  return Object.freeze(api);
}
