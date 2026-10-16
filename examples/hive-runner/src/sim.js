// Hive Runner rules. This file decides the score and nothing else.
//
// No DOM, no DegenHive calls, no Math.random, Date or performance.now, and no
// Math.sin, cos, pow or exp. All randomness comes from the seeded generator in
// state.rand. Same seed + same inputs + same step size => same score.
//
// The bee flies up the screen. The world scrolls down toward it. Wasps hurt,
// honey scores.

export const WORLD = { w: 360, h: 640 };
export const MAX_SCORE = 100000; // keep equal to scoring.maxScore in game.json
export const BEE = { y: 520, r: 9, maxVx: 480 };
export const WASP_R = 12;
export const HONEY_R = 11;
export const COMBO_MAX = 5;
export const COMBO_SECONDS = 2.5;
export const SHIELD_EVERY = 10; // honey needed for a shield

const PX_PER_POINT = 25; // scroll distance worth one point
const SLOTS = 9; // wall columns
const SLOT_X = 20;
const SLOT_DX = 40;

export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function init(seed, random = mulberry32(seed)) {
  return {
    rand: random,
    t: 0,
    level: 0,
    dist: 0, // pixels scrolled
    speed: 140,
    bee: { x: WORLD.w / 2, vx: 0 },
    wasps: [],
    honey: [],
    spawnDist: 260, // scroll distance until the next pattern
    trailDist: 520, // scroll distance until the next honey trail
    gap: 4, // slot of the last wall gap, so walls stay reachable
    calm: false, // after a wall, the next pattern is honey only
    combo: 1,
    comboTimer: 0,
    honeyCount: 0,
    honeyPts: 0,
    shield: false,
    invuln: 0,
    over: false,
    events: [], // for sound and particles. game.js empties it.
  };
}

