// Hive Runner: screens, input, sound, drawing and the DegenHive SDK calls.
// The rules and the score are in sim.js.

import {
  WORLD, BEE, HONEY_R, SHIELD_EVERY, COMBO_SECONDS,
  init, step, score, isOver,
} from "./sim.js";

const dh = window.DegenHive;
const STEP = 1 / 60; // the simulation always advances in steps of this size
const TAU = Math.PI * 2;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ctx = canvas.getContext("2d");
const ui = {
  hud: $("hud"), score: $("score"), combo: $("combo"), comboText: $("combo-text"), comboBar: $("combo-bar"),
  meter: $("meter"), badge: $("badge"), toast: $("toast"),
  title: $("title"), over: $("over"), paused: $("paused"),
  bestTitle: $("best-title"), bestOver: $("best-over"), newBest: $("new-best"),
  final: $("final"), stats: $("stats"), note: $("note"),
};
const pips = [];
for (let i = 0; i < SHIELD_EVERY; i++) {
  const pip = document.createElement("i");
  ui.meter.appendChild(pip);
  pips.push(pip);
}

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
let sim = null;
let acc = 0; // time not yet simulated
let lastFrame = null;
let animT = 0; // seconds, for animation only
let idleDist = 0; // background scroll on the title screen
let shake = 0;
let flash = 0;
let trailTimer = 0;
let particles = [];
let texts = [];
const input = { dir: 0, target: null };
const drag = { id: null, startX: 0, beeX: 0 };

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

  makeLayers();
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
  texts = [];
  shake = 0;
  flash = 0;
  input.target = null;
  drag.id = null;
  phase = "playing";
  ui.paused.hidden = !paused; // a pause that arrived while the run was starting
  ui.title.hidden = true;
  ui.over.hidden = true;
  ui.hud.hidden = false;
  tone(392, 0.09, "triangle", 0.12, 784);
  startBuzz();
  updateHud(true);
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
  readyAt = performance.now() + 900; // the screen appears after the sting animation
  setTimeout(() => {
    if (phase !== "over") return;
    ui.hud.hidden = true;
    ui.final.textContent = final;
    ui.bestOver.textContent = best;
    ui.bestTitle.textContent = best;
    ui.newBest.hidden = !wasBest;
    ui.stats.textContent = sim.honeyCount + " honey, " + Math.floor(sim.t) + " s";
    ui.over.hidden = false;
  }, 800);
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

// ---- HUD -----------------------------------------------------------------

let shownScore = -1;
function updateHud(force) {
  const s = score(sim);
  if (s !== shownScore || force) {
    shownScore = s;
    ui.score.textContent = s;
  }
  const filled = sim.shield ? SHIELD_EVERY : sim.honeyCount % SHIELD_EVERY;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle("on", i < filled);
  ui.meter.classList.toggle("shielded", sim.shield);

  const chain = sim.combo > 1;
  ui.combo.hidden = !chain;
  if (chain) {
    ui.comboText.textContent = "x" + sim.combo;
    ui.comboBar.style.transform = "scaleX(" + Math.max(0, sim.comboTimer / COMBO_SECONDS).toFixed(3) + ")";
  }
}

function popScore() {
  ui.score.classList.remove("pop");
  void ui.score.offsetWidth; // restart the animation
  ui.score.classList.add("pop");
}

// ---- input ---------------------------------------------------------------

function tryStart() {
  if (phase === "title" || (phase === "over" && performance.now() > readyAt)) startRun();
}

function worldX(e) {
  const r = canvas.getBoundingClientRect();
  return (e.clientX - r.left - view.ox) / view.scale;
}

