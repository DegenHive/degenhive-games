/** mulberry32. Returns floats in [0, 1). Same seed, same sequence, in every browser. */
export function mulberry32(seed: number): () => number {
  if (typeof seed !== "number" || !isFinite(seed)) {
    throw new TypeError("DegenHive.random(seed) needs a finite number");
  }
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