export function scrollSpeed(t) {
  return Math.min(140 + 4.5 * t, 400);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Triangle wave in [-1, 1], eased so the turns are round (no trig needed).
function wave(p) {
  const tri = 4 * Math.abs(p - Math.floor(p + 0.5)) - 1;
  return 1.5 * tri - 0.5 * tri * tri * tri;
}

// input: { dir: -1 | 0 | 1, target: number | null }
export function step(state, input, dt) {
  if (state.over) return;
  state.t += dt;
  state.speed = scrollSpeed(state.t);
  state.dist += state.speed * dt;
  state.invuln = Math.max(0, state.invuln - dt);

  const level = Math.min(6, Math.floor(state.t / 15));
  if (level !== state.level) {
    state.level = level;
    state.events.push({ type: "level", level });
  }

  moveBee(state, input, dt);

  // patterns appear at a fixed scroll distance, so they stay fair as speed rises
  state.spawnDist -= state.speed * dt;
  if (state.spawnDist <= 0) {
    spawnPattern(state);
    state.spawnDist += Math.max(230, 420 - 3.2 * state.t);
  }
  state.trailDist -= state.speed * dt;
  if (state.trailDist <= 0) {
    spawnTrail(state, -40);
    state.trailDist += 900 + state.rand() * 500;
  }

  moveWasps(state, dt);
  moveHoney(state, dt);

  if (state.combo > 1) {
    state.comboTimer -= dt;
    if (state.comboTimer <= 0) {
      state.combo = 1;
      state.events.push({ type: "comboLost" });
    }
  }
}

function moveBee(state, input, dt) {
  const bee = state.bee;
  let want = 0;
  if (input.dir) {
    want = input.dir * BEE.maxVx;
  } else if (input.target !== null && input.target !== undefined) {
    want = clamp((input.target - bee.x) * 10, -BEE.maxVx, BEE.maxVx);
  }
  bee.vx += (want - bee.vx) * Math.min(1, 16 * dt);
  bee.x += bee.vx * dt;
  const lo = BEE.r + 4;
  const hi = WORLD.w - BEE.r - 4;
  if (bee.x < lo || bee.x > hi) {
    bee.x = clamp(bee.x, lo, hi);
    bee.vx = 0;
  }
}

function moveWasps(state, dt) {
  const bee = state.bee;
  for (let i = state.wasps.length - 1; i >= 0; i--) {
    const w = state.wasps[i];
    w.y += state.speed * w.mul * dt;
    if (w.kind === "weave") {
      w.ph += w.freq * dt;
      w.x = w.cx + w.amp * wave(w.ph);
    } else if (w.kind === "chase" && w.y < BEE.y - 150) {
      const reach = 85 * dt;
      w.x += clamp(bee.x - w.x, -reach, reach);
    }

    if (w.y > WORLD.h + 40) {
      state.wasps.splice(i, 1);
      continue;
    }
    if (state.invuln > 0) continue;

    const dx = w.x - bee.x;
    const dy = w.y - BEE.y;
    const reach = WASP_R + BEE.r;
    if (dx * dx + dy * dy < reach * reach) {
      if (state.shield) {
        state.shield = false;
        state.invuln = 1;
        state.events.push({ type: "shieldBreak", x: w.x, y: w.y });
        state.wasps.splice(i, 1);
      } else {
        state.over = true;
        state.events.push({ type: "hit", x: bee.x, y: BEE.y });
        state.events.push({ type: "over" });
        return;
      }
    }
  }
}

function moveHoney(state, dt) {
  const bee = state.bee;
  for (let i = state.honey.length - 1; i >= 0; i--) {
    const h = state.honey[i];
    h.y += state.speed * dt;
    if (h.y > WORLD.h + 30) {
      state.honey.splice(i, 1);
      continue;
    }
    const dx = h.x - bee.x;
    const dy = h.y - BEE.y;
    const reach = HONEY_R + BEE.r + 4;
    if (dx * dx + dy * dy < reach * reach) {
      collect(state, h);
      state.honey.splice(i, 1);
    }
  }
}

function collect(state, h) {
  const pts = 2 * state.combo;
  state.honeyPts += pts;
  state.honeyCount += 1;
  state.events.push({ type: "honey", x: h.x, y: h.y, pts, combo: state.combo });
  state.combo = Math.min(COMBO_MAX, state.combo + 1);
  state.comboTimer = COMBO_SECONDS;

  if (state.honeyCount % SHIELD_EVERY === 0) {
    if (state.shield) {
      state.honeyPts += 15;
    } else {
      state.shield = true;
      state.events.push({ type: "shieldUp" });
    }
  }
}

// ---- patterns ----------------------------------------------------------------

function addWasp(state, kind, x, mulBase, extra) {
  state.wasps.push({ kind, x, y: -30, mul: mulBase, cx: x, amp: 0, ph: 0, freq: 0, ...extra });
}

function addHoney(state, x, y) {
  state.honey.push({ x: clamp(x, 22, WORLD.w - 22), y });
}

function spawnPattern(state) {
  const rand = state.rand;
  const lvl = state.level;

  if (state.calm) {
    state.calm = false;
    spawnTrail(state, -30);
    return;
  }

  const pool = ["single", "single", "single", "pair", "pair"];
  if (lvl >= 1) pool.push("weaver", "weaver", "wall", "wall");
  if (lvl >= 2) pool.push("chaser", "wall");
  if (lvl >= 3) pool.push("chaser", "weaver", "wall");
  const kind = pool[Math.floor(rand() * pool.length)];

  if (kind === "single") {
    addWasp(state, "dive", 24 + rand() * (WORLD.w - 48), 1 + rand() * 0.25);
  } else if (kind === "pair") {
    const a = 24 + rand() * (WORLD.w - 48);
    let b = 24 + rand() * (WORLD.w - 48);
    if (Math.abs(a - b) < 80) b = a < WORLD.w / 2 ? a + 80 : a - 80;
    const mul = 1 + rand() * 0.2;
    addWasp(state, "dive", a, mul);
    addWasp(state, "dive", b, mul);
  } else if (kind === "weaver") {
    addWasp(state, "weave", 0, 1, {
      cx: 100 + rand() * 160,
      amp: 60 + rand() * 30,
      freq: 0.55 + rand() * 0.3,
      ph: rand(),
    });
  } else if (kind === "chaser") {
    addWasp(state, "chase", 24 + rand() * (WORLD.w - 48), 1.15);
  } else {
    spawnWall(state);
  }

  if (kind !== "wall" && rand() < 0.5) {
    addHoney(state, 30 + rand() * (WORLD.w - 60), -170);
  }
}

function spawnWall(state) {
  const rand = state.rand;
  const width = state.level >= 3 && rand() < 0.5 ? 1 : 2; // gap width in columns
  const g = clamp(state.gap + Math.floor(rand() * 7) - 3, 1, SLOTS - 1 - width);
  state.gap = g;
  for (let i = 0; i < SLOTS; i++) {
    if (i < g || i >= g + width) addWasp(state, "dive", SLOT_X + i * SLOT_DX, 1);
  }
  addHoney(state, SLOT_X + (g + (width - 1) / 2) * SLOT_DX, -30);
  state.calm = true;
}

function spawnTrail(state, y0) {
  const rand = state.rand;
  const arc = rand() < 0.5;
  const dir = rand() < 0.5 ? -1 : 1;
  const x0 = 70 + rand() * (WORLD.w - 140);
  for (let i = 0; i < 5; i++) {
    const u = (i - 2) / 2; // -1 .. 1
    const x = arc ? x0 + dir * 55 * (1 - u * u) : x0 + dir * (i - 2) * 34;
    addHoney(state, x, y0 - i * 62);
  }
}

export function isOver(state) {
  return state.over;
}

// A whole number from 0 to MAX_SCORE.
export function score(state) {
  const distance = Math.floor(state.dist / PX_PER_POINT);
  return Math.min(MAX_SCORE, Math.max(0, distance + state.honeyPts));
}
