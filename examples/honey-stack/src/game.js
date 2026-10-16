// Honey Stack: three.js scene, screens, input, sound and the DegenHive SDK calls.
// The rules and the score are in sim.js.
//
// three is loaded from jsDelivr with an exact version. The checks swap this URL
// for a pinned copy hosted by DegenHive.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { THICK, init, step, score, isOver, movingSlab, top } from "./sim.js";

const dh = window.DegenHive;
const STEP = 1 / 60; // the simulation always advances in steps of this size
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ui = {
  hud: $("hud"), score: $("score"), popup: $("popup"), badge: $("badge"), toast: $("toast"),
  title: $("title"), over: $("over"), paused: $("paused"),
  bestTitle: $("best-title"), bestOver: $("best-over"), newBest: $("new-best"),
  final: $("final"), stats: $("stats"), note: $("note"),
};

const MODE_LABEL = { practice: "Practice", points: "Points on", preview: "Preview", local: "Local test" };

// ---- state ---------------------------------------------------------------

let phase = "title"; // "title" | "playing" | "over"
let paused = false;
let muted = false;
let mode = "local";
let best = 0;
let run = null; // { live: boolean, ended: boolean }
let starting = false; // true while runStart() is pending
let readyAt = 0; // taps before this time do not restart the game
let sim = null; // the run being played
let demo = null; // a sliding slab on the title screen. It is never scored.
let acc = 0; // time not yet simulated
let lastFrame = null;
let animT = 0; // seconds, for animation only
let dropQueued = false;
let perfects = 0;
let shake = 0;

// ---- three.js scene ------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
// Light intensities are tuned for three r155 and later, where lights are not pre-multiplied by pi.
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(5, 10, 3);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffc98a, 0.7);
fill.position.set(-6, 4, -5);
scene.add(fill);

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0b8 });
const sparkGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);

// The hexagonal plinth the tower stands on
const plinth = new THREE.Group();
plinth.add(new THREE.Mesh(
  new THREE.CylinderGeometry(5.4, 5.8, 8, 6),
  new THREE.MeshLambertMaterial({ color: 0x3a2b48 })
));
plinth.children[0].position.y = -4.06; // top face just below the cap, so the two do not flicker
const plinthTop = new THREE.Mesh(
  new THREE.CylinderGeometry(5.0, 5.0, 0.12, 6),
  new THREE.MeshLambertMaterial({ color: 0x241a30 })
);
plinthTop.position.y = -0.06;
plinth.add(plinthTop);
scene.add(plinth);

// Outline of where the next slab should land
const target = new THREE.LineSegments(
  new THREE.EdgesGeometry(unitBox),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
);
scene.add(target);

let slabMeshes = []; // placed slabs, by index
let movingMesh = null;
let pieces = []; // cut-off slabs falling away
let flashes = []; // glow on a perfect drop
let sparks = [];

const cam = { x: 0, y: 2, z: 0, sway: 1, zoom: 1, aspect: 1, lastZoom: 0 };
const EL = 0.55; // camera elevation in radians

function levelColor(i) {
  const hue = (37 + 8 * Math.sin(i * 0.13)) / 360;
  return new THREE.Color().setHSL(hue, 0.9, 0.5 + 0.04 * (i % 2) + 0.03 * Math.sin(i * 0.3), THREE.SRGBColorSpace);
}

function makeSlab(i, slab) {
  const mesh = new THREE.Mesh(unitBox, new THREE.MeshLambertMaterial({ color: levelColor(i) }));
  mesh.userData = { level: i, settle: 0 };
  placeMesh(mesh, slab);
  scene.add(mesh);
  return mesh;
}

function placeMesh(mesh, slab) {
  const squash = mesh.userData.settle;
  const height = THICK * (1 - 0.25 * squash);
  mesh.scale.set(slab.w, height, slab.d);
  mesh.position.set(slab.x, mesh.userData.level * THICK + height / 2, slab.z);
}

function disposeMesh(mesh) {
  scene.remove(mesh);
  mesh.material.dispose();
}

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

  buildScene(init(7));
  demo = sim;
  sim = null;

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