// Pointer events cover mouse, touch and pen. They are on window so a drag that
// started on a screen overlay keeps steering after the overlay is hidden.
// A mouse steers the bee to its position. A finger moves the bee by how far it
// drags, so the finger does not hide the bee.
window.addEventListener("pointerdown", (e) => {
  window.focus(); // a game iframe starts without keyboard focus
  unlockAudio();
  if (phase !== "playing") return tryStart();
  if (paused) return;
  if (e.pointerType === "mouse") input.target = worldX(e);
  else beginDrag(e);
});
window.addEventListener("pointermove", (e) => {
  if (phase !== "playing" || paused) return;
  if (e.pointerType === "mouse") input.target = worldX(e);
  else if (drag.id === null) beginDrag(e);
  else if (e.pointerId === drag.id) input.target = drag.beeX + (worldX(e) - drag.startX);
});
function endDrag(e) {
  if (e.pointerId === drag.id) {
    drag.id = null;
    input.target = null; // the bee glides to a stop
  }
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

function beginDrag(e) {
  drag.id = e.pointerId;
  drag.startX = worldX(e);
  drag.beeX = sim.bee.x;
  input.target = sim.bee.x;
}

const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
  unlockAudio();
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

// ---- sound (synthesized, no files) -----------------------------------------

let audio = null;
let buzz = null;
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
function honeyNote(combo) {
  const semis = PENTATONIC[(combo - 1) % 5] + 12 * Math.floor((combo - 1) / 5);
  const f = 523 * Math.pow(2, semis / 12);
  tone(f, 0.14, "triangle", 0.16);
  tone(f * 2, 0.1, "sine", 0.06, f * 2, 0.04);
}

function startBuzz() {
  unlockAudio();
  if (buzz) return;
  const osc = audio.createOscillator();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 140;
  filter.type = "lowpass";
  filter.frequency.value = 520;
  gain.gain.value = 0;
  osc.connect(filter).connect(gain).connect(audio.destination);
  osc.start();
  buzz = { osc, gain };
}

function updateBuzz(on) {
  if (!buzz) return;
  const t = audio.currentTime;
  buzz.gain.gain.setTargetAtTime(on && !muted ? 0.028 : 0, t, 0.08);
  if (sim) buzz.osc.frequency.setTargetAtTime(130 + sim.speed * 0.1, t, 0.15);
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
        step(sim, input, STEP);
        acc -= STEP;
      }
      handleEvents();
      updateHud(false);
      emitTrail(dt);
      if (isOver(sim)) endRun();
    } else if (phase === "title") {
      idleDist += 90 * dt;
    }
    updateFx(dt);
  }
  updateBuzz(phase === "playing" && !paused);
  draw();
}

function handleEvents() {
  for (const ev of sim.events) {
    if (ev.type === "honey") {
      honeyNote(ev.combo);
      sparkle(ev.x, ev.y, 8, "#ffc247");
      floatText(ev.x, ev.y - 14, "+" + ev.pts, ev.combo > 2 ? "#fff0b8" : "#ffc247");
      popScore();
    } else if (ev.type === "shieldUp") {
      [0, 4, 7, 12].forEach((s, i) => tone(440 * Math.pow(2, s / 12), 0.16, "triangle", 0.12, undefined, i * 0.06));
      ring(sim.bee.x, BEE.y, "#fff3c4");
      floatText(sim.bee.x, BEE.y - 36, "Shield", "#fff3c4");
    } else if (ev.type === "shieldBreak") {
      noise(0.3, 0.22, 3000);
      tone(500, 0.25, "square", 0.08, 120);
      sparkle(ev.x, ev.y, 14, "#fff3c4");
      sparkle(ev.x, ev.y, 10, "#d6e03a");
      ring(sim.bee.x, BEE.y, "#fff3c4");
      addShake(7);
    } else if (ev.type === "hit") {
      noise(0.5, 0.3, 2400);
      tone(260, 0.5, "sawtooth", 0.14, 40);
      sparkle(ev.x, ev.y, 22, "#ffc247");
      sparkle(ev.x, ev.y, 14, "#2b1a16");
      addShake(14);
      if (!reduceMotion) flash = 0.5;
    } else if (ev.type === "level") {
      if (ev.level > 0) {
        floatText(WORLD.w / 2, 190, "Faster", "#f6ecd9");
        tone(300, 0.2, "sine", 0.08, 600);
      }
    }
  }
  sim.events.length = 0;
}

function addShake(amount) {
  if (!reduceMotion) shake = Math.max(shake, amount);
}

// ---- particles ---------------------------------------------------------------

function sparkle(x, y, count, color) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const v = 50 + Math.random() * 190;
    const life = 0.35 + Math.random() * 0.4;
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life, max: life,
      size: 1.5 + Math.random() * 3, color, grav: 260, ring: false,
    });
  }
}

function ring(x, y, color) {
  particles.push({ x, y, vx: 0, vy: 0, life: 0.45, max: 0.45, size: 12, color, grav: 0, ring: true });
}

function floatText(x, y, text, color) {
  texts.push({ x, y, text, color, life: 0.8, max: 0.8 });
}

