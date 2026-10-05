// CPUの判断。操作していない味方の位置取りと、CPUチームの打球・ジャンプ・ブロック
import {
  AI,
  BLOCK_JUMP_MAX,
  BLOCK_JUMP_MIN,
  JUMP_HEIGHT_MAX,
  JUMP_HEIGHT_MIN,
  PLAYER_MIN_NET_DIST,
  RECEIVE_HIT_HEIGHT,
  SPIKE_AIM_LX,
  SPIKE_TARGET_LZ,
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
  startDive,
  startJump,
} from './actions.ts';
import { FORMATION, isFrontRow, judgeOf, positionOf, toLocal, toWorld } from './court.ts';
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

/** 操作していない選手の定位置 */
export function formationSpot(s: GameState, p: Player): Target {
  const T = p.team;
  const pos = positionOf(s, p);
  let spot: readonly [number, number];
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
  if (s.aiMissTick[T] >= 0 || s.pending) return;
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
      const t = toWorld(T, cx * SPIKE_AIM_LX, -clamp(SPIKE_TARGET_LZ - cf * 2.5, 2, 8.5));
      let gap = Infinity;
      for (const q of s.players) if (q.team !== T) gap = Math.min(gap, dist2(q.x, q.z, t.x, t.z));
      if (gap > bestGap) {
        bestGap = gap;
        mx = cx;
        mf = cf;
      }
    }
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
