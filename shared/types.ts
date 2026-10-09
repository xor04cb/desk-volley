import type { Ball } from './physics.ts';
import type { Rng } from './prng.ts';
import type { Vec3 } from './vec.ts';

export type TeamId = 0 | 1;
export type Judgment = 'PERFECT' | 'GOOD' | 'BAD' | 'MISS';
/** free=低いボールを山なりで相手コートへ返す */
export type ContactKind = 'serve' | 'receive' | 'toss' | 'spike' | 'feint' | 'free' | 'block';
/** ボタンを離したときに起きる動作 */
export type ActionKind = 'serve' | 'receive' | 'toss' | 'jump' | 'twoJump' | 'spike' | 'free' | 'block' | 'none';

export interface Rules {
  pointsPerSet: number; // 5〜25
  sets: 1 | 3 | 5;
  finalSetPoints: number; // 5〜25（セット数1のときは使わない）
  deuce: boolean;
  feint: boolean;
  serveTime: number; // 秒
  /** ローテシステム（none=役割なし、ローテーションの位置のまま） */
  system: RotationSystem;
  /** サーブレシーブの陣形 */
  receive: ReceiveFormation;
  /** 守備の陣形 */
  defense: DefenseFormation;
}

export type RotationSystem = 'none' | '5-1' | '4-2' | '6-2';
/** W=5人、four=4人、three=3人で受ける */
export type ReceiveFormation = 'W' | 'four' | 'three';
export type DefenseFormation = 'perimeter' | 'rotation';
/** 役割：セッター、アウトサイド、ミドル、オポジット */
export type Role = 'S' | 'OH' | 'MB' | 'OP';

export const DEFAULT_RULES: Rules = {
  pointsPerSet: 25,
  sets: 1,
  finalSetPoints: 15,
  deuce: true,
  feint: true,
  serveTime: 10,
  system: '5-1',
  receive: 'W',
  defense: 'perimeter',
};

export interface Player {
  id: number; // 0〜11。チーム0が0〜5、チーム1が6〜11
  team: TeamId;
  slot: number; // チーム内の番号 0〜5（ローテーションの基準）
  name: string;
  x: number;
  z: number;
  /** 足元の高さ（ジャンプ中のみ >0） */
  y: number;
  vy: number;
  vx: number;
  vz: number;
  jump: 'none' | 'attack' | 'block';
  /** この跳躍でもう打ったか */
  swung: boolean;
  /** この tick まで動けない（カットの後の硬直。-1=なし） */
  recoverTick: number;
  /** フライングを始めたtick（-1=していない）。起き上がるまで動けない */
  diveTick: number;
  /** 飛び込む先（体の位置） */
  diveX: number;
  diveZ: number;
  /** 陣形で向かっている位置（打球の直後は少しの間、前の位置へ向かい続ける） */
  gx: number;
  gz: number;
  /** 向き（チームから見た前方向に対するx成分・z成分。描画用） */
  fx: number;
  fz: number;
}

export interface Team {
  score: number;
  setsWon: number;
  rotation: number;
  /** 残りコンタクト（3→2→1→0） */
  contactsLeft: number;
  /** このチームで最後に触った選手（ドリブル判定用。-1=なし） */
  lastToucher: number;
  /** 操作中の選手 */
  controlled: number;
  /** ボタンを押し始めたtick（-1=押していない） */
  pressTick: number;
  /** スティック（チームから見た座標。mx=右+、mf=ネット方向+） */
  mx: number;
  mf: number;
  human: boolean;
}

export interface PendingContact {
  tick: number;
  team: TeamId;
  player: number;
  kind: ContactKind;
  judgment: Judgment;
  charge: number;
  mx: number;
  mf: number;
  dt: number;
  /** フライングでの打球 */
  dive?: boolean;
}

/** 直近の打球の詳細（デバッグ表示用） */
export interface ContactInfo {
  tick: number;
  team: TeamId;
  player: number;
  kind: ContactKind;
  judgment: Judgment;
  charge: number; // 溜め量 c
  effCharge: number; // 判定を反映した溜め効果
  dt: number; // タイミングのずれ（秒、+は遅い）
  dive: boolean; // フライングでの打球
  apex: number; // 最高点
  speed: number; // 初速
  scatter: number; // ぶれ半径
  targetX: number;
  targetZ: number;
  landX: number;
  landZ: number;
}

