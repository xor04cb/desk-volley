// CPUの判断。操作していない味方の位置取りと、CPUチームの打球・ジャンプ・ブロック
import {
  AI,
  BLOCK_JUMP_MAX,
  BLOCK_JUMP_MIN,
  JUMP_HEIGHT_MAX,
  JUMP_HEIGHT_MIN,
  PLAYER_MIN_NET_DIST,
  RECEIVE_HIT_HEIGHT,
  STANDING_REACH,
  TICK_RATE,
  TOSS_HIT_HEIGHT,
} from './constants.ts';
import {
  applyContact,
  ballAt,
  ballSpeed,
  ballComingTo,
  blockerFor,
  chooseAttacker,
  contactDist,
  interceptPoint,
  maxReachOf,
  opponentAttacking,
  reachOf,
  riseTime,
  serveHitTick,
  serveToss,
  spikeAim,
  startDive,
  startJump,
} from './actions.ts';
import {
  COVER_SPOTS,
  DEFENSE_SPOTS,
  FORMATION,
  RECEIVE_HIDDEN,
  RECEIVE_SPOTS,
  SETTER_SPOT,
  isFrontRow,
  judgeOf,
  positionOf,
  roleOf,
  setterOf,
  switchedPos,
  toLocal,
  toWorld,
} from './court.ts';
import { rand, randNormal, randRange } from './prng.ts';
import type { ActionKind, ContactKind, GameState, Player, TeamId } from './types.ts';
import { clamp, dist2, lerp } from './vec.ts';

const AI_ATTACK_CHARGE = 0.8;
const AI_JUMP_H = lerp(JUMP_HEIGHT_MIN, JUMP_HEIGHT_MAX, AI_ATTACK_CHARGE);
const AI_BLOCK_CHARGE = 0.8;
const AI_BLOCK_H = lerp(BLOCK_JUMP_MIN, BLOCK_JUMP_MAX, AI_BLOCK_CHARGE);

export interface Target {
  x: number;
  z: number;
}

type Spot = readonly [number, number];

/**
 * 操作していない選手の立ち位置（陣形）。
 * サーブ前：サーブ側はローテーションの位置、レシーブ側はサーブレシーブの陣形。
 * ラリー中（サーブの後）：得意な位置へ入れ替わり、攻撃（助走・カバー）と守備（相手の攻撃の向きに合わせる）の陣形
 */
export function formationSpot(s: GameState, p: Player): Target {
  const T = p.team;
  const at = (sp: Spot) => toWorld(T, sp[0], sp[1]);
  if (s.rules.system === 'none') return legacySpot(s, p);
  if (s.phase === 'serve') return at(s.servingTeam === T ? FORMATION.base[positionOf(s, p)] : receiveSpot(s, p));
  if (s.phase !== 'rally') return { x: p.x, z: p.z };
  const pos = switchedPos(s, p);
  if (ballComingTo(s, T)) {
    const team = s.teams[T];
    // 攻撃：トスを上げたら、打つ人以外はスパイカーの後ろをカバー
    if (s.lastTouchTeam === T && s.lastContactKind === 'toss' && s.tossTarget >= 0 && s.tossTarget !== p.id) return coverSpot(s, p);
    // セッターは（自分が1本目を触っていなければ）トスを上げる位置へ走り込む
    const setter = setterOf(s, T);
    if (setter?.id === p.id && team.contactsLeft >= 2 && !(s.lastTouchTeam === T && team.lastToucher === p.id)) return at(SETTER_SPOT);
    return at(FORMATION.offense[pos]);
  }
  if (!opponentAttacking(s, T)) return at(FORMATION.defense[pos]);
  return defenseSpot(s, p, pos);
}

/** ローテシステム「なし」：役割なし、ローテーションの位置のまま（陣形を入れる前の動き） */
function legacySpot(s: GameState, p: Player): Target {
  const T = p.team;
  const pos = positionOf(s, p);
  let spot: Spot;
  if (s.phase === 'serve') {
    spot = s.servingTeam === T ? FORMATION.base[pos] : FORMATION.receive[pos];
  } else if (s.phase !== 'rally') {
    return { x: p.x, z: p.z };
  } else if (ballComingTo(s, T)) {
    spot = FORMATION.offense[pos];
  } else {
    spot = FORMATION.defense[pos];
    // 相手が攻撃してくるとき、ブロックに跳ばない前衛は少し下がってフェイントや軟打に備える
    if (opponentAttacking(s, T) && isFrontRow(pos) && s.teams[T].controlled !== p.id) spot = [spot[0], 3.0];
  }
  return toWorld(T, spot[0], spot[1]);
}