// Remove every mesh and rebuild the scene from a sim state.
function buildScene(state) {
  for (const m of slabMeshes) disposeMesh(m);
  if (movingMesh) disposeMesh(movingMesh);
  for (const p of pieces) disposeMesh(p.mesh);
  for (const f of flashes) disposeMesh(f.mesh);
  for (const s of sparks) scene.remove(s.mesh);
  pieces = [];
  flashes = [];
  sparks = [];

  slabMeshes = state.slabs.map((slab, i) => makeSlab(i, slab));
  movingMesh = makeSlab(state.slabs.length, movingSlab(state));
  sim = state;
  cam.x = 0;
  cam.z = 0;
  cam.y = state.slabs.length * THICK + 2.2;
  cam.zoom = 1;
}

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
  buildScene(init(started.seed, dh.random(started.seed))); // score-affecting randomness uses the seed
  acc = 0;
  dropQueued = false;
  perfects = 0;
  shake = 0;
  phase = "playing";
  ui.paused.hidden = !paused; // a pause that arrived while the run was starting
  ui.title.hidden = true;
  ui.over.hidden = true;
  ui.hud.hidden = false;
  ui.score.textContent = "0";
  tone(330, 0.1, "triangle", 0.12, 660);
}

// Called when the sim says the run is over. runEnd is called once per run.
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
  readyAt = performance.now() + 1500; // the camera pulls back first
  setTimeout(() => {
    if (phase !== "over") return;
    ui.hud.hidden = true;
    ui.final.textContent = final;
    ui.bestOver.textContent = best;
    ui.bestTitle.textContent = best;
    ui.newBest.hidden = !wasBest;
    ui.stats.textContent = (sim.slabs.length - 1) + " slabs, " + perfects + " perfect";
    ui.over.hidden = false;
  }, 1200);
  ui.note.textContent = "";

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

function popup(text) {
  ui.popup.textContent = text;
  ui.popup.classList.remove("show");
  void ui.popup.offsetWidth; // restart the animation
  ui.popup.classList.add("show");
}

function popScore() {
  ui.score.textContent = score(sim);
  ui.score.classList.remove("pop");
  void ui.score.offsetWidth;
  ui.score.classList.add("pop");
}

// ---- input ---------------------------------------------------------------

function tryStart() {
  if (phase === "title" || (phase === "over" && performance.now() > readyAt)) startRun();
}

function action() {
  unlockAudio();
  if (phase === "playing") {
    if (!paused) dropQueued = true;
  } else {
    tryStart();
  }
}

// On window, so a tap anywhere works, including on screen overlays.
window.addEventListener("pointerdown", () => {
  window.focus(); // a game iframe starts without keyboard focus
  action();
});
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown") {
    e.preventDefault();
    action();
  }
});

// ---- sound (synthesized, no files) -----------------------------------------

let audio = null;
let noiseBuffer = null;

function unlockAudio() {
  if (!audio) audio = new AudioContext();
  if (audio.state === "suspended") audio.resume();
}

