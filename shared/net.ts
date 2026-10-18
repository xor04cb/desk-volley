// オンライン対戦の通信の取り決め（メッセージの形と、状態の送り方）。WebSocket などの通信手段には依存しない
import { computePath } from './actions.ts';
import { MAX_REWIND_TICKS } from './constants.ts';
import { press, release, setStick } from './game.ts';
import { makeRng } from './prng.ts';
import { DEFAULT_RULES, type GameEvent, type GameState, type Rules, type TeamId } from './types.ts';

/**
 * クライアント → サーバー。
 * rt：押した・離した瞬間に、その人の画面に出ていたボールの tick（ラグ補償に使う）
 */
export type ClientMsg =
  | { t: 'create'; rules: Rules }
  | { t: 'join'; code: string }
  | { t: 'stick'; mx: number; mf: number }
  | { t: 'press'; rt: number }
  | { t: 'release'; rt: number }
  /** 時刻合わせ。c=送った時刻（クライアントの ms） */
  | { t: 'ping'; c: number; rt: number }
  | { t: 'rematch' }
  | { t: 'leave' };

/** サーバー → クライアント */
export type ServerMsg =
  | { t: 'created'; code: string }
  | { t: 'start'; team: TeamId }
  | { t: 'snap'; s: Snapshot; ev: GameEvent[] }
  /** 時刻合わせの返事。tick=返した瞬間のサーバーの tick（小数まで） */
  | { t: 'pong'; c: number; tick: number }
  /** 相手がもう一度を押した */
  | { t: 'rematchWait' }
  | { t: 'opponentLeft' }
  | { t: 'error'; msg: string };

/**
 * 送る状態。描画に要らない大きな部分（履歴・予測軌道）と乱数の状態（相手に先の展開を読ませない）は送らない。
 * 予測軌道は受け取った側でボールの状態から計算し直す（fromSnapshot）
 */
export type Snapshot = Omit<GameState, 'history' | 'path' | 'rng' | 'events' | 'stepEventCount'>;

export function toSnapshot(s: GameState): Snapshot {
  const { history: _h, path: _p, rng: _r, events: _e, stepEventCount: _c, ...rest } = s;
  return rest;
}

/** 受け取った状態を、描画（drawState）で使える GameState に戻す */
export function fromSnapshot(snap: Snapshot): GameState {
  const s: GameState = { ...snap, history: [], path: [], rng: makeRng(0), events: [], stepEventCount: 0 };
  // 予測軌道だけ作り直す。サーバーの予測軌道は最初の接地で終わるので、接地した後は作らない。
  // 落下予測（円の位置）もサーバーの値を使う（接地後に今のボールから計算し直すと変わるため）
  if (!s.ball.grounded) computePath(s);
  else s.pathTick = s.tick;
  s.predLandTick = snap.predLandTick;
  s.predLandX = snap.predLandX;
  s.predLandZ = snap.predLandZ;
  return s;
}

const clampInt = (v: unknown, lo: number, hi: number, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
const oneOf = <T>(v: unknown, list: readonly T[], def: T): T => (list.includes(v as T) ? (v as T) : def);

/** クライアントから来たルールを、設定画面で選べる範囲に収める */
export function sanitizeRules(r: Partial<Rules> | undefined): Rules {
  const d = DEFAULT_RULES;
  const v = r ?? {};
  return {
    pointsPerSet: clampInt(v.pointsPerSet, 5, 25, d.pointsPerSet),
    sets: oneOf(v.sets, [1, 3, 5] as const, d.sets),
    finalSetPoints: clampInt(v.finalSetPoints, 5, 25, d.finalSetPoints),
    deuce: typeof v.deuce === 'boolean' ? v.deuce : d.deuce,
    feint: typeof v.feint === 'boolean' ? v.feint : d.feint,
    serveTime: clampInt(v.serveTime, 3, 30, d.serveTime),
    system: oneOf(v.system, ['none', '5-1', '4-2', '6-2'] as const, d.system),
    receive: oneOf(v.receive, ['W', 'four', 'three'] as const, d.receive),
    defense: oneOf(v.defense, ['perimeter', 'rotation'] as const, d.defense),
  };
}

/**
 * 入力に付いてきた rt（画面に見えていたボールの tick、小数）から、巻き戻す tick 数を決める。
 * 画面のボールは rt の小数部分だけ tick floor(rt) より先へ補間されているので、floor(rt) まで戻す
 * （四捨五入すると、床に落ちる直前に離したのが落ちた後の扱いになることがある）
 */
export const lagOf = (serverTick: number, rt: number): number => Math.max(0, Math.min(MAX_REWIND_TICKS, serverTick - Math.floor(rt)));

/**
 * 試合中の入力・時刻合わせのメッセージを状態に当てる（サーバー）。返事が要るときは返す。
 * frac：今の tick の中でどれだけ時間が進んでいるか（0〜1。時刻合わせの精度のため）
 */
export function applyGameMsg(s: GameState, team: TeamId, m: ClientMsg, frac = 0): ServerMsg | null {
  switch (m.t) {
    case 'ping':
      s.teams[team].lag = lagOf(s.tick, m.rt);
      return { t: 'pong', c: m.c, tick: s.tick + frac };
    // スティックは届いた時点で使う（自分の選手は先行表示しているので、届く頃の位置で合っている）
    case 'stick':
      setStick(s, team, m.mx, m.mf);
      return null;
    // ボタンは、その人の画面に見えていたボールの tick で扱う（ラグ補償）
    case 'press':
    case 'release': {
      const lag = lagOf(s.tick, m.rt);
      s.teams[team].lag = lag;
      (m.t === 'press' ? press : release)(s, team, s.tick - lag);
      return null;
    }
    default:
      return null;
  }
}

/** 受け取ったメッセージを読む。形がおかしければ null */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'create':
      return { t: 'create', rules: sanitizeRules(o.rules as Partial<Rules>) };
    case 'join':
      return typeof o.code === 'string' ? { t: 'join', code: o.code.trim() } : null;
    case 'stick': {
      const mx = Number(o.mx);
      const mf = Number(o.mf);
      return Number.isFinite(mx) && Number.isFinite(mf) ? { t: 'stick', mx, mf } : null;
    }
    case 'press':
    case 'release': {
      const rt = Number(o.rt);
      return Number.isFinite(rt) ? { t: o.t, rt } : null;
    }
    case 'ping': {
      const c = Number(o.c);
      const rt = Number(o.rt);
      return Number.isFinite(c) && Number.isFinite(rt) ? { t: 'ping', c, rt } : null;
    }
    case 'rematch':
    case 'leave':
      return { t: o.t };
    default:
      return null;
  }
}