/** サーブレシーブの陣形での立ち位置（役割があるとき） */
function receiveSpot(s: GameState, p: Player): Spot {
  const T = p.team;
  const kind = s.rules.receive;
  const setter = setterOf(s, T);
  const hidden = (q: Player): keyof typeof RECEIVE_HIDDEN | null => {
    const front = isFrontRow(positionOf(s, q));
    const role = roleOf(s, q);
    if (q.id === setter?.id) return front ? 'setterFront' : 'setterBack';
    if (kind !== 'W' && role === 'MB' && front) return 'mbFront';
    if (kind === 'three' && (role === 'OP' || role === 'S')) return front ? 'opFront' : 'opBack';
    return null;
  };
  const h = hidden(p);
  if (h) return RECEIVE_HIDDEN[h];
  // 受ける人を、元の位置（ローテーション）から動く距離の合計が最小になるように割り当てる
  const passers = s.players.filter((q) => q.team === T && !hidden(q));
  const spots = RECEIVE_SPOTS[kind];
  const assign = bestAssignment(
    passers.map((q) => FORMATION.base[positionOf(s, q)]),
    spots,
  );
  return spots[assign[passers.indexOf(p)]] ?? FORMATION.receive[positionOf(s, p)];
}

/** 相手が攻撃してくるときの守備位置。攻撃の来る側（自コートの左右）に合わせて反転する */
function defenseSpot(s: GameState, p: Player, pos: number): Target {
  const T = p.team;
  const ax = attackX(s, T);
  const alx = toLocal(T, ax, 0).lx;
  const sg = alx > 1.5 ? 1 : alx < -1.5 ? -1 : 0;
  const table = DEFENSE_SPOTS[s.rules.defense][sg === 0 ? 'center' : 'side'];
  // 左から来るときは、右から来るときの位置を左右反転して使う（ポジション 2↔4、1↔5）
  const mirrored = sg < 0 ? ({ 2: 4, 4: 2, 1: 5, 5: 1 } as Record<number, number>)[pos] ?? pos : pos;
  const sp = table[mirrored];
  if (sp === undefined || sp === null) {
    // ブロックに入る：攻撃側の前衛は打点の正面、センターはその内側に並ぶ
    const bx = clamp(alx - (pos === 3 && sg !== 0 ? sg * 0.8 : 0), -4.2, 4.2);
    return toWorld(T, bx, PLAYER_MIN_NET_DIST + 0.25);
  }
  return toWorld(T, sg < 0 ? -sp[0] : sp[0], sp[1]);
}

/** 相手が打ってくる位置（ワールドの x）。トスの相手がいればその選手、なければ落下予測 */
function attackX(s: GameState, T: TeamId): number {
  const opp = 1 - T;
  if (s.tossTarget >= 0 && s.players[s.tossTarget].team === opp) return s.players[s.tossTarget].x;
  return s.predLandTick >= 0 ? s.predLandX : s.ball.pos.x;
}

/** スパイカーの後ろのカバー。打つ人以外を、近い順にカバーの位置へ割り当てる */
function coverSpot(s: GameState, p: Player): Target {
  const T = p.team;
  const hitter = s.players[s.tossTarget];
  const ip = interceptPoint(s, T, STANDING_REACH + AI_JUMP_H);
  const h = toLocal(T, ip ? ip.x : hitter.x, ip ? ip.z : hitter.z);
  const others = s.players.filter((q) => q.team === T && q.id !== hitter.id && q.id !== s.teams[T].controlled);
  // 大事な順（近い3人→遠い2人）に、人数分だけ使う
  const spots: Spot[] = COVER_SPOTS.slice(0, others.length).map(([dx, dz]) => [clamp(h.lx + dx, -4.4, 4.4), clamp(h.lz + dz, 1.0, 8.6)]);
  const assign = bestAssignment(
    others.map((q) => {
      const l = toLocal(T, q.x, q.z);
      return [l.lx, l.lz] as Spot;
    }),
    spots,
  );
  const k = assign[others.indexOf(p)];
  const sp = k === undefined || k < 0 ? FORMATION.offense[switchedPos(s, p)] : spots[k];
  return toWorld(T, sp[0], sp[1]);
}

