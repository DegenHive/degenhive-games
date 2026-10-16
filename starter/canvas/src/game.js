// Canvas 2D starter for a DegenHive game.
//
// game.js talks to the player, the screen and the SDK. sim.js holds the rules.
// To make your own game, keep the SDK calls and the structure here and
// replace the rules in sim.js and the drawing in draw().

import { WORLD, PADDLE, ITEM_R, LIVES, init, step, score, isOver } from "./sim.js";

const dh = window.DegenHive;
const STEP = 1 / 60; // the simulation always advances in steps of this size

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ctx = canvas.getContext("2d");
const ui = {
  hud: $("hud"), score: $("score"), lives: $("lives"), badge: $("badge"), toast: $("toast"),
  title: $("title"), over: $("over"), paused: $("paused"),
  bestTitle: $("best-title"), bestOver: $("best-over"), newBest: $("new-best"),
  final: $("final"), note: $("note"),
};

const MODE_LABEL = { practice: "Practice", points: "Points on", preview: "Preview", local: "Local test" };

// ---- state ---------------------------------------------------------------

let phase = "title"; // "title" | "playing" | "over"
let paused = false;
let muted = false;
let mode = "local";
let best = 0;
let run = null; // { live: boolean, ended: boolean } for the current run
let starting = false; // true while runStart() is pending
let overAt = 0; // when the game over screen appeared, to ignore stray taps
let sim = null;
let acc = 0; // time not yet simulated
let lastFrame = null;
let particles = [];
const input = { dir: 0, target: null };

// ---- boot ----------------------------------------------------------------

async function boot() {
  // handlers first, so no host event is missed while the session loads
  dh.on("pause", () => setPaused(true));
  dh.on("resume", () => setPaused(false));
  dh.on("mute", (p) => { muted = p.muted; });
  dh.on("sessionChanged", applySession);
  dh.on("sessionEnding", (p) => toast("Session ends in " + p.secondsLeft + " s"));

  try {
    applySession(await dh.session());
  } catch {
    applySession({ mode: "local", muted: false });
  }
  best = await loadBest();
  ui.bestTitle.textContent = best;

  resize();
  new ResizeObserver(resize).observe(canvas);
  requestAnimationFrame(frame);

  dh.ready(); // the title screen is up and takes input
}

function applySession(s) {
  mode = s.mode;
  muted = !!s.muted;
  ui.badge.textContent = MODE_LABEL[mode] || "Practice";
  ui.badge.dataset.mode = mode;
}

// ---- save ----------------------------------------------------------------

async function loadBest() {
  try {
    const raw = await dh.save.get();
    return raw ? Math.max(0, JSON.parse(raw).best | 0) : 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  dh.save.set(JSON.stringify({ best })).catch(() => {});
}

// ---- runs ----------------------------------------------------------------

async function startRun() {
  if (phase === "playing" || starting) return;
  starting = true;
  let started;
  try {
    started = await dh.runStart();
  } catch {
    // The host could not start a run. Play anyway, but this run is never reported.
    started = { runId: null, seed: (Math.random() * 4294967296) >>> 0 };
  }
  starting = false;

  run = { live: started.runId !== null, ended: false };
  sim = init(started.seed, dh.random(started.seed)); // score-affecting randomness uses the seed
  acc = 0;
  particles = [];
  phase = "playing";
  ui.paused.hidden = !paused; // a pause that arrived while the run was starting
  ui.title.hidden = true;
  ui.over.hidden = true;
  ui.hud.hidden = false;
  drawHud();
}

// Called when sim says the run is over. runEnd is called once per run.
async function endRun() {
  if (!run || run.ended) return;
  run.ended = true;

  const final = score(sim);
  const wasBest = final > best;
  if (wasBest) {
    best = final;
    saveBest();
  }

  phase = "over";
  overAt = performance.now();
  ui.hud.hidden = true;
  ui.final.textContent = final;
  ui.bestOver.textContent = best;
  ui.bestTitle.textContent = best;
  ui.newBest.hidden = !wasBest;
  ui.note.textContent = "";
  ui.over.hidden = false;

  if (!run.live) {
    ui.note.textContent = "This run was not reported.";
    return;
  }
  try {
    const result = await dh.runEnd({ score: final });
    ui.note.textContent = describe(result);
  } catch {
    ui.note.textContent = "The score could not be sent.";
  }
}

function describe(result) {
  if (!result.accepted) return result.reason || "The run was not accepted.";
  if (result.counted) return "Counted.";
  if (mode === "practice") return "Practice run. Points are off.";
  if (mode === "local") return "Local test run.";
  return "";
}

function setPaused(value) {
  paused = value;
  ui.paused.hidden = !(paused && phase === "playing");
  lastFrame = null; // do not simulate the time spent paused
}

let toastTimer = 0;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4000);
}

