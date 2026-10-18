// オンラインの遅延対策（フェーズ9）：時刻合わせ、ボールと他の選手の補間、自分の選手の先行表示（予測）。
// 画面や通信には触らない（テストで遅延を模擬して確かめられるように）
//
// 時間軸は2つ：
//  R（表示 tick）= サーバーの今 − 片道 − 補間の余裕。ボールと他の選手はこの時点の状態を補間して見せる（届いた状態だけで描けるので滑らか）
//  A（予測 tick）= サーバーの今 ＋ 片道。今送った入力がサーバーに届く頃。自分の選手はこの時点を予測して見せる（操作がすぐ反映される）
// ボタンには R を付けて送る。サーバーは「ボールは R、選手は今（＝A）」の組で判定する（shared/game.ts の release）
import { chargeOf, startJump } from '../shared/actions.ts';
import { NET, TICK_RATE } from '../shared/constants.ts';
import { currentAction, press, setStick, step } from '../shared/game.ts';
import { fromSnapshot, type ClientMsg, type Snapshot } from '../shared/net.ts';
import type { ActionKind, GameEvent, GameState, Player, TeamId } from '../shared/types.ts';

const msToTicks = (ms: number) => (ms * TICK_RATE) / 1000;

/** サーバーの tick を、ping の往復から推定する */
export class NetClock {
  private samples: { rtt: number; offset: number }[] = [];
  private offset = 0;
  /** 往復の時間（ms、直近の平均） */
  rttMs = 0;

  get ready(): boolean {
    return this.samples.length > 0;
  }

  /** c=ping を送った時刻、tick=サーバーが返した瞬間の tick、now=受け取った時刻（いずれもクライアントの ms） */
  onPong(c: number, tick: number, now: number): void {
    const rtt = Math.max(0, now - c);
    // 返事は片道（往復の半分）前に出たものとみなす
    this.samples.push({ rtt, offset: tick + msToTicks(rtt / 2) - msToTicks(now) });
    if (this.samples.length > NET.pingSamples) this.samples.shift();
    // 往復が最も短かった回が一番正確（途中で待たされていない）
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rttMs = this.samples.reduce((a, s) => a + s.rtt, 0) / this.samples.length;
  }

  /** クライアントの時刻 now（ms）でのサーバーの tick（小数） */
  serverTick(now: number): number {
    return msToTicks(now) + this.offset;
  }

  /** 片道の tick 数 */
  get oneWayTicks(): number {
    return msToTicks(this.rttMs / 2);
  }
}

/** 推定値の変化で表示が飛ばないように、時間を滑らかに進める */
export class Timeline {
  value = NaN;
  update(target: number, dtTicks: number): number {
    if (Number.isNaN(this.value) || Math.abs(target - (this.value + dtTicks)) > 10) this.value = target;
    else {
      this.value += dtTicks;
      this.value += (target - this.value) * NET.smoothing;
    }
    return this.value;
  }
}

interface Entry {
  s: GameState;
  ev: GameEvent[];
  shown: boolean;
}

/** 届いた状態を貯め、表示 tick の状態を補間して作る */
export class SnapBuffer {
  private list: Entry[] = [];

  push(s: GameState, ev: GameEvent[]): void {
    if (this.list.length && s.tick <= this.latest!.tick) return; // 古いものは捨てる
    this.list.push({ s, ev, shown: false });
    while (this.list.length > 2 && this.list[0].s.tick < s.tick - TICK_RATE) this.list.shift();
  }

  get latest(): GameState | null {
    return this.list.length ? this.list[this.list.length - 1].s : null;
  }

  clear(): void {
    this.list = [];
  }

  /** 表示 tick r を過ぎた状態のイベント（まだ出していないもの）を、その状態と一緒に返す */
  dueEvents(r: number): { s: GameState; ev: GameEvent[] }[] {
    const out: { s: GameState; ev: GameEvent[] }[] = [];
    for (const e of this.list) {
      if (e.s.tick > r) break;
      if (!e.shown) {
        e.shown = true;
        if (e.ev.length) out.push({ s: e.s, ev: e.ev });
      }
    }
    return out;
  }

  /** 表示 tick r の状態（前後の状態の間を補間した新しいオブジェクト。選手の位置とボールの位置だけ補間する） */
  sample(r: number): GameState | null {
    const n = this.list.length;
    if (!n) return null;
    let i = n - 1;
    while (i > 0 && this.list[i].s.tick > r) i--;
    const a = this.list[i].s;
    const b = i + 1 < n ? this.list[i + 1].s : null;
    const f = b ? Math.min(Math.max((r - a.tick) / (b.tick - a.tick), 0), 1) : 0;
    const lerp = (x: number, y: number) => x + (y - x) * f;
    const players = a.players.map((p, k) => {
      const q = b?.players[k];
      if (!q || f === 0) return { ...p };
      return { ...p, x: lerp(p.x, q.x), y: lerp(p.y, q.y), z: lerp(p.z, q.z) };
    });
    const bp = b && b.ball.mode !== 'held' && a.ball.mode !== 'held' ? b.ball.pos : a.ball.pos;
    const ball = { ...a.ball, pos: { x: lerp(a.ball.pos.x, bp.x), y: lerp(a.ball.pos.y, bp.y), z: lerp(a.ball.pos.z, bp.z) } };
    return { ...a, tick: Math.max(a.tick, Math.min(Math.floor(r), b ? b.tick - 1 : a.tick)), players, ball, teams: [{ ...a.teams[0] }, { ...a.teams[1] }] };
  }
}