/** from[i] を spots のどれかに割り当てる（重複なし）。移動距離の2乗の合計が最小。spots が足りなければ -1 */
function bestAssignment(from: Spot[], spots: Spot[]): number[] {
  const n = from.length;
  let best: number[] = new Array(n).fill(-1);
  let bc = Infinity;
  const cur: number[] = [];
  const used = new Array(spots.length).fill(false);
  const rec = (i: number, cost: number) => {
    if (cost >= bc) return;
    if (i === n) {
      bc = cost;
      best = cur.slice();
      return;
    }
    let any = false;
    for (let k = 0; k < spots.length; k++) {
      if (used[k]) continue;
      any = true;
      used[k] = true;
      cur[i] = k;
      const d = (from[i][0] - spots[k][0]) ** 2 + (from[i][1] - spots[k][1]) ** 2;
      rec(i + 1, cost + d);
      used[k] = false;
    }
    if (!any) {
      cur[i] = -1; // 割り当てる位置が残っていない
      rec(i + 1, cost);
    }
  };
  rec(0, 0);
  return best;
}

/** CPUのジャンプ・打球判断。actor（次に動く選手）の目標地点を返す */
export function runAI(s: GameState, T: TeamId): Target | null {
  const team = s.teams[T];
  const p = s.players[team.controlled];

  if (s.phase === 'serve') {
    if (s.servingTeam === T && !s.serveTossed && s.tick >= s.aiServeTick) aiServe(s, T);
    return null;
  }
  if (s.phase !== 'rally') return null;
  if (s.tick < s.aiReadyTick[T]) return null;

  if (ballComingTo(s, T) && team.contactsLeft > 0) {
    const cl = team.contactsLeft;
    if (cl >= 2) {
      const kind: ContactKind = cl === 3 ? 'receive' : 'toss';
      const ip = interceptPoint(s, T, kind === 'receive' ? RECEIVE_HIT_HEIGHT : TOSS_HIT_HEIGHT);
      tryHit(s, p, kind);
      return ip ? { x: ip.x, z: ip.z } : null;
    }
    // 残り1回：スパイク。ボールが低ければ山なりで返す
    const handH = STANDING_REACH + AI_JUMP_H;
    if (p.jump === 'attack') {
      if (!p.swung) tryHit(s, p, 'spike');
      return null;
    }
    const ip = interceptPoint(s, T, handH);
    const near = ip && toLocal(T, ip.x, ip.z).lz < 4.5;
    if (!ip || !near) {
      tryHit(s, p, 'free');
      const low = interceptPoint(s, T, RECEIVE_HIT_HEIGHT);
      return low ? { x: low.x, z: low.z } : null;
    }
    // 助走：打点の少し手前（自陣側）に入り、上昇時間ぶん前に跳ぶ
    const back = toWorld(T, 0, 0.35);
    const spot = { x: ip.x + back.x, z: ip.z + back.z };
    if (s.aiJumpTick[T] < 0) s.aiJumpTick[T] = ip.tick - Math.round(riseTime(AI_JUMP_H) * TICK_RATE);
    if (s.tick >= s.aiJumpTick[T] && p.y === 0) {
      // 人と同じく、その場で真上に跳ぶ
      startJump(s, p, 'attack', AI_ATTACK_CHARGE);
      return null;
    }
    return spot;
  }

  if (opponentAttacking(s, T)) {
    const b = blockerFor(s, T);
    if (b.id !== p.id) team.controlled = b.id;
    const opp = (1 - T) as TeamId;
    const ax = s.predLandTick >= 0 ? s.predLandX : s.ball.pos.x;
    const spot = toWorld(T, toLocal(T, ax, 0).lx, PLAYER_MIN_NET_DIST + 0.05);
    if (s.aiJumpTick[T] < 0) {
      const hit = interceptPoint(s, opp, STANDING_REACH + AI_JUMP_H);
      if (hit) {
        const noise = Math.round(randNormal(s.rng) * AI.blockTimingSigma * TICK_RATE);
        s.aiJumpTick[T] = hit.tick - Math.round(riseTime(AI_BLOCK_H) * TICK_RATE) + noise;
      }
    }
    if (s.aiJumpTick[T] >= 0 && s.tick >= s.aiJumpTick[T] && b.y === 0 && b.jump === 'none') {
      startJump(s, b, 'block', AI_BLOCK_CHARGE);
      s.aiJumpTick[T] = Number.MAX_SAFE_INTEGER; // 1回だけ
    }
    return { x: clamp(spot.x, -4.3, 4.3), z: spot.z };
  }
  return null;
}