function emitTrail(dt) {
  trailTimer -= dt;
  if (trailTimer > 0 || sim.over) return;
  trailTimer = 0.05;
  particles.push({
    x: sim.bee.x + (Math.random() - 0.5) * 6, y: BEE.y + 12, vx: (Math.random() - 0.5) * 20, vy: 60 + sim.speed * 0.3,
    life: 0.3, max: 0.3, size: 1.6, color: "#ffc247", grav: 0, ring: false,
  });
}

function updateFx(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.grav * dt;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const t of texts) {
    t.life -= dt;
    t.y -= 38 * dt;
  }
  texts = texts.filter((t) => t.life > 0);
  shake = Math.max(0, shake - dt * 40);
  flash = Math.max(0, flash - dt * 2.4);
}

// ---- drawing -------------------------------------------------------------

const view = { w: 0, h: 0, dpr: 1, scale: 1, ox: 0, oy: 0 };
let layers = [];
let vignette = null;

// The play field is WORLD.w x WORLD.h units, fitted into whatever size the
// iframe has and centered. The honeycomb background fills the rest.
function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = canvas.clientWidth;
  view.h = canvas.clientHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  view.scale = Math.min(view.w / WORLD.w, view.h / WORLD.h);
  view.ox = (view.w - WORLD.w * view.scale) / 2;
  view.oy = (view.h - WORLD.h * view.scale) / 2;

  const g = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.35, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
  g.addColorStop(0, "rgba(10, 6, 16, 0)");
  g.addColorStop(1, "rgba(10, 6, 16, 0.55)");
  vignette = g;
}

function hexPath(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * TAU) / 6;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

// A tile of honeycomb that repeats seamlessly. w x h are whole pixels, h = 2 rows.
function makeTile(w, h, color, lineWidth, scroll) {
  const c = document.createElement("canvas");
  c.width = w * 2;
  c.height = h * 2;
  const g = c.getContext("2d");
  g.scale(2, 2);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  const r = w / Math.sqrt(3);
  for (let row = -1; row <= 3; row++) {
    for (let col = -1; col <= 2; col++) {
      hexPath(g, col * w + (Math.abs(row) % 2 ? w / 2 : 0), row * (h / 2), r);
      g.stroke();
    }
  }
  const pattern = ctx.createPattern(c, "repeat");
  pattern.setTransform(new DOMMatrix().scale(0.5));
  return { pattern, h, scroll };
}

function makeLayers() {
  layers = [
    makeTile(78, 135, "rgba(255, 194, 71, 0.04)", 2, 0.25),
    makeTile(52, 90, "rgba(255, 194, 71, 0.06)", 1.5, 0.6),
  ];
}

function draw() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = "#1b1324";
  ctx.fillRect(0, 0, view.w, view.h);

  const sx = shake ? (Math.random() - 0.5) * shake : 0;
  const sy = shake ? (Math.random() - 0.5) * shake : 0;
  ctx.translate(view.ox + sx * view.scale, view.oy + sy * view.scale);
  ctx.scale(view.scale, view.scale);

  const dist = sim && phase !== "title" ? sim.dist : idleDist;

  // honeycomb, parallax, covering the whole canvas
  const x0 = -(view.ox + sx * view.scale) / view.scale;
  const y0 = -(view.oy + sy * view.scale) / view.scale;
  const vw = view.w / view.scale;
  const vh = view.h / view.scale;
  for (const layer of layers) {
    ctx.save();
    ctx.translate(0, (dist * layer.scroll) % layer.h);
    ctx.fillStyle = layer.pattern;
    ctx.fillRect(x0, y0 - layer.h, vw, vh + layer.h);
    ctx.restore();
  }

  // the field
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  ctx.fillStyle = "rgba(255, 194, 71, 0.22)";
  ctx.fillRect(-1, y0, 2, vh);
  ctx.fillRect(WORLD.w - 1, y0, 2, vh);

  if (sim && phase !== "title") {
    for (const h of sim.honey) drawHoney(h);
    for (const w of sim.wasps) drawWasp(w);
  }

  // the bee
  if (!(sim && sim.over && phase !== "title")) {
    const x = sim && phase !== "title" ? sim.bee.x : WORLD.w / 2;
    const bob = phase === "playing" ? 0 : Math.sin(animT * 3) * 6;
    const tilt = sim && phase === "playing" ? Math.max(-0.4, Math.min(0.4, sim.bee.vx / 1200)) : 0;
    const blink = sim && sim.invuln > 0 && Math.floor(animT * 16) % 2 === 0;
    if (!blink) drawBee(x, BEE.y + bob, tilt);
    if (sim && sim.shield && phase === "playing") drawShield(x, BEE.y);
  }

  drawFx();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, view.w, view.h);
  if (flash > 0) {
    ctx.fillStyle = "rgba(255, 255, 255, " + flash + ")";
    ctx.fillRect(0, 0, view.w, view.h);
  }
}