interface JumpInput {
  kind: 'attack' | 'block';
  charge: number;
  player: number;
}

/** 予測に使う入力の記録（予測 tick ごと） */
interface InputLog {
  tick: number;
  mx: number;
  mf: number;
  press?: boolean;
  release?: boolean;
  /** 離したときにジャンプ・ブロックになった（予測でも跳ぶ） */
  jump?: JumpInput;
}

/**
 * 自分の選手の予測。届いた最新の状態から、まだサーバーに届いていない自分の入力を当てて予測 tick まで進める
 */
export class Predictor {
  state: GameState | null = null;
  private log: InputLog[] = [];

  constructor(readonly team: TeamId) {}

  /** 入力を記録する（tick=その入力がサーバーに届く頃の tick） */
  record(e: InputLog): void {
    this.log.push(e);
  }

  /** 新しい状態が届いたら、そこから予測し直す（s は予測用に複製したもの。書き換える） */
  rebase(s: GameState, toTick: number): void {
    this.log = this.log.filter((e) => e.tick >= s.tick - TICK_RATE);
    this.state = s;
    this.advance(toTick, s.tick);
  }

  /** 予測 tick まで進める */
  advance(toTick: number, from = this.state?.tick ?? 0): void {
    const s = this.state;
    if (!s) return;
    const steps = Math.min(Math.floor(toTick) - s.tick, 30); // 大きく遅れたら追いつくのをあきらめる
    for (let i = 0; i < steps; i++) {
      for (const e of this.log) if (e.tick === s.tick && e.tick >= from) this.apply(s, e);
      step(s);
    }
  }

  private apply(s: GameState, e: InputLog): void {
    const T = this.team;
    setStick(s, T, e.mx, e.mf);
    if (e.press) press(s, T);
    if (e.release) {
      s.teams[T].pressTick = -1;
      if (e.jump) startJump(s, s.players[e.jump.player], e.jump.kind, e.jump.charge);
    }
  }
}

/**
 * 画面に描く状態：ボールと他の選手は表示 tick（補間）、自分の操作する選手は予測。
 * pressR：ボタンを押した瞬間の表示 tick（押していなければ -1）。溜めのリングに使う
 */
export function composeView(interp: GameState, pred: GameState | null, T: TeamId, pressR: number, stick: { mx: number; mf: number }): GameState {
  const v = interp;
  // 操作する選手は表示 tick の時点の選手（サーバーもボタンをその時点の操作選手で扱う）。位置だけ予測を使う
  const id = v.teams[T].controlled;
  if (pred) v.players[id] = { ...pred.players[id] };
  v.teams[T] = { ...v.teams[T], pressTick: pressR, mx: stick.mx, mf: stick.mf };
  return v;
}

/** ボタンを離したときに起きる動作（画面の状態で決める。サーバーも同じ組み合わせで決める）と、跳ぶならその溜め */
export function releaseAction(view: GameState, T: TeamId, pressR: number, r: number): { action: ActionKind; jump?: JumpInput } {
  const action = currentAction(view, T);
  const charge = chargeOf(pressR, r, action);
  const player = view.teams[T].controlled;
  if (action === 'jump' || action === 'twoJump') return { action, jump: { kind: 'attack', charge, player } };
  if (action === 'block') return { action, jump: { kind: 'block', charge, player } };
  return { action };
}

export interface PadInput {
  mx: number;
  mf: number;
  held: boolean;
}

/** スティックの変化がこれより小さければ送らない */
const STICK_SEND_EPS = 0.02;

/**
 * オンライン対戦のクライアント側のまとめ役（画面・通信には触らない）。
 * 届いたもの（onSnap / onPong）を渡し、毎フレーム input → frame の順に呼ぶ。返ってきたメッセージを送り、view を描く
 */
export class NetSession {
  readonly clock = new NetClock();
  private buf = new SnapBuffer();
  private pred: Predictor;
  private rLine = new Timeline();
  private aLine = new Timeline();
  private smoother = new Smoother();
  private lastNow = NaN;
  /** 表示 tick（ボール・他の選手） */
  r = 0;
  /** 予測 tick（自分の選手） */
  a = 0;
  /** 押した瞬間の表示 tick（押していなければ -1） */
  private pressR = -1;
  private held = false;
  private stick = { mx: 0, mf: 0 };
  private lastView: GameState | null = null;