/** ボールが打点に最も近づいた瞬間なら、ぶれのあるタイミングで打つ */
function tryHit(s: GameState, p: Player, kind: ContactKind): void {
  const T = p.team;
  if (s.aiMissTick[T] >= 0 || s.pending || s.landTick >= 0) return; // 床に落ちたボールは打たない
  const b0 = ballAt(s, s.tick);
  const b1 = ballAt(s, s.tick + 1);
  if (!b0 || !b1) return;
  const d0 = contactDist(s, p, kind, s.tick, b0);
  const d1 = contactDist(s, p, kind, s.tick + 1, b1);
  if (d0 > maxReachOf(kind, ballSpeed(s)) || d1 < d0) return;
  const dive = d0 > reachOf(kind, ballSpeed(s)); // 普通には届かない：フライング
  if (dive && rand(s.rng) >= AI.diveRate) {
    s.aiMissTick[T] = s.tick; // 飛び込まずに見送る
    return;
  }

  const vIn = Math.hypot(s.ball.vel.x, s.ball.vel.y, s.ball.vel.z);
  const sigma = AI.timingSigma * (1 + Math.max(0, vIn - 8) * AI.fastBallSigma);
  const dt = randNormal(s.rng) * sigma;
  const judgment = judgeOf(dt, kind);
  let charge = randRange(s.rng, AI.chargeMin, AI.chargeMax);
  let mx = 0;
  let mf = 0;
  if (kind === 'toss') s.tossTarget = chooseAttacker(s, T, p, 0, true).id;
  if (kind === 'spike') {
    // いくつか狙いを考え、相手の選手から最も遠い所を選ぶ
    let bestGap = -1;
    for (let k = 0; k < AI.aimSamples; k++) {
      const cx = randRange(s.rng, -1.15, 1.15);
      const cf = randRange(s.rng, -0.8, 0.8);
      const a = spikeAim(T, p, cx, cf);
      const t = toWorld(T, a.lx, a.lz);
      let gap = Infinity;
      for (const q of s.players) if (q.team !== T) gap = Math.min(gap, dist2(q.x, q.z, t.x, t.z));
      if (gap > bestGap) {
        bestGap = gap;
        mx = cx;
        mf = cf;
      }
    }
    charge = randRange(s.rng, AI.spikeChargeMin, AI.spikeChargeMax); // 人が空中で溜められる範囲に合わせる
    if (s.rules.feint && rand(s.rng) < AI.feintRate) charge = 0.05;
  }
  const action: ActionKind = kind === 'spike' || kind === 'feint' ? 'spike' : kind === 'free' ? 'free' : kind === 'toss' ? 'toss' : 'receive';
  s.events.push({ type: 'judge', team: T, player: p.id, judgment, action, dt, charge, dive });
  if (kind === 'spike') p.swung = true;
  if (judgment === 'MISS') {
    s.aiMissTick[T] = s.tick;
    return;
  }
  if (dive) startDive(s, p, s.tick);
  applyContact(s, { tick: s.tick, team: T, player: p.id, kind, judgment, charge, mx, mf, dt, dive }, s.tick);
}

function aiServe(s: GameState, T: TeamId): void {
  serveToss(s);
  const dt = randNormal(s.rng) * AI.timingSigma;
  const j = judgeOf(dt);
  s.pending = {
    tick: serveHitTick(s),
    team: T,
    player: s.server,
    kind: 'serve',
    judgment: j === 'MISS' ? 'BAD' : j,
    charge: randRange(s.rng, 0.2, 0.8),
    mx: randRange(s.rng, -1, 1),
    mf: 0,
    dt,
  };
}

/** 2点間を速度上限つきで進める */
export function moveToward(p: Player, t: Target, speed: number, dt: number): void {
  const dx = t.x - p.x;
  const dz = t.z - p.z;
  const d = dist2(p.x, p.z, t.x, t.z);
  if (d < 0.02) {
    p.vx = 0;
    p.vz = 0;
    return;
  }
  const step = Math.min(d, speed * dt);
  p.x += (dx / d) * step;
  p.z += (dz / d) * step;
  p.vx = ((dx / d) * step) / dt;
  p.vz = ((dz / d) * step) / dt;
}