export type GameEvent =
  | { type: 'judge'; team: TeamId; player: number; judgment: Judgment; action: ActionKind; dt: number; charge: number; dive?: boolean }
  | { type: 'contact'; info: ContactInfo }
  | { type: 'jump'; player: number; height: number; charge: number }
  | { type: 'block'; player: number }
  | { type: 'net' }
  | { type: 'serveToss'; player: number }
  | { type: 'point'; team: TeamId; reason: 'in' | 'out' | 'antenna' | 'serveMiss' | 'fault' }
  | { type: 'setEnd'; winner: TeamId; set: number }
  | { type: 'matchEnd'; winner: TeamId };

export interface HistoryEntry {
  tick: number;
  ball: Vec3;
  vel: Vec3;
  mode: Ball['mode'];
  grounded: boolean;
  /** 各選手の (x, z, y) */
  players: number[];
}

export type Phase = 'serve' | 'rally' | 'point' | 'matchEnd';

export interface GameState {
  tick: number;
  rules: Rules;
  rng: Rng;
  players: Player[];
  teams: [Team, Team];
  ball: Ball;
  phase: Phase;
  /** フェーズ開始tick */
  phaseTick: number;
  set: number; // 1始まり
  setScores: [number, number][];
  servingTeam: TeamId;
  server: number;
  serveTossed: boolean;
  /** 最後に触ったチーム（アウト判定用。-1=なし） */
  lastTouchTeam: TeamId | -1;
  lastContactKind: ContactKind | null;
  /** アンテナの外を通過した */
  antennaFault: boolean;
  /** 接地したtick（得点確定待ち。-1=なし） */
  landTick: number;
  landX: number;
  landZ: number;
  pending: PendingContact | null;
  /** 予測：次に接地する位置と時刻（-1=予測なし） */
  predLandTick: number;
  predLandX: number;
  predLandZ: number;
  /** 予測軌道の開始tick（path[i] は pathTick+i+1 の位置） */
  pathTick: number;
  path: Vec3[];
  history: HistoryEntry[];
  lastContact: ContactInfo | null;
  /** AIが反応してよいtick（チームごと） */
  aiReadyTick: [number, number];
  /** AIが今回の接近で空振りした（再試行させない） */
  aiMissTick: [number, number];
  /** ブロック済み（同じ打球で2度ブロックしない） */
  blockedThisAttack: boolean;
  /** トスを上げた先のアタッカー（-1=なし） */
  tossTarget: number;
  winner: TeamId | -1;
  /** セットが終わり、次のサーブ開始時に得点をリセットする */
  setPending: boolean;
  /** CPUがサーブを打つtick */
  aiServeTick: number;
  /** AIのジャンプ予定tick（チームごと。-1=なし） */
  aiJumpTick: [number, number];
  /** 練習モード（null=試合） */
  practice: PracticeState | null;
  /** このtickのイベント（step の後に読む）。入力（press/release）で出たものも次の step で一緒に渡す */
  events: GameEvent[];
  /** 直前の step で出たイベントの数（次の step の始めに消す分） */
  stepEventCount: number;
}

/** 練習の種類 */
export type PracticeKind = 'serveCut' | 'serveCutSpike' | 'spikeReceive' | 'spike' | 'serve';
export type TossZone = 'left' | 'center' | 'right';

export interface PracticeState {
  kind: PracticeKind;
  /** 自動トスを上げる向き（スパイクのある練習） */
  tossZone: TossZone | 'random';
  /** 今の1本で自動トスを上げる味方セッター（-1=未定）と、打つ選手 */
  setter: number;
  attacker: number;
  /** 1本が終わり、次の1本を始める tick（-1=続いている） */
  nextRepTick: number;
  /** CPUを止めているチーム（1本が終わった後や、サーブ練習の相手） */
  aiOff: [boolean, boolean];
}
