// コート上の座標変換・フォーメーション
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH, EARLY_GRACE, JUDGE, PLAYER_MIN_NET_DIST, SERVE_BEHIND_END } from './constants.ts';
import type { ContactKind, GameState, Judgment, Player, TeamId } from './types.ts';

/** チームから見た座標（lx=右+、lz=ネットからの距離）→ ワールド座標 */
export function toWorld(team: TeamId, lx: number, lz: number): { x: number; z: number } {
  return team === 0 ? { x: lx, z: lz } : { x: -lx, z: -lz };
}

/** ワールド座標 → チームから見た座標 */
export function toLocal(team: TeamId, x: number, z: number): { lx: number; lz: number } {
  return team === 0 ? { lx: x, lz: z } : { lx: -x, lz: -z };
}

/** ポジション番号（1〜6）。1=後衛右（サーバー）、2=前衛右、3=前衛中央、4=前衛左、5=後衛左、6=後衛中央 */
export function positionOf(state: GameState, p: Player): number {
  const rot = state.teams[p.team].rotation;
  return ((((p.slot - rot) % 6) + 6) % 6) + 1;
}

export const isFrontRow = (pos: number): boolean => pos >= 2 && pos <= 4;

export function playerAtPosition(state: GameState, team: TeamId, pos: number): Player {
  return state.players.find((p) => p.team === team && positionOf(state, p) === pos)!;
}

type Spot = readonly [number, number];
/** 基本の守備位置（lx, lz） */
export const FORMATION: Record<'base' | 'receive' | 'defense' | 'offense', Record<number, Spot>> = {
  base: { 1: [3, 7], 2: [3, 2], 3: [0, 2], 4: [-3, 2], 5: [-3, 7], 6: [0, 7] },
  receive: { 1: [3, 7.2], 2: [2.6, 4.2], 3: [0, 2.5], 4: [-2.6, 4.2], 5: [-3, 7.2], 6: [0, 7.6] },
  // 相手の攻撃に備える：前衛はネット際、後衛は下がる
  defense: { 1: [3, 6.5], 2: [3, 1.0], 3: [0, 1.0], 4: [-3, 1.0], 5: [-3, 6.5], 6: [0, 7.6] },
  // 自チームの攻撃：前衛は助走の位置へ
  offense: { 1: [3, 6.8], 2: [3.3, 3.6], 3: [0, 3.2], 4: [-3.3, 3.6], 5: [-3, 6.8], 6: [0, 7.4] },
};

export function serveSpot(team: TeamId, lx = 2.5): { x: number; z: number } {
  return toWorld(team, lx, COURT_HALF_LENGTH + SERVE_BEHIND_END);
}

/** 選手が動ける範囲に収める */
export function clampToSide(p: Player, serving: boolean): void {
  const { lx, lz } = toLocal(p.team, p.x, p.z);
  const minZ = serving ? COURT_HALF_LENGTH + 0.2 : PLAYER_MIN_NET_DIST;
  const maxZ = COURT_HALF_LENGTH + 3;
  const cx = Math.max(-COURT_HALF_WIDTH - 2.5, Math.min(COURT_HALF_WIDTH + 2.5, lx));
  const cz = Math.max(minZ, Math.min(maxZ, lz));
  const w = toWorld(p.team, cx, cz);
  p.x = w.x;
  p.z = w.z;
}

/** タイミングのずれ（秒、負=早い）から評価を出す。レシーブ・トスは早めに離したときに甘くする */
export function judgeOf(dt: number, kind?: ContactKind): Judgment {
  const early = (kind && EARLY_GRACE[kind]) || 0;
  const a = dt < 0 ? Math.max(0, -dt - early) : dt;
  if (a <= JUDGE.PERFECT) return 'PERFECT';
  if (a <= JUDGE.GOOD) return 'GOOD';
  if (a <= JUDGE.BAD) return 'BAD';
  return 'MISS';
}