  constructor(readonly team: TeamId) {
    this.pred = new Predictor(team);
  }

  /** 新しい試合（もう一度） */
  reset(): void {
    this.buf.clear();
    this.pred = new Predictor(this.team);
    this.pressR = -1;
    this.lastView = null;
  }

  pingMsg(now: number): ClientMsg {
    return { t: 'ping', c: now, rt: this.r };
  }

  onPong(c: number, tick: number, now: number): void {
    this.clock.onPong(c, tick, now);
  }

  /** 状態が届いた。自分の判定はすぐ出せるように返す（他は表示 tick が追いついたときに frame で返す） */
  onSnap(snap: Snapshot, ev: GameEvent[]): GameEvent[] {
    const mine = ev.filter((e) => e.type === 'judge' && e.team === this.team);
    this.buf.push(fromSnapshot(snap), mine.length ? ev.filter((e) => !mine.includes(e)) : ev);
    this.pred.rebase(fromSnapshot(structuredClone(snap)), Math.max(this.a, snap.tick));
    return mine;
  }

  /** 入力を読んで、送るメッセージを返す */
  input(st: PadInput): ClientMsg[] {
    const out: ClientMsg[] = [];
    const tick = Math.floor(this.a);
    const changed = (x: number, y: number) => Math.abs(x - y) > STICK_SEND_EPS || (x === 0) !== (y === 0); // 0に戻したときは必ず送る
    if (changed(st.mx, this.stick.mx) || changed(st.mf, this.stick.mf)) {
      this.stick = { mx: st.mx, mf: st.mf };
      out.push({ t: 'stick', ...this.stick });
      this.pred.record({ tick, ...this.stick });
    }
    if (st.held && !this.held) {
      this.pressR = this.r;
      out.push({ t: 'press', rt: this.r });
      this.pred.record({ tick, ...this.stick, press: true });
    } else if (!st.held && this.held) {
      const ra = this.lastView && this.pressR >= 0 ? releaseAction(this.lastView, this.team, this.pressR, this.r) : null;
      out.push({ t: 'release', rt: this.r });
      this.pred.record({ tick, ...this.stick, release: true, jump: ra?.jump });
      this.pressR = -1;
    }
    this.held = st.held;
    return out;
  }

  /** 時刻を進め、描く状態と、表示 tick が追いついたイベントを返す */
  frame(now: number): { view: GameState; events: { s: GameState; ev: GameEvent[] }[] } | null {
    const latest = this.buf.latest;
    if (!latest) return null;
    const dtSec = Number.isNaN(this.lastNow) ? 0 : Math.min((now - this.lastNow) / 1000, 0.1);
    this.lastNow = now;
    let rT = latest.tick;
    let aT = latest.tick;
    if (this.clock.ready) {
      const n = this.clock.serverTick(now);
      rT = n - this.clock.oneWayTicks - NET.interpBufferTicks;
      aT = n + this.clock.oneWayTicks;
    }
    // 表示 tick は届いた状態より先へは進めない（届くのが遅れたら止まって待つ）
    this.r = Math.min(this.rLine.update(rT, dtSec * TICK_RATE), latest.tick);
    this.a = Math.max(this.aLine.update(aT, dtSec * TICK_RATE), latest.tick);
    this.pred.advance(this.a);
    const view = composeView(this.buf.sample(this.r)!, this.pred.state, this.team, this.pressR, this.stick);
    this.smoother.apply(view.players, dtSec);
    this.lastView = view;
    return { view, events: this.buf.dueEvents(this.r) };
  }
}

/** 描画用：選手の位置の急な変化（予測のやり直し・予測と補間の切り替え）を、少しずつ戻して滑らかにする */
export class Smoother {
  /** 選手ごと：前のフレームの位置（補正前）と、描く位置へのずれ */
  private prev = new Map<number, { x: number; z: number; ox: number; oz: number }>();
  apply(players: Player[], dtSec: number): void {
    for (const p of players) {
      const q = this.prev.get(p.id);
      let ox = 0;
      let oz = 0;
      if (q) {
        // 走る速さで説明できない飛び（予測のやり直し・切り替え）をずれとして持ち、少しずつ消す。フライングの滑り込みはそのまま
        const diving = p.diveTick >= 0;
        const jx = diving ? 0 : p.x - (q.x + p.vx * dtSec);
        const jz = diving ? 0 : p.z - (q.z + p.vz * dtSec);
        if (Math.hypot(jx, jz) < 3) {
          ox = (q.ox - jx) * (1 - NET.smoothing);
          oz = (q.oz - jz) * (1 - NET.smoothing);
        } // 3m以上の飛びはサーブ前の並び直しなどなので、そのまま見せる
      }
      this.prev.set(p.id, { x: p.x, z: p.z, ox, oz });
      p.x += ox;
      p.z += oz;
    }
  }
}
