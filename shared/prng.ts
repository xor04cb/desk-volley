// seed付きの自前PRNG（mulberry32）。状態は number 1つなので GameState にそのまま持てる。
export interface Rng {
  s: number;
}

export function makeRng(seed: number): Rng {
  return { s: seed >>> 0 };
}

/** 0以上1未満 */
export function rand(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randRange(r: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rand(r);
}

/** 平均0・標準偏差1に近い値（12個和の近似。三角関数を使わず環境差を避ける） */
export function randNormal(r: Rng): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand(r);
  return s - 6;
}

/** 半径 radius の円内の一様な点（三角関数を使わない棄却法） */
export function randInCircle(r: Rng, radius: number): { x: number; z: number } {
  for (let i = 0; i < 16; i++) {
    const x = rand(r) * 2 - 1;
    const z = rand(r) * 2 - 1;
    if (x * x + z * z <= 1) return { x: x * radius, z: z * radius };
  }
  return { x: 0, z: 0 };
}
