// three.js starter for a DegenHive game.
//
// The rules in sim.js are the same as in the canvas starter. Only drawing
// changes: game.js reads the state and moves three.js objects to match it.
// three is loaded from jsDelivr with an exact version. The checks swap this
// URL for a pinned copy hosted by DegenHive.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { WORLD, PADDLE, ITEM_R, LIVES, init, step, score, isOver } from "./sim.js";

const dh = window.DegenHive;
const STEP = 1 / 60; // the simulation always advances in steps of this size
const S = 0.01; // sim units to three.js units

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
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
let squash = 0; // paddle bounce after a catch
const input = { dir: 0, target: null };

// ---- three.js scene ------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0x16121c);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xfff0d0, 0x2a1a38, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 4, 6);
scene.add(sun);

const field = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD.w * S, WORLD.h * S),
  new THREE.MeshLambertMaterial({ color: 0x211829 })
);
field.position.z = -0.2;
scene.add(field);

const paddle = new THREE.Mesh(
  new THREE.BoxGeometry(PADDLE.w * S, PADDLE.h * S, 0.3),
  new THREE.MeshLambertMaterial({ color: 0xf4ead8 })
);
scene.add(paddle);

// Coins are drawn from a pool: one mesh per falling item, reused.
const coinGeometry = new THREE.CylinderGeometry(ITEM_R * S, ITEM_R * S, 0.12, 24).rotateX(Math.PI / 2);
const coinMaterial = new THREE.MeshLambertMaterial({ color: 0xffc247, emissive: 0x553300 });
const coins = [];

// sim y grows downward, three.js y grows upward
const toX = (x) => (x - WORLD.w / 2) * S;
const toY = (y) => (WORLD.h / 2 - y) * S;

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

// Convert a pointer position to a sim x. The camera looks straight at the
// field, so this is a plain ratio of the field's on-screen width.
function worldX(e) {
  const r = canvas.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const half = camera.position.z * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
  return WORLD.w / 2 + (nx * half) / S;
}

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
  render(dt);
}

function handleEvents() {
  for (const ev of sim.events) {
    if (ev.type === "catch") {
      blip(660 + (sim.caught % 5) * 110);
      squash = 1;
    } else if (ev.type === "miss") {
      blip(160, 0.25, "sawtooth", 0.12);
    }
  }
  sim.events.length = 0;
}

// ---- drawing -------------------------------------------------------------

// Fit the whole field in view, in portrait or landscape.
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const forHeight = (WORLD.h * S) / 2 / tan;
  const forWidth = (WORLD.w * S) / 2 / (tan * camera.aspect);
  camera.position.set(0, 0, Math.max(forHeight, forWidth) * 1.05);
  camera.updateProjectionMatrix();
}

function render(dt) {
  const x = sim ? sim.x : WORLD.w / 2;
  squash = Math.max(0, squash - dt * 6);
  paddle.position.set(toX(x), toY(PADDLE.y + PADDLE.h / 2), 0);
  paddle.scale.set(1 + squash * 0.15, 1 - squash * 0.25, 1);

  const items = sim ? sim.items : [];
  while (coins.length < items.length) {
    const mesh = new THREE.Mesh(coinGeometry, coinMaterial);
    scene.add(mesh);
    coins.push(mesh);
  }
  coins.forEach((mesh, i) => {
    mesh.visible = i < items.length;
    if (mesh.visible) {
      mesh.position.set(toX(items[i].x), toY(items[i].y), 0);
      mesh.rotation.y += dt * 4;
    }
  });

  renderer.render(scene, camera);
}

boot();