function tone(freq, seconds, type = "sine", volume = 0.15, toFreq = freq, delay = 0) {
  if (muted || !audio) return;
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

function noise(seconds, volume = 0.2, cutoff = 1800) {
  if (muted || !audio) return;
  if (!noiseBuffer) {
    noiseBuffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = audio.currentTime;
  const src = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  src.buffer = noiseBuffer;
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(cutoff, t);
  filter.frequency.exponentialRampToValueAtTime(200, t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  src.connect(filter).connect(gain).connect(audio.destination);
  src.start(t);
  src.stop(t + seconds);
}

const PENTATONIC = [0, 2, 4, 7, 9];
function chime(streak) {
  const semis = PENTATONIC[(streak - 1) % 5] + 12 * Math.floor((streak - 1) / 5);
  const f = 440 * Math.pow(2, semis / 12);
  tone(f, 0.45, "sine", 0.17);
  tone(f * 2, 0.3, "triangle", 0.06, f * 2, 0.03);
  tone(f * 3, 0.2, "sine", 0.03, f * 3, 0.06);
}

// ---- loop ----------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (!paused) {
    animT += dt;
    if (phase === "playing") {
      acc += dt;
      while (acc >= STEP && !isOver(sim)) {
        step(sim, { drop: dropQueued }, STEP); // the queued drop goes into the first step
        dropQueued = false;
        acc -= STEP;
      }
      handleEvents();
      if (isOver(sim)) endRun();
    } else if (phase === "title") {
      step(demo, { drop: false }, dt);
    }
    updateFx(dt);
  }
  render(dt);
}

function handleEvents() {
  for (const ev of sim.events) {
    if (ev.type === "trim") {
      addPiece(ev.slab, ev.index, 0.6);
      tone(300, 0.1, "square", 0.04, 180);
    } else if (ev.type === "place") {
      const mesh = movingMesh;
      mesh.userData.settle = 1;
      slabMeshes.push(mesh);
      placeMesh(mesh, ev.slab);
      movingMesh = isOver(sim) ? null : makeSlab(sim.slabs.length, movingSlab(sim));
      popScore();
      noise(0.08, 0.12, 900);
      tone(150, 0.14, "sine", 0.2, 55);
      addShake(0.05);
      if (ev.perfect) {
        perfects += 1;
        chime(ev.streak);
        flashSlab(ev.slab, ev.index);
        popup(ev.streak > 1 ? "Perfect x" + ev.streak : "Perfect");
      }
    } else if (ev.type === "miss") {
      addPiece(ev.slab, ev.index, 1.2);
      disposeMesh(movingMesh);
      movingMesh = null;
      noise(0.5, 0.25, 2200);
      tone(240, 0.6, "sawtooth", 0.12, 40);
      addShake(0.35);
    }
  }
  sim.events.length = 0;
}

function addShake(amount) {
  if (!reduceMotion) shake = Math.max(shake, amount);
}

// ---- effects ---------------------------------------------------------------

// A cut-off piece of slab that falls away.
function addPiece(slab, level, life) {
  const mesh = new THREE.Mesh(unitBox, new THREE.MeshLambertMaterial({ color: levelColor(level) }));
  mesh.userData = { level: 0, settle: 0 };
  mesh.scale.set(slab.w, THICK, slab.d);
  mesh.position.set(slab.x, level * THICK + THICK / 2, slab.z);
  scene.add(mesh);
  pieces.push({
    mesh, life, vy: 0,
    vx: (Math.random() - 0.5) * 1.5, vz: (Math.random() - 0.5) * 1.5,
    spin: (Math.random() - 0.5) * 4,
  });
}

function flashSlab(slab, level) {
  const mesh = new THREE.Mesh(
    unitBox,
    new THREE.MeshBasicMaterial({ color: 0xfff4c8, transparent: true, opacity: 0.7 })
  );
  mesh.scale.set(slab.w, THICK, slab.d);
  mesh.position.set(slab.x, level * THICK + THICK / 2, slab.z);
  scene.add(mesh);
  flashes.push({ mesh, slab, level, t: 0 });

  for (let i = 0; i < 14; i++) {
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial);
    const edge = Math.random() * Math.PI * 2;
    spark.position.set(slab.x + Math.cos(edge) * slab.w * 0.5, level * THICK + THICK, slab.z + Math.sin(edge) * slab.d * 0.5);
    scene.add(spark);
    sparks.push({
      mesh: spark, life: 0.6 + Math.random() * 0.3,
      vx: Math.cos(edge) * (1 + Math.random() * 2), vy: 2 + Math.random() * 3, vz: Math.sin(edge) * (1 + Math.random() * 2),
    });
  }
}

function updateFx(dt) {
  for (const p of pieces) {
    p.life -= dt;
    p.vy -= 24 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.rotation.x += p.spin * dt;
    p.mesh.rotation.z += p.spin * 0.7 * dt;
    if (p.life < 0.3) p.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 6));
  }
  pieces = pieces.filter((p) => {
    if (p.life > 0) return true;
    disposeMesh(p.mesh);
    return false;
  });

  for (const f of flashes) {
    f.t += dt;
    const k = Math.min(1, f.t / 0.4);
    f.mesh.scale.set(f.slab.w * (1 + 0.25 * k), THICK * (1 + 0.6 * k), f.slab.d * (1 + 0.25 * k));
    f.mesh.material.opacity = 0.7 * (1 - k);
  }
  flashes = flashes.filter((f) => {
    if (f.t < 0.4) return true;
    disposeMesh(f.mesh);
    return false;
  });

  for (const s of sparks) {
    s.life -= dt;
    s.vy -= 9 * dt;
    s.mesh.position.x += s.vx * dt;
    s.mesh.position.y += s.vy * dt;
    s.mesh.position.z += s.vz * dt;
    s.mesh.scale.setScalar(Math.max(0.01, s.life * 1.6));
  }
  sparks = sparks.filter((s) => {
    if (s.life > 0) return true;
    scene.remove(s.mesh);
    return false;
  });

  for (const m of slabMeshes) {
    if (m.userData.settle > 0) {
      m.userData.settle = Math.max(0, m.userData.settle - dt * 7);
      placeMesh(m, { x: m.position.x, z: m.position.z, w: m.scale.x, d: m.scale.z });
    }
  }
  shake = Math.max(0, shake - dt * 1.2);
}

