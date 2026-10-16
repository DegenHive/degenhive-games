/*! @degenhive/game-sdk 1.0.0 */

// src/rng.ts
function mulberry32(seed) {
  if (typeof seed !== "number" || !isFinite(seed)) {
    throw new TypeError("DegenHive.random(seed) needs a finite number");
  }
  let a = seed | 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// src/core.ts
var HOSTS = ["https://degenhive.ai", "https://www.degenhive.ai", "http://localhost:3000", "http://localhost:3300"];
var DEV_HOST = /^http:\/\/localhost:\d{1,5}$/;
var HELLO_WAIT = 1500;
var REQUEST_TIMEOUT = 1e4;
var HEARTBEAT = 3e4;
var READY_WAIT = 1e4;
var MAX_MSG = 64 * 1024;
var MAX_RUN_END = 256 * 1024;
var MAX_SCORE = 1e6;
var MAX_ERRORS = 20;
var RATE = 20;
var RATE_WINDOW = 1100;
var MAX_QUEUE = 100;
var TRACK_NAMES = ["level_start", "level_complete", "level_fail", "funnel_step", "gameplay_start", "gameplay_stop", "custom"];
var HOST_EVENTS = {
  pause: "pause",
  resume: "resume",
  mute: "mute",
  "session.changed": "sessionChanged",
  "session.ending": "sessionEnding"
};
var LISTEN = Object.values(HOST_EVENTS);
var DROP_ORDER = ["track", "heartbeat", "error"];
function fail(code, message) {
  const e = new Error(message);
  e.name = "DegenHiveError";
  e.code = code;
  return e;
}
function warn(message) {
  console.warn("[DegenHive] " + message);
}
var clone = (x) => JSON.parse(JSON.stringify(x));
var no = (code, message) => Promise.reject(fail(code, message));
function hostAllowed(origin) {
  return typeof origin === "string" && (HOSTS.indexOf(origin) >= 0 || /\.localhost$/.test(location.hostname) && DEV_HOST.test(origin));
}
function check(msg) {
  let s;
  try {
    s = JSON.stringify(msg);
  } catch {
    return fail("bad_request", "the payload cannot be serialized");
  }
  const max = msg.type === "run.end" && msg.payload.log !== void 0 ? MAX_RUN_END : MAX_MSG;
  if (s.length * 3 > max && new TextEncoder().encode(s).length > max) {
    return fail("too_large", "the message is over " + max / 1024 + " KB");
  }
  return null;
}
function createSDK() {
  const w = window;
  let mode = 0;
  let port = null;
  let seq = 0;
  let run = null;
  let sess = null;
  let sessReq = null;
  let readySent = false;
  let helloTimer;
  let pumpTimer = 0;
  let nErr = 0;
  let helloWarned = false;
  let localRuns = 0;
  const outbox = [];
  const pending = {};
  const sentAt = [];
  const seenErr = {};
  const listeners = {};
  const mem = {};
  function lget(k) {
    if (k in mem) return mem[k];
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function lset(k, v) {
    try {
      localStorage.setItem(k, v);
      delete mem[k];
    } catch {
      mem[k] = v;
    }
  }
  function post(o) {
    if (o.res) {
      const id = o.msg.id;
      pending[id] = {
        res: o.res,
        rej: o.rej,
        t: setTimeout(() => {
          const p = take(id);
          if (p) p.rej(fail("unavailable", "no answer from the host in 10 s"));
        }, REQUEST_TIMEOUT)
      };
    }
    try {
      port.postMessage(o.msg);
    } catch {
      const p = o.res && take(o.msg.id);
      if (p) p.rej(fail("bad_request", "the message could not be sent"));
    }
  }
  function take(id) {
    const p = pending[id];
    if (p) {
      delete pending[id];
      clearTimeout(p.t);
    }
    return p;
  }
  function pump() {
    if (mode !== 1) return;
    const now = performance.now();
    while (sentAt.length && now - sentAt[0] >= RATE_WINDOW) sentAt.shift();
    while (outbox.length && sentAt.length < RATE) {
      sentAt.push(now);
      post(outbox.shift());
    }
    if (outbox.length && !pumpTimer) {
      pumpTimer = setTimeout(() => {
        pumpTimer = 0;
        pump();
      }, Math.max(1, sentAt[0] + RATE_WINDOW - now));
    }
  }
  function enqueue(o) {
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
  function ev(type, payload) {
    if (mode === 2) return;
    const msg = { v: 1, type, payload };
    const bad = check(msg);
    if (bad) warn(type + " was dropped: " + bad.message);
    else enqueue({ msg, kind: type });
  }
  function ask(type, payload, local) {
    return new Promise((res, rej) => {
      const msg = { v: 1, id: String(++seq), type, payload };
      const bad = check(msg);
      if (bad) return rej(bad);
      if (mode === 2) return res(local());
      enqueue({ msg, kind: "", res, rej, local });
    });
  }
  function emit(name, payload) {
    (listeners[name] || []).slice().forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }
  function onPort(e) {
    const d = e.data;
    if (!d || d.v !== 1) return;
    if (typeof d.re === "string") {
      const p2 = take(d.re);
      if (!p2) return;
      if (d.ok === true) p2.res(d.payload || {});
      else if (d.error && typeof d.error.code === "string") p2.rej(fail(d.error.code, String(d.error.message)));
      else p2.rej(fail("unavailable", "the host sent an error without a code"));
      return;
    }
    const name = HOST_EVENTS[d.type];
    if (typeof name !== "string") return;
    const p = d.payload && typeof d.payload === "object" ? d.payload : {};
    if (name === "sessionChanged") sess = clone(p);
    else if (name === "mute" && sess) sess.muted = !!p.muted;
    emit(name, clone(p));
  }
  function toHost(p) {
    port = p;
    mode = 1;
    w.removeEventListener("message", onMsg);
    p.onmessage = onPort;
    p.postMessage({ v: 1, type: "hello.ack", sdk: "1.0.0" });
    setInterval(beat, HEARTBEAT);
    pump();
  }
  function toLocal() {
    mode = 2;
    clearTimeout(helloTimer);
    console.info("[DegenHive] no host page: local mode, runs are not scored");
    for (const o of outbox.splice(0)) {
      if (o.res && o.rej && o.local) {
        try {
          o.res(o.local());
        } catch (e) {
          o.rej(e);
        }
      }
    }
  }
  function onMsg(e) {
    const d = e.data;
    if (mode === 1 || e.source !== w.parent || !d || d.dh !== "hello") return;
    const p = e.ports && e.ports[0];
    if (d.v !== 1 || !p || e.origin !== d.origin || !hostAllowed(d.origin)) {
      if (!helloWarned) {
        helloWarned = true;
        warn("ignored a hello from " + String(d.origin).slice(0, 80));
      }
      return;
    }
    if (mode) return;
    clearTimeout(helloTimer);
    toHost(p);
  }
  function onLoad(fn) {
    if (document.readyState === "complete") fn();
    else w.addEventListener("load", fn, { once: true });
  }
  function fps(cb) {
    const raf = w.requestAnimationFrame;
    if (!raf) return cb();
    let n = 0;
    let t0 = 0;
    let done = false;
    const end = (v) => {
      if (!done) {
        done = true;
        cb(v);
      }
    };
    const tick = (t) => {
      if (!t0) t0 = t;
      else n++;
      if (t - t0 >= 500) end(Math.round(n * 1e3 / (t - t0)));
      else raf.call(w, tick);
    };
    raf.call(w, tick);
    setTimeout(end, 1500);
  }
  function beat() {
    if (document.visibilityState !== "visible") return;
    fps((n) => {
      if (document.visibilityState === "visible") ev("heartbeat", n ? { visible: true, fps: n } : { visible: true });
    });
  }
  function report(message, source, line) {
    if (nErr >= MAX_ERRORS) return;
    const m = String(message).slice(0, 500);
    const s = typeof source === "string" && source ? source.slice(0, 300) : "";
    const l = typeof line === "number" && line > 0 ? line : 0;
    const k = m + "|" + s + "|" + l;
    if (seenErr[k]) return;
    seenErr[k] = 1;
    nErr++;
    const p = { message: m };
    if (s) p.source = s;
    if (l) p.line = l;
    ev("error", p);
  }
  const localSession = () => ({
    mode: "local",
    player: { name: "Local Player", avatar: null, signedIn: false },
    lab: null,
    muted: false,
    locale: w.navigator && w.navigator.language || "en"
  });
  function localEnd(p) {
    const old = lget("dh:best");
    const best = old === null ? p.score : Math.max(+old || 0, p.score);
    lset("dh:best", String(best));
    console.log("[DegenHive local] run ended", p, "best", best);
    return { accepted: true, counted: false, best };
  }
  function runStart() {
    const r = { start: null, ended: false, t0: 0 };
    r.start = ask("run.start", {}, () => ({
      runId: "local-" + ++localRuns,
      seed: Math.random() * 4294967296 >>> 0
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
  function runEnd(result) {
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
    if (log !== void 0 && typeof log !== "string") {
      return no("bad_request", "log must be a string");
    }
    r.ended = true;
    return r.start.then((s) => {
      const payload = { runId: s.runId, score, durationMs: Math.max(0, Math.round(performance.now() - r.t0)) };
      if (log !== void 0) payload.log = log;
      return ask("run.end", payload, () => localEnd(payload));
    }).catch((e) => {
      if (e.code !== "run_unknown" && e.code !== "run_rejected") r.ended = false;
      throw e;
    });
  }
  const api = {
    version: "1.0.0",
    ready() {
      if (readySent) return;
      readySent = true;
      ev("ready", {});
    },
    session() {
      if (sess) return Promise.resolve(clone(sess));
      if (!sessReq) {
        sessReq = ask("session.get", {}, localSession).then((s) => sess || (sess = s)).finally(() => {
          sessReq = null;
        });
      }
      return sessReq.then(clone);
    },
    runStart,
    runEnd,
    save: {
      get() {
        return ask("save.get", {}, () => ({ data: lget("dh:save") })).then(
          (r) => typeof r.data === "string" ? r.data : null
        );
      },
      set(data) {
        if (typeof data !== "string") return no("bad_request", "save.set needs a string");
        return ask("save.set", { data }, () => {
          lset("dh:save", data);
          return {};
        }).then(() => void 0);
      }
    },
    track(name, props) {
      if (TRACK_NAMES.indexOf(name) < 0) return warn('track: unknown name "' + String(name).slice(0, 40) + '"');
      if (props !== void 0) {
        if (!props || typeof props !== "object" || Array.isArray(props)) return warn("track: props must be an object");
        for (const k in props) {
          const v = props[k];
          if (typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && isFinite(v))) {
            return warn('track: prop "' + k + '" must be a string, number or boolean');
          }
        }
      }
      ev("track", props ? { name, props } : { name });
    },
    openLink(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
      }
      if (!u || u.protocol !== "https:" && u.protocol !== "http:") {
        return no("bad_request", "openLink needs an http or https URL");
      }
      const href = u.href;
      return ask("link.open", { url: href }, () => {
        try {
          w.open(href, "_blank", "noopener,noreferrer");
          return { opened: true };
        } catch {
          return { opened: false };
        }
      }).then((r) => !!r.opened);
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
    random: mulberry32
  };
  w.addEventListener("error", (e) => report(e.message || "error", e.filename, e.lineno));
  w.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report(r && r.message ? r.message : r);
  });
  document.addEventListener("visibilitychange", () => {
    if (mode === 2) emit(document.visibilityState === "hidden" ? "pause" : "resume", {});
  });
  onLoad(() => {
    setTimeout(() => {
      if (!readySent) warn("ready() was not called within 10 s of load");
    }, READY_WAIT);
  });
  if (w.parent === w) {
    toLocal();
  } else {
    w.addEventListener("message", onMsg);
    onLoad(() => {
      helloTimer = setTimeout(() => {
        if (!mode) toLocal();
      }, HELLO_WAIT);
    });
  }
  return Object.freeze(api);
}

// src/index.ts
function boot() {
  const w = window;
  if (w.DegenHive) return w.DegenHive;
  const api = createSDK();
  w.DegenHive = api;
  w.dispatchEvent(new CustomEvent("degenhive:ready", { detail: api }));
  return api;
}
var DegenHive = boot();
var index_default = DegenHive;
export {
  DegenHive,
  index_default as default
};
