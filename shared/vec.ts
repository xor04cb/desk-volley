export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy3 = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const dist3 = (a: Vec3, b: Vec3): number =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
export const dist2 = (ax: number, az: number, bx: number, bz: number): number =>
  Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