function drawBee(x, y, tilt) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(1.25, 1.25);

  const flap = 0.55 + 0.45 * Math.sin(animT * 70);
  ctx.fillStyle = "rgba(225, 240, 255, 0.6)";
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * 5, -2);
    ctx.rotate(s * (0.45 + 0.4 * flap));
    ctx.beginPath();
    ctx.ellipse(s * 7, 0, 9, 3 + 3 * flap, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = "#ffc247";
  ctx.beginPath();
  ctx.ellipse(0, 1, 7.5, 11, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#2b1a16";
  ctx.fillRect(-9, -1, 18, 3.2);
  ctx.fillRect(-9, 5, 18, 3.2);
  ctx.restore();

  ctx.fillStyle = "#2b1a16";
  ctx.beginPath();
  ctx.arc(0, -11, 4.6, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-1.8, 11.5);
  ctx.lineTo(1.8, 11.5);
  ctx.lineTo(0, 15);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillRect(-2.7, -13, 1.6, 1.8);
  ctx.fillRect(1.1, -13, 1.6, 1.8);
  ctx.restore();
}

const WASP_STRIPE = { dive: "#a6f032", weave: "#c77dff", chase: "#ff5a6a" };

function drawWasp(w) {
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.scale(1.25, 1.25);

  // narrow swept-back wings
  const flap = 0.5 + 0.5 * Math.sin(animT * 60 + w.x);
  ctx.fillStyle = "rgba(200, 215, 255, 0.4)";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * 8, -4, 8.5, 2.6 + 2.4 * flap, s * 0.9, 0, TAU);
    ctx.fill();
  }

  // dark body with bright warning stripes
  ctx.fillStyle = "#17131d";
  ctx.beginPath();
  ctx.ellipse(0, -1, 7, 13, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = WASP_STRIPE[w.kind];
  ctx.fillRect(-9, -9, 18, 3.4);
  ctx.fillRect(-9, -1.5, 18, 3.4);
  ctx.fillRect(-9, 6, 18, 3);
  ctx.restore();

  // head faces the bee, with red eyes and a red-tipped stinger behind
  ctx.fillStyle = "#17131d";
  ctx.beginPath();
  ctx.arc(0, 13, 5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ff3b3b";
  ctx.beginPath();
  ctx.moveTo(-4.4, 12);
  ctx.lineTo(-0.6, 14.4);
  ctx.lineTo(-3.4, 15.6);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(4.4, 12);
  ctx.lineTo(0.6, 14.4);
  ctx.lineTo(3.4, 15.6);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-2, -12);
  ctx.lineTo(2, -12);
  ctx.lineTo(0, -19);
  ctx.fillStyle = "#ff3b3b";
  ctx.fill();
  ctx.restore();
}

function drawHoney(h) {
  const pulse = 1 + 0.08 * Math.sin(animT * 6 + h.x);
  ctx.fillStyle = "rgba(255, 194, 71, 0.16)";
  ctx.beginPath();
  ctx.arc(h.x, h.y, HONEY_R + 7, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ffb52e";
  hexPath(ctx, h.x, h.y, HONEY_R * pulse);
  ctx.fill();
  ctx.fillStyle = "#ffe08a";
  hexPath(ctx, h.x - 1, h.y - 1.5, HONEY_R * pulse * 0.55);
  ctx.fill();
}

function drawShield(x, y) {
  const pulse = 1 + 0.06 * Math.sin(animT * 8);
  ctx.beginPath();
  ctx.arc(x, y, 22 * pulse, 0, TAU);
  ctx.fillStyle = "rgba(255, 243, 196, 0.12)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 243, 196, 0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawFx() {
  for (const p of particles) {
    const k = p.life / p.max;
    ctx.globalAlpha = Math.min(1, k * 1.5);
    if (p.ring) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size + (1 - k) * 40, 0, TAU);
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;

  ctx.font = "800 17px ui-rounded, system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const t of texts) {
    const k = t.life / t.max;
    ctx.globalAlpha = Math.min(1, k * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillText(t.text, t.x + 1, t.y + 2);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

boot();
