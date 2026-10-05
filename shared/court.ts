// コート上の座標変換・フォーメーション
import { COURT_HALF_LENGTH, COURT_HALF_WIDTH, EARLY_GRACE, JUDGE, JUDGE_SCALE, PLAYER_MIN_NET_DIST, SERVE_BEHIND_END } from './constants.ts';
import type { ContactKind, DefenseFormation, GameState, Judgment, Player, ReceiveFormation, Role, RotationSystem, TeamId } from './types.ts';

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

/**
 * ローテシステムごとの役割（slot 0〜5 の順。ローテーション0で slot k がポジション k+1）。
 * 向かい合う（3つ離れた）2人が同じ組になるので、前衛・後衛にはいつも各組1人ずつ入る
 */
const LINEUP: Record<Exclude<RotationSystem, 'none'>, Role[]> = {
  '5-1': ['S', 'OH', 'MB', 'OP', 'OH', 'MB'],
  '4-2': ['S', 'OH', 'MB', 'S', 'OH', 'MB'],
  '6-2': ['S', 'OH', 'MB', 'S', 'OH', 'MB'],
};

/** 役割（ローテシステムが none なら null） */
export function roleOf(state: GameState, p: Player): Role | null {
  const sys = state.rules.system;
  return sys === 'none' ? null : LINEUP[sys][p.slot];
}

/** トスを上げるセッター。5-1は1人、4-2は前衛のS、6-2は後衛のS（none なら null） */
export function setterOf(state: GameState, team: TeamId): Player | null {
  const sys = state.rules.system;
  if (sys === 'none') return null;
  const setters = state.players.filter((p) => p.team === team && roleOf(state, p) === 'S');
  if (sys === '5-1') return setters[0] ?? null;
  return setters.find((p) => isFrontRow(positionOf(state, p)) === (sys === '4-2')) ?? null;
}

/**
 * サーブの後に入れ替わる、得意な位置のポジション番号（none なら今のポジションのまま）。
 * 前衛：S/OP→ライト(2)、OH→レフト(4)、MB→センター(3)。後衛：S/OP→1、OH→6、MB→5
 */
export function switchedPos(state: GameState, p: Player): number {
  const pos = positionOf(state, p);
  const role = roleOf(state, p);
  if (!role) return pos;
  const front = isFrontRow(pos);
  if (role === 'OH') return front ? 4 : 6;
  if (role === 'MB') return front ? 3 : 5;
  return front ? 2 : 1;
}

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

// ---- 陣形（チームから見た座標 lx, lz。【要調整】） ----

/** サーブレシーブで受ける人の立ち位置。受ける人を元の位置に近い順に割り当てる */
export const RECEIVE_SPOTS: Record<ReceiveFormation, Spot[]> = {
  W: [[-3, 4.5], [0, 4.8], [3, 4.5], [-1.6, 7.3], [1.6, 7.3]], // 5人：前に3人、後ろに2人
  four: [[-3.2, 5.2], [-1.1, 6.8], [1.1, 6.8], [3.2, 5.2]], // 4人：U字
  three: [[-3, 6.2], [0, 6.6], [3, 6.2]], // 3人：OH 2人と後衛のMB
};
/** サーブレシーブで受けない人の立ち位置（ネット際に隠れる。後衛のセッターは前衛の後ろから出ていく） */
export const RECEIVE_HIDDEN: Record<'setterFront' | 'setterBack' | 'mbFront' | 'opFront' | 'opBack', Spot> = {
  setterFront: [1.6, 0.8],
  setterBack: [2.4, 2.4],
  mbFront: [0, 1.6],
  opFront: [3, 1.6],
  opBack: [3.6, 8.2],
};
/** セッターがトスを上げに入る位置（自チームにボールが来たら走り込む） */
export const SETTER_SPOT: Spot = [0.6, 0.9];

/**
 * 相手が攻撃してくるときの守備位置（入れ替わった後のポジション番号ごと）。
 * side は攻撃が自コートの右側（lx>0）から来るときの位置。左から来るときは lx を反転する。null はブロックに入る。
 */
export const DEFENSE_SPOTS: Record<DefenseFormation, { side: Record<number, Spot | null>; center: Record<number, Spot | null> }> = {
  // ペリメーター：後衛はコートの周りを守る。ブロックに跳ばない前衛はフェイントに備えて下がる
  perimeter: {
    side: { 2: null, 3: null, 4: [-3, 3], 1: [3.6, 6.2], 6: [-0.6, 8], 5: [-3.3, 5.6] },
    center: { 3: null, 2: [3, 3], 4: [-3, 3], 1: [3.2, 6.4], 6: [0, 8], 5: [-3.2, 6.4] },
  },
  // ローテーション：攻撃側の後衛がブロックの後ろのフェイントを拾いに上がり、中央の後衛がストレートの奥へ回る
  rotation: {
    side: { 2: null, 3: null, 4: [-3, 3], 1: [2.4, 3], 6: [3.6, 7.8], 5: [-3.2, 6.2] },
    center: { 3: null, 2: [3, 3], 4: [-3, 3], 1: [3, 6], 6: [0, 7.6], 5: [-3, 6] },
  },
};
/** スパイカーの後ろのカバー（スパイカーの打点からの相対位置。近い3人と遠い2人） */
export const COVER_SPOTS: Spot[] = [[-1.3, 1.6], [0, 2.1], [1.3, 1.6], [-2.6, 4.6], [2.6, 4.6]];

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
  const scale = (kind && JUDGE_SCALE[kind]) || 1;
  const a = (dt < 0 ? Math.max(0, -dt - early) : dt) / scale;
  if (a <= JUDGE.PERFECT) return 'PERFECT';
  if (a <= JUDGE.GOOD) return 'GOOD';
  if (a <= JUDGE.BAD) return 'BAD';
  return 'MISS';
}
