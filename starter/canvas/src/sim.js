// The game rules. This file decides the score and nothing else.
//
// Rules for this file:
//   - no DOM, no window, no DegenHive calls
//   - no Math.random, Date or performance.now: all randomness comes from the
//     seeded generator kept in `state.rand`
//   - no Math.sin, cos, pow, exp or log: engines round them differently.
//     + - * / sqrt abs min max floor are safe.
//   - same seed + same inputs + same step size => same score, in every browser
//
// game.js calls init once per run, step many times with a fixed dt, and score
// when the run is over.

export const WORLD = { w: 360, h: 640 };
export const MAX_SCORE = 10000; // keep equal to scoring.maxScore in game.json
export const PADDLE = { y: 590, w: 72, h: 14, speed: 520 };
export const ITEM_R = 12;
export const LIVES = 3;

// mulberry32, the same generator as DegenHive.random(seed). game.js passes
// DegenHive.random(seed) to init(). The copy here lets this file run alone.
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
    x: WORLD.w / 2, // paddle centre
    items: [],
    spawnIn: 0.8, // seconds until the next item
    caught: 0,
    lives: LIVES,
    over: false,
    events: [], // things that happened, for sound and particles. game.js empties it.
  };
}

// input: { dir: -1 | 0 | 1, target: number | null }
//   dir    keyboard direction
//   target x position (in world units) the paddle moves toward, or null
export function step(state, input, dt) {
  if (state.over) return;
  state.t += dt;

  // paddle
  const reach = PADDLE.speed * dt;
  if (input.dir) {
    state.x += input.dir * reach;
  } else if (input.target !== null && input.target !== undefined) {
    state.x += Math.max(-reach, Math.min(reach, input.target - state.x));
  }
  const half = PADDLE.w / 2;
  state.x = Math.max(half, Math.min(WORLD.w - half, state.x));

  // spawn: faster and quicker every 10 seconds
  const level = Math.floor(state.t / 10);
  state.spawnIn -= dt;
  if (state.spawnIn <= 0) {
    state.items.push({
      x: ITEM_R + state.rand() * (WORLD.w - 2 * ITEM_R),
      y: -ITEM_R,
      vy: Math.min(200 + level * 25, 380),
    });
    state.spawnIn += Math.max(0.35, 1.1 - level * 0.08);
  }

  // move and resolve
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    it.y += it.vy * dt;

    const hitsPaddle =
      it.y + ITEM_R >= PADDLE.y &&
      it.y - ITEM_R <= PADDLE.y + PADDLE.h &&
      Math.abs(it.x - state.x) <= half + ITEM_R;

    if (hitsPaddle) {
      state.caught += 1;
      state.events.push({ type: "catch", x: it.x, y: PADDLE.y });
      state.items.splice(i, 1);
    } else if (it.y - ITEM_R > WORLD.h) {
      state.lives -= 1;
      state.events.push({ type: "miss", x: it.x, y: WORLD.h });
      state.items.splice(i, 1);
      if (state.lives <= 0) {
        state.over = true;
        state.events.push({ type: "over" });
        return;
      }
    }
  }
}

export function isOver(state) {
  return state.over;
}

// A whole number from 0 to MAX_SCORE.
export function score(state) {
  return Math.min(MAX_SCORE, Math.max(0, Math.floor(state.caught)));
}