function drawHud() {
  ui.score.textContent = score(sim);
  ui.lives.textContent = "♥".repeat(Math.max(0, sim.lives)) + "♡".repeat(Math.max(0, LIVES - sim.lives));
}

// ---- input ---------------------------------------------------------------

function tryStart() {
  if (phase === "title" || (phase === "over" && performance.now() - overAt > 600)) startRun();
}

function worldX(e) {
  const r = canvas.getBoundingClientRect();
  return (e.clientX - r.left - view.ox) / view.scale;
}

// Pointer events cover mouse, touch and pen. They are on window so a drag that
// started on a screen overlay keeps steering after the overlay is hidden.
window.addEventListener("pointerdown", (e) => {
  window.focus(); // a game iframe starts without keyboard focus
  if (phase === "playing") input.target = worldX(e);
  else tryStart();
});
window.addEventListener("pointermove", (e) => {
  if (phase === "playing") input.target = worldX(e);
});

const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === "Space" || e.code === "Enter") tryStart();
  updateDir();
});
window.addEventListener("keyup", (e) => { keys.delete(e.code); updateDir(); });
window.addEventListener("blur", () => { keys.clear(); updateDir(); });

function updateDir() {
  const right = keys.has("ArrowRight") || keys.has("KeyD");
  const left = keys.has("ArrowLeft") || keys.has("KeyA");
  input.dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (input.dir) input.target = null;
}

// ---- sound ---------------------------------------------------------------

let audio = null;
function blip(freq, seconds = 0.12, type = "triangle", volume = 0.18) {
  if (muted) return;
  audio = audio || new AudioContext();
  if (audio.state === "suspended") audio.resume();
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + seconds);
}

// ---- loop ----------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (phase === "playing" && !paused) {
    acc += dt;
    while (acc >= STEP && !isOver(sim)) {
      step(sim, input, STEP);
      acc -= STEP;
    }
    handleEvents();
    drawHud();
    if (isOver(sim)) endRun();
  }
  updateParticles(dt);
  draw();
}

function handleEvents() {
  for (const ev of sim.events) {
    if (ev.type === "catch") {
      blip(660 + (sim.caught % 5) * 110);
      burst(ev.x, ev.y, "#ffc247");
    } else if (ev.type === "miss") {
      blip(160, 0.25, "sawtooth", 0.12);
    }
  }
  sim.events.length = 0;
}

// ---- drawing -------------------------------------------------------------

const view = { w: 0, h: 0, dpr: 1, scale: 1, ox: 0, oy: 0 };

// The play field is WORLD.w x WORLD.h units, fitted into whatever size the
// iframe has and centered. Portrait and landscape both work.
function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = canvas.clientWidth;
  view.h = canvas.clientHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  view.scale = Math.min(view.w / WORLD.w, view.h / WORLD.h);
  view.ox = (view.w - WORLD.w * view.scale) / 2;
  view.oy = (view.h - WORLD.h * view.scale) / 2;
}

function burst(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 60 + Math.random() * 120;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.5, color });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 400 * dt;
  }
  particles = particles.filter((p) => p.life > 0);
}

function draw() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = "#16121c";
  ctx.fillRect(0, 0, view.w, view.h);

  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);

  ctx.fillStyle = "#211829";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);

  // On the title screen there is no run yet; draw a resting paddle.
  const x = sim ? sim.x : WORLD.w / 2;

  if (sim) {
    ctx.fillStyle = "#ffc247";
    for (const it of sim.items) {
      ctx.beginPath();
      ctx.arc(it.x, it.y, ITEM_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = "#f4ead8";
  roundRect(x - PADDLE.w / 2, PADDLE.y, PADDLE.w, PADDLE.h, 7);
  ctx.fill();

  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life * 2);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

boot();
