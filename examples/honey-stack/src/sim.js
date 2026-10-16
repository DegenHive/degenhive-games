// Honey Stack rules. This file decides the score and nothing else.
//
// No DOM, no DegenHive calls, no Math.random, Date or performance.now, and no
// Math.sin, cos, pow or exp. All randomness comes from the seeded generator in
// state.rand. Same seed + same inputs + same step size => same score.
//
// A slab slides back and forth over the tower. A drop places it. Whatever
// hangs over the edge is cut off, so the next slab is smaller. A drop that
// lines up almost exactly is "perfect": nothing is cut, and after three in a
// row the slab grows back a little.
//
// Units: x and z are the slab centre, w is the size along x, d along z.

export const BASE = 3; // size of the first slab
export const THICK = 0.5; // height of a slab (used for drawing only)
export const RANGE = 4.6; // how far a slab slides to each side of the tower
export const PERFECT = 0.12; // a drop this close to centre is perfect
export const GROW = 0.2; // size gained back on a perfect streak
export const DROP_DELAY = 0.15; // seconds after a slab appears before it can be dropped
export const MAX_SCORE = 5000; // keep equal to scoring.maxScore in game.json

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
  const state = {
    rand: random,
    t: 0,
    slabs: [{ x: 0, z: 0, w: BASE, d: BASE }], // slabs[0] is the base
    moving: null,
    cooldown: 0.3, // the tap that starts a run must not also drop a slab
    streak: 0, // perfect drops in a row
    points: 0,
    over: false,
    events: [], // for sound and particles. game.js empties it.
  };
  spawn(state);
  return state;
}

export function top(state) {
  return state.slabs[state.slabs.length - 1];
}

// Where the sliding slab is right now.
export function movingSlab(state) {
  const base = top(state);
  const m = state.moving;
  return {
    x: m.axis === 0 ? base.x + m.off : base.x,
    z: m.axis === 1 ? base.z + m.off : base.z,
    w: base.w,
    d: base.d,
  };
}

function slideSpeed(level) {
  return 3 + 0.045 * Math.min(level, 50);
}

function spawn(state) {
  const level = state.slabs.length - 1;
  const fromLeft = state.rand() < 0.5;
  state.moving = {
    axis: level % 2, // the slab alternates between sliding along x and along z
    off: fromLeft ? -RANGE : RANGE,
    dir: fromLeft ? 1 : -1,
    speed: slideSpeed(level) * (0.92 + state.rand() * 0.16),
  };
  state.cooldown = Math.max(state.cooldown, DROP_DELAY);
}

// input: { drop: boolean }, true for the one step in which the player dropped
export function step(state, input, dt) {
  if (state.over) return;
  state.t += dt;
  state.cooldown = Math.max(0, state.cooldown - dt);

  const m = state.moving;
  m.off += m.dir * m.speed * dt;
  if (m.off > RANGE) {
    m.off = 2 * RANGE - m.off;
    m.dir = -1;
  } else if (m.off < -RANGE) {
    m.off = -2 * RANGE - m.off;
    m.dir = 1;
  }

  if (input.drop && state.cooldown === 0) place(state);
}

function place(state) {
  const base = top(state);
  const m = state.moving;
  const size = m.axis === 0 ? base.w : base.d;
  const delta = m.off;
  const gap = Math.abs(delta);
  const sliding = movingSlab(state);

  if (gap >= size) {
    state.over = true;
    state.events.push({ type: "miss", index: state.slabs.length, slab: sliding });
    state.events.push({ type: "over" });
    return;
  }

  let { x, z, w, d } = base;
  let perfect = false;
  if (gap <= PERFECT) {
    perfect = true;
    state.streak += 1;
    if (state.streak >= 3) {
      w = Math.min(BASE, w + GROW);
      d = Math.min(BASE, d + GROW);
    }
    state.points += 2;
  } else {
    state.streak = 0;
    const sign = delta < 0 ? -1 : 1;
    const kept = size - gap;
    if (m.axis === 0) {
      state.events.push({ type: "trim", index: state.slabs.length, slab: { x: base.x + sign * (size / 2 + gap / 2), z: base.z, w: gap, d: base.d } });
      x = base.x + delta / 2;
      w = kept;
    } else {
      state.events.push({ type: "trim", index: state.slabs.length, slab: { x: base.x, z: base.z + sign * (size / 2 + gap / 2), w: base.w, d: gap } });
      z = base.z + delta / 2;
      d = kept;
    }
    state.points += 1;
  }

  const slab = { x, z, w, d };
  state.slabs.push(slab);
  state.events.push({ type: "place", index: state.slabs.length - 1, perfect, streak: state.streak, slab });

  if (state.points >= MAX_SCORE) {
    state.over = true;
    state.events.push({ type: "over" });
    return;
  }
  spawn(state);
}

export function isOver(state) {
  return state.over;
}

// A whole number from 0 to MAX_SCORE.
export function score(state) {
  return Math.min(MAX_SCORE, Math.max(0, Math.floor(state.points)));
}