// ---- drawing -------------------------------------------------------------

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  cam.aspect = w / h;
  cam.lastZoom = 0; // force the frustum to update
}

// Keep the whole sliding range in view in portrait and in landscape.
function applyFrustum() {
  const baseHeight = Math.max(10.5, 12 / cam.aspect);
  const vh = baseHeight * cam.zoom;
  camera.left = (-vh * cam.aspect) / 2;
  camera.right = (vh * cam.aspect) / 2;
  camera.top = vh / 2;
  camera.bottom = -vh / 2;
  camera.updateProjectionMatrix();
  cam.lastZoom = cam.zoom;
}

function render(dt) {
  const state = phase === "title" ? demo : sim;
  const level = state.slabs.length - 1;
  const topSlab = top(state);
  const topY = (level + 1) * THICK;

  // camera target
  let ty = topY + 2.2;
  let tx = topSlab.x;
  let tz = topSlab.z;
  let zoom = 1;
  if (phase === "over") {
    const baseHeight = Math.max(10.5, 12 / cam.aspect);
    ty = topY / 2;
    zoom = Math.min(6, Math.max(1, (topY * Math.cos(EL) + 7) / baseHeight));
    tx = 0;
    tz = 0;
  }
  const k = 1 - Math.exp(-(phase === "over" ? 2.5 : 5) * dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  cam.z += (tz - cam.z) * k;
  cam.zoom += (zoom - cam.zoom) * k;
  if (Math.abs(cam.zoom - cam.lastZoom) > 0.0005) applyFrustum();

  // the camera drifts slowly on the title and game over screens, and holds still while playing
  cam.sway += ((phase === "playing" ? 0 : 1) - cam.sway) * k;
  const az = Math.PI / 4 + 0.35 * Math.sin(animT * 0.35) * cam.sway;
  const R = 60;
  const jx = shake ? (Math.random() - 0.5) * shake : 0;
  const jy = shake ? (Math.random() - 0.5) * shake : 0;
  camera.position.set(
    cam.x + R * Math.cos(EL) * Math.sin(az) + jx,
    cam.y + R * Math.sin(EL) + jy,
    cam.z + R * Math.cos(EL) * Math.cos(az)
  );
  camera.lookAt(cam.x + jx, cam.y + jy, cam.z);

  // the sliding slab and the outline of where it should land
  if (movingMesh) {
    movingMesh.userData.level = level + 1;
    movingMesh.userData.settle = 0;
    placeMesh(movingMesh, movingSlab(state));
    target.visible = phase !== "over";
    target.scale.set(topSlab.w, THICK, topSlab.d);
    target.position.set(topSlab.x, (level + 1) * THICK + THICK / 2, topSlab.z);
  } else {
    target.visible = false;
  }

  // slabs far below the camera are not drawn while playing
  if (phase === "playing") {
    for (let i = 0; i < slabMeshes.length; i++) slabMeshes[i].visible = i >= level - 45;
  } else {
    for (let i = 0; i < slabMeshes.length; i++) slabMeshes[i].visible = i >= level - 160;
  }

  // the sky warms to a deeper night as the tower rises
  const h = Math.round(Math.min(1, level / 70) * 100) / 100;
  if (h !== skyAt) {
    skyAt = h;
    const root = document.documentElement.style;
    root.setProperty("--sky-top", mix([42, 24, 56], [14, 10, 34], h));
    root.setProperty("--sky-bottom", mix([74, 42, 76], [30, 20, 62], h));
  }

  renderer.render(scene, camera);
}

let skyAt = -1;
function mix(a, b, t) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return "rgb(" + c.join(",") + ")";
}

boot();
