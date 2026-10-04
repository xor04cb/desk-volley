// ボールの物理。描画・通信に依存しない。
import {
  BALL_RADIUS,
  COURT_HALF_WIDTH,
  DT,
  FLOOR_BOUNCE,
  G,
  NET_HEIGHT,
  NET_POST_OFFSET,
  NET_RESTITUTION,
} from './constants.ts';
import { copy3, v3, type Vec3 } from './vec.ts';

export interface Ball {
  pos: Vec3;
  vel: Vec3;
  /** held=誰かが持っている（サーブ前）、flying=飛行中、rest=床で止まった */
  mode: 'held' | 'flying' | 'rest';
  /** 最初の接地を済ませたか */
  grounded: boolean;
}

export type BallEvent =
  | { type: 'net' }
  | { type: 'cross'; toSide: 0 | 1; outside: boolean }
  | { type: 'land'; x: number; z: number };

export function makeBall(): Ball {
  return { pos: v3(0, 1, 0), vel: v3(), mode: 'held', grounded: false };
}

export function cloneBall(b: Ball): Ball {
  return { pos: copy3(b.pos), vel: copy3(b.vel), mode: b.mode, grounded: b.grounded };
}

/** z の符号からコートの側（0=手前 z>0、1=奥 z<0） */
export const sideOf = (z: number): 0 | 1 => (z >= 0 ? 0 : 1);

/**
 * 1tick進める。放物線は厳密式で積分するので、解析解（solve*）と予測が一致する。
 * 発生したイベントを返す。
 */
export function stepBall(b: Ball, out?: BallEvent[]): void {
  if (b.mode !== 'flying') return;
  const p0 = b.pos;
  const nx = p0.x + b.vel.x * DT;
  const ny = p0.y + b.vel.y * DT - 0.5 * G * DT * DT;
  const nz = p0.z + b.vel.z * DT;
  b.vel.y -= G * DT;

  // ネット（z=0 の面）をまたいだか
  if ((p0.z > 0 && nz <= 0) || (p0.z < 0 && nz >= 0)) {
    const f = p0.z / (p0.z - nz);
    const cx = p0.x + (nx - p0.x) * f;
    const cy = p0.y + (ny - p0.y) * f;
    const withinNet = Math.abs(cx) <= COURT_HALF_WIDTH + NET_POST_OFFSET;
    if (withinNet && cy - BALL_RADIUS < NET_HEIGHT) {
      // ネット上端より低い → 跳ね返す
      const s = p0.z > 0 ? 1 : -1;
      b.pos = { x: nx, y: ny, z: s * BALL_RADIUS };
      b.vel.z = -b.vel.z * NET_RESTITUTION;
      b.vel.x *= 0.6;
      out?.push({ type: 'net' });
      floorCheck(b, p0, out);
      return;
    }
    out?.push({ type: 'cross', toSide: nz <= 0 ? 1 : 0, outside: Math.abs(cx) > COURT_HALF_WIDTH });
  }

  b.pos = { x: nx, y: ny, z: nz };
  floorCheck(b, p0, out);
}

function floorCheck(b: Ball, prev: Vec3, out?: BallEvent[]): void {
  if (b.pos.y > BALL_RADIUS) return;
  if (!b.grounded) {
    b.grounded = true;
    // tickの途中で接地した位置を補間する（速い打球でも接地点がずれないように）
    const dy = prev.y - b.pos.y;
    const f = dy > 1e-9 ? Math.min(Math.max((prev.y - BALL_RADIUS) / dy, 0), 1) : 1;
    const lx = prev.x + (b.pos.x - prev.x) * f;
    const lz = prev.z + (b.pos.z - prev.z) * f;
    b.pos.x = lx;
    b.pos.z = lz;
    out?.push({ type: 'land', x: lx, z: lz });
  }
  b.pos.y = BALL_RADIUS;
  if (b.vel.y < 0) b.vel.y = -b.vel.y * FLOOR_BOUNCE;
  b.vel.x *= 0.6;
  b.vel.z *= 0.6;
  if (b.vel.y < 0.8) {
    b.vel = v3();
    b.mode = 'rest';
  }
}

/** 発射：ボールを from に置き、速度 vel で飛ばす */
export function launch(b: Ball, from: Vec3, vel: Vec3): void {
  b.pos = copy3(from);
  b.vel = copy3(vel);
  b.mode = 'flying';
  b.grounded = false;
}

/**
 * 「目標地点と最高点の高さ」から初速を逆算する。
 * 目標地点は高さ targetY で到達する点（既定は床＝ボール半径）。
 */
export function solveByApex(from: Vec3, toX: number, toZ: number, apexY: number, targetY = BALL_RADIUS): Vec3 {
  const apex = Math.max(apexY, from.y + 0.05, targetY + 0.05);
  const vy = Math.sqrt(2 * G * (apex - from.y));
  const t1 = vy / G;
  const t2 = Math.sqrt((2 * (apex - targetY)) / G);
  const T = t1 + t2;
  return { x: (toX - from.x) / T, y: vy, z: (toZ - from.z) / T };
}

/** 水平速度を指定して、目標地点に届く初速を逆算する（スパイク用。下向きにもなる） */
export function solveBySpeed(from: Vec3, toX: number, toZ: number, hSpeed: number, targetY = BALL_RADIUS): Vec3 {
  const dx = toX - from.x;
  const dz = toZ - from.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const T = Math.max(d / hSpeed, 0.05);
  const vy = (targetY - from.y + 0.5 * G * T * T) / T;
  return { x: dx / T, y: vy, z: dz / T };
}

export interface Prediction {
  /** 各tickのボール位置（path[0] は1tick後） */
  path: Vec3[];
  /** 最初に接地するまでのtick数（接地しなければ -1） */
  landTicks: number;
  landX: number;
  landZ: number;
}

/** ボールの軌道を予測する（ネットとの衝突も含む。ブロックは含まない） */
export function predict(b: Ball, maxTicks = 360): Prediction {
  const sim = cloneBall(b);
  const path: Vec3[] = [];
  const ev: BallEvent[] = [];
  for (let i = 0; i < maxTicks && sim.mode === 'flying'; i++) {
    ev.length = 0;
    stepBall(sim, ev);
    path.push(copy3(sim.pos));
    for (const e of ev) {
      if (e.type === 'land') return { path, landTicks: i + 1, landX: e.x, landZ: e.z };
    }
  }
  return { path, landTicks: -1, landX: sim.pos.x, landZ: sim.pos.z };
}
