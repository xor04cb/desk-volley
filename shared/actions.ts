// 打球・ジャンプ・判定・操作選手の切り替えなど、ゲームの中核となる処理
import {
  AI,
  BALL_RADIUS,
  BLOCK_DEPTH,
  BLOCK_HALF_WIDTH,
  BLOCK_HAND_BOTTOM,
  BLOCK_HAND_TOP,
  BLOCK_JUMP_MAX,
  BLOCK_JUMP_MIN,
  BLOCK_RESTITUTION,
  CHARGE_MAX,
  DIVE_FRAME_RADIUS,
  DIVE_HAND_OFFSET,
  DIVE_REACH,
  DIVE_REACH_FAST,
  DIVE_SCATTER_MUL,
  FEINT_APEX_ABOVE_NET,
  FEINT_MAX_DIST,
  FRONT_RECEIVE_DEPTH,
  G,
  JUDGE_EFFECT,
  JUDGE_WINDOW_TICKS,
  JUMP_HEIGHT_MAX,
  JUMP_HEIGHT_MIN,
  NET_HEIGHT,
  PLAYER_SPEED,
  RECEIVE_APEX_MAX,
  RECEIVE_APEX_MIN,
  RECEIVE_EASY_SPEED,
  RECEIVE_SPEED_PENALTY,
  RECEIVE_HIT_HEIGHT,
  RECEIVE_FAST_SPEED,
  RECEIVE_REACH,
  RECEIVE_REACH_FAST,
  RECEIVE_SCATTER_MAX,
  RECEIVE_SCATTER_MIN,
  SERVE_AIM_LX,
  SERVE_RECEIVE_APEX_BONUS,
  SERVE_APEX_FAST,
  SERVE_APEX_SLOW,
  SERVE_HIT_HEIGHT,
  SERVE_SCATTER_MAX,
  SERVE_SCATTER_MIN,
  SERVE_TARGET_LZ,
  SERVE_TOSS_HEIGHT,
  SET_TARGET,
  SPIKE_AIM_LX,
  SPIKE_CHARGE_FLOOR,
  SPIKE_CHARGE_MAX,
  SPIKE_FRAME_RADIUS,
  SPIKE_REACH,
  SPIKE_SCATTER_MAX,
  SPIKE_SCATTER_MIN,
  SPIKE_SPEED_MAX,
  SPIKE_SPEED_MIN,
  SPIKE_TARGET_LZ,
  STANDING_REACH,
  TICK_RATE,
  TOSS_AIM_MAX_DIST,
  TOSS_APEX_MAX,
  TOSS_APEX_MIN,
  TOSS_HIT_HEIGHT,
  TOSS_REACH,
  TOSS_SCATTER_MAX,
  TOSS_SCATTER_MIN,
  TOSS_TARGET_LX,
  TOSS_TARGET_LZ,
} from './constants.ts';
import { FORMATION, isFrontRow, judgeOf, positionOf, toLocal, toWorld } from './court.ts';
import { launch, predict, sideOf, solveByApex, solveBySpeed, stepBall, type BallEvent } from './physics.ts';
import { rand, randInCircle, randRange } from './prng.ts';
import type { ActionKind, ContactInfo, ContactKind, GameState, Judgment, PendingContact, Player, TeamId } from './types.ts';
import { clamp, copy3, dist2, dist3, lerp, v3, type Vec3 } from './vec.ts';

// ---------------------------------------------------------------- 予測・履歴

/** 予測軌道を計算し直す。baseTick はボールが今の位置にいるtick */
export function computePath(s: GameState, baseTick = s.tick): void {
  if (s.ball.mode !== 'flying') {
    s.path = [];
    s.pathTick = baseTick;
    s.predLandTick = -1;
    return;
  }
  const p = predict(s.ball, 480);
  s.path = p.path;
  s.pathTick = baseTick;
  s.predLandTick = p.landTicks > 0 ? baseTick + p.landTicks : -1;
  s.predLandX = p.landX;
  s.predLandZ = p.landZ;
}

export function historyAt(s: GameState, t: number) {
  // 履歴は古い順に並ぶ。末尾から探す
  for (let i = s.history.length - 1; i >= 0; i--) {
    const h = s.history[i];
    if (h.tick === t) return h;
    if (h.tick < t) break;
  }
  return null;
}

/** tick t のボール位置（過去は履歴、未来は予測）。分からなければ null */
export function ballAt(s: GameState, t: number): Vec3 | null {
  if (t <= s.tick) {
    if (t === s.tick) return s.ball.mode === 'held' ? null : s.ball.pos;
    const h = historyAt(s, t);
    if (!h || h.mode === 'held') return null;
    return h.ball;
  }
  if (s.ball.mode !== 'flying') return null;
  return s.path[t - s.pathTick - 1] ?? null;
}

/** tick t の選手の位置（未来はジャンプの放物線だけ外挿） */
export function playerAt(s: GameState, p: Player, t: number): Vec3 {
  if (t < s.tick) {
    const h = historyAt(s, t);
    if (h) return { x: h.players[p.id * 3], y: h.players[p.id * 3 + 2], z: h.players[p.id * 3 + 1] };
  }
  if (t <= s.tick || p.y <= 0) return { x: p.x, y: p.y, z: p.z };
  const tau = (t - s.tick) / TICK_RATE;
  const y = Math.max(0, p.y + p.vy * tau - 0.5 * G * tau * tau);
  return { x: p.x + p.vx * tau * (y > 0 ? 1 : 0), y, z: p.z + p.vz * tau * (y > 0 ? 1 : 0) };
}

export function hitPoint(s: GameState, p: Player, kind: ContactKind, t: number): Vec3 {
  const q = playerAt(s, p, t);
  switch (kind) {
    case 'receive':
    case 'free':
      return v3(q.x, RECEIVE_HIT_HEIGHT, q.z);
    case 'toss':
      return v3(q.x, TOSS_HIT_HEIGHT, q.z);
    case 'serve':
      return v3(q.x, SERVE_HIT_HEIGHT, q.z);
    default:
      return v3(q.x, q.y + STANDING_REACH, q.z);
  }
}

/** 届く距離。レシーブは打球が速いほど狭くなる */
export function reachOf(kind: ContactKind, ballSpeed = 0): number {
  if (kind === 'receive' || kind === 'free') {
    const k = clamp((ballSpeed - RECEIVE_EASY_SPEED) / (RECEIVE_FAST_SPEED - RECEIVE_EASY_SPEED), 0, 1);
    return lerp(RECEIVE_REACH, RECEIVE_REACH_FAST, k);
  }
  if (kind === 'toss') return TOSS_REACH;
  if (kind === 'serve') return 1.5;
  return SPIKE_REACH;
}

/**
 * 打点とボールの距離（tick t）。判定のタイミング探しと届くかどうかに使う。
 * スパイクは落下予測円の中にいれば横のずれを無視し、下りてくるボールと手の高さの差だけで見る
 * （低いトスは、手の高さでは円の手前にあるため）。
 */
export function contactDist(s: GameState, p: Player, kind: ContactKind, t: number, b: Vec3): number {
  const h = hitPoint(s, p, kind, t);
  if (kind === 'spike' && s.predLandTick >= 0 && dist2(h.x, h.z, s.predLandX, s.predLandZ) <= SPIKE_FRAME_RADIUS) {
    const prev = ballAt(s, t - 1);
    if (!prev || b.y <= prev.y) return Math.abs(b.y - h.y);
  }
  return dist3(b, h);
}

// ---------------------------------------------------------------- タイミング判定

export interface JudgeResult {
  judgment: Judgment;
  tStar: number;
  dt: number;
  /** 普通には届かず、フライングで届く */
  dive: boolean;
}

/** フライングできる動作（床に近いボールを上げる動作だけ） */
export const canDive = (kind: ContactKind): boolean => kind === 'receive' || kind === 'free';

/** 届く距離（フライングを含む） */
export function maxReachOf(kind: ContactKind, ballSpeed = 0): number {
  if (!canDive(kind)) return reachOf(kind, ballSpeed);
  // 速い打球ほどフライングでも伸びない（強打を何でも拾えてしまわないように）
  const k = clamp((ballSpeed - RECEIVE_EASY_SPEED) / (RECEIVE_FAST_SPEED - RECEIVE_EASY_SPEED), 0, 1);
  return reachOf(kind, ballSpeed) + lerp(DIVE_REACH, DIVE_REACH_FAST, k);
}

/**
 * ボタンを離した tick と、ボールが打点に最も近づく tick の差で評価する。
 * 判定窓（±250ms）の中で最も近い時刻を探し、届く距離になければ MISS。
 */
export function judgeRelease(s: GameState, p: Player, kind: ContactKind, releaseTick: number): JudgeResult {
  const W = JUDGE_WINDOW_TICKS;
  let best = Infinity;
  let bestT = -1;
  // 床に落ちた後に離したら、遅れて離した扱いで巻き戻すことはしない（落ちたボールが上がって見えるため）
  if (s.landTick >= 0 && releaseTick >= s.landTick) return { judgment: 'MISS', tStar: -1, dt: 0, dive: false };
  // 窓の外側1tickも見て、最小が窓の端に張り付いていないか確かめる
  for (let t = releaseTick - W - 1; t <= releaseTick + W + 1; t++) {
    if (s.landTick >= 0 && t >= s.landTick) break; // 跳ね返ったボールは打てない
    const b = ballAt(s, t);
    if (!b) continue;
    const d = contactDist(s, p, kind, t, b);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  if (bestT < 0 || best > maxReachOf(kind, ballSpeed(s))) return { judgment: 'MISS', tStar: -1, dt: 0, dive: false };
  const dt = (releaseTick - bestT) / TICK_RATE;
  return { judgment: judgeOf(dt, kind), tStar: bestT, dt, dive: best > reachOf(kind, ballSpeed(s)) };
}

/**
 * 人のフライング：dir（ワールド座標の向き）へ飛び込む。手が落下予測円に入らなければ上がらない。
 * 飛び込む長さは、その向きで円に最も近づく所まで（最大でフライングの届く距離）。
 */
export function aimDive(s: GameState, p: Player, dir: { x: number; z: number }): { x: number; z: number; ok: boolean } {
  const n = Math.hypot(dir.x, dir.z) || 1;
  const ux = dir.x / n;
  const uz = dir.z / n;
  const lx = s.predLandTick >= 0 ? s.predLandX : s.ball.pos.x;
  const lz = s.predLandTick >= 0 ? s.predLandZ : s.ball.pos.z;
  const reach = maxReachOf('receive', ballSpeed(s));
  const along = clamp((lx - p.x) * ux + (lz - p.z) * uz, 0, reach);
  const hx = p.x + ux * along;
  const hz = p.z + uz * along;
  const back = Math.min(DIVE_HAND_OFFSET, along); // 体は手より少し手前
  return { x: hx - ux * back, z: hz - uz * back, ok: dist2(hx, hz, lx, lz) <= DIVE_FRAME_RADIUS };
}

/** フライング：打点のボールに向かって（body を渡せばその位置へ）飛び込む。起き上がるまで動けない */
export function startDive(s: GameState, p: Player, ballTick: number, body?: { x: number; z: number }): void {
  if (body) {
    const dx = body.x - p.x;
    const dz = body.z - p.z;
    const d = Math.hypot(dx, dz);
    p.diveTick = s.tick;
    p.diveX = body.x;
    p.diveZ = body.z;
    p.vx = 0;
    p.vz = 0;
    if (d > 1e-6) {
      p.fx = dx / d;
      p.fz = dz / d;
    }
    return;
  }
  const b = ballAt(s, ballTick) ?? s.ball.pos;
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  const d = Math.hypot(dx, dz) || 1;
  // 体は、ボールの手前（選手側）に手が届く位置まで滑り込む
  const k = Math.min(DIVE_HAND_OFFSET / d, 1);
  p.diveTick = s.tick;
  p.diveX = b.x + dx * k;
  p.diveZ = b.z + dz * k;
  p.vx = 0;
  p.vz = 0;
  p.fx = -dx / d;
  p.fz = -dz / d;
}

export const ballSpeed = (s: GameState): number => Math.hypot(s.ball.vel.x, s.ball.vel.y, s.ball.vel.z);

/** 押していた時間から溜め量（0〜1）。スパイクは空中で溜める時間が短いので最大までの時間も短い */
export const chargeOf = (pressTick: number, releaseTick: number, action?: ActionKind): number =>
  clamp((releaseTick - pressTick) / TICK_RATE / (action === 'spike' ? SPIKE_CHARGE_MAX : CHARGE_MAX), 0, 1);

// ---------------------------------------------------------------- 打球

/** 判定済みの打球を、適切なタイミングで実行する（未来なら予約、過去なら巻き戻し） */
export function scheduleContact(s: GameState, pc: PendingContact): void {
  if (pc.tick > s.tick) {
    s.pending = pc;
  } else if (pc.tick === s.tick) {
    applyContact(s, pc, s.tick);
  } else {
    rewindContact(s, pc);
  }
}

/** 過去の tick に戻ってボールを打ち、現在までボールだけ進め直す */
function rewindContact(s: GameState, pc: PendingContact): void {
  const h = historyAt(s, pc.tick);
  if (!h || s.phase === 'point' || s.phase === 'matchEnd') {
    applyContact(s, pc, s.tick);
    return;
  }
  s.ball.pos = copy3(h.ball);
  s.ball.vel = copy3(h.vel);
  s.ball.mode = 'flying';
  s.ball.grounded = h.grounded;
  if (s.landTick > pc.tick) s.landTick = -1;
  if (!applyContact(s, pc, pc.tick)) {
    // 打てなかった場合は元に戻す（予測からやり直す）
    computePath(s, pc.tick);
  }
  for (let t = pc.tick; t < s.tick; t++) {
    advanceBall(s, t);
    const e = historyAt(s, t + 1);
    if (e) {
      e.ball = copy3(s.ball.pos);
      e.vel = copy3(s.ball.vel);
      e.mode = s.ball.mode;
      e.grounded = s.ball.grounded;
    }
  }
}

/** ボールを1tick進め、ネット・通過・接地を処理する。t はボールが今いる tick */
export function advanceBall(s: GameState, t: number): void {
  const ev: BallEvent[] = [];
  stepBall(s.ball, ev);
  for (const e of ev) {
    if (e.type === 'net') {
      s.events.push({ type: 'net' });
      computePath(s, t + 1);
      updateActors(s);
    } else if (e.type === 'cross') {
      if (e.outside) s.antennaFault = true;
    } else if (e.type === 'land') {
      if (s.landTick < 0) {
        s.landTick = t + 1;
        s.landX = e.x;
        s.landZ = e.z;
      }
    }
  }
}

/** 打球を実行する。打てたら true */
export function applyContact(s: GameState, pc: PendingContact, ballTick: number): boolean {
  const p = s.players[pc.player];
  const team = s.teams[pc.team];
  const T = pc.team;
  if (pc.kind !== 'serve') {
    if (team.contactsLeft <= 0) return false;
    if (team.lastToucher === p.id && s.lastContactKind !== 'block') return false; // ドリブル
  }
  if (pc.judgment === 'MISS') return false;

  const eff = JUDGE_EFFECT[pc.judgment];
  const ce = pc.charge * eff.charge;
  const from = copy3(s.ball.pos);
  const opp = (1 - T) as TeamId;
  let kind = pc.kind;
  let tx = 0;
  let tz = 0;
  let apex = 0;
  let speed = 0;
  let scatter = 0;
  let vel: Vec3;

  if (kind === 'spike' && s.rules.feint && pc.charge < SPIKE_CHARGE_FLOOR) kind = 'feint';
  const diveMul = pc.dive ? DIVE_SCATTER_MUL : 1; // フライングは返球が乱れやすい

  switch (kind) {
    case 'receive': {
      const t = toWorld(T, SET_TARGET.lx, SET_TARGET.lz);
      const vIn = Math.hypot(s.ball.vel.x, s.ball.vel.y, s.ball.vel.z);
      scatter = lerp(RECEIVE_SCATTER_MAX, RECEIVE_SCATTER_MIN, ce) * eff.scatter * (1 + Math.max(0, vIn - RECEIVE_EASY_SPEED) * RECEIVE_SPEED_PENALTY) * diveMul;
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      apex = lerp(RECEIVE_APEX_MIN, RECEIVE_APEX_MAX, rand(s.rng));
      if (s.lastContactKind === 'serve') apex += SERVE_RECEIVE_APEX_BONUS; // サーブカットは高く上げる
      vel = solveByApex(from, tx, tz, apex);
      break;
    }
    case 'toss': {
      const atk = s.players[s.tossTarget >= 0 && s.players[s.tossTarget].team === T ? s.tossTarget : chooseAttacker(s, T, p, pc.mx).id];
      s.tossTarget = atk.id;
      const zone = attackZone(s, atk);
      const t = toWorld(T, TOSS_TARGET_LX[zone], TOSS_TARGET_LZ);
      scatter = lerp(TOSS_SCATTER_MAX, TOSS_SCATTER_MIN, eff.acc);
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      apex = lerp(TOSS_APEX_MIN, TOSS_APEX_MAX, ce);
      vel = solveByApex(from, tx, tz, apex);
      break;
    }
    case 'spike': {
      const c2 = s.rules.feint ? (pc.charge - SPIKE_CHARGE_FLOOR) / (1 - SPIKE_CHARGE_FLOOR) : pc.charge;
      const ce2 = clamp(c2, 0, 1) * eff.charge;
      const me = toLocal(T, p.x, p.z);
      const aimLx = Math.abs(pc.mx) > 0.25 ? pc.mx * SPIKE_AIM_LX : clamp(-me.lx * 0.5, -2.5, 2.5);
      const depth = clamp(SPIKE_TARGET_LZ - pc.mf * 2.5, 2, 8.5);
      // 相手コートの座標は「自チームから見て lz がマイナス」
      const t = toWorld(T, aimLx, -depth);
      scatter = lerp(SPIKE_SCATTER_MAX, SPIKE_SCATTER_MIN, eff.acc);
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      speed = lerp(SPIKE_SPEED_MIN, SPIKE_SPEED_MAX, ce2);
      vel = solveBySpeed(from, tx, tz, speed);
      break;
    }
    case 'feint': {
      const me = toLocal(T, p.x, p.z);
      const aimLx = Math.abs(pc.mx) > 0.25 ? pc.mx * 3 : clamp(me.lx + randRange(s.rng, -1.5, 1.5), -4, 4);
      const t = toWorld(T, aimLx, -randRange(s.rng, 1.0, FEINT_MAX_DIST));
      scatter = 0.4 * eff.scatter;
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      apex = Math.max(NET_HEIGHT + FEINT_APEX_ABOVE_NET, from.y + 0.3);
      vel = solveByApex(from, tx, tz, apex);
      break;
    }
    case 'free': {
      const t = toWorld(T, randRange(s.rng, -2.5, 2.5), -randRange(s.rng, 4, 7));
      scatter = lerp(2.0, 0.5, eff.acc) * diveMul;
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      apex = Math.max(5, from.y + 1);
      vel = solveByApex(from, tx, tz, apex);
      break;
    }
    case 'serve': {
      const t = toWorld(T, clamp(pc.mx * SERVE_AIM_LX, -3.5, 3.5), -SERVE_TARGET_LZ);
      scatter = lerp(SERVE_SCATTER_MIN, SERVE_SCATTER_MAX, pc.charge) * eff.scatter * 1.33;
      const off = randInCircle(s.rng, scatter);
      tx = t.x + off.x;
      tz = t.z + off.z;
      apex = lerp(SERVE_APEX_SLOW, SERVE_APEX_FAST, ce);
      vel = solveByApex(from, tx, tz, apex);
      break;
    }
    default:
      return false;
  }

  launch(s.ball, from, vel);
  if (kind === 'serve') {
    s.phase = 'rally';
    s.phaseTick = s.tick;
    team.contactsLeft = 0;
  } else {
    team.contactsLeft--;
  }
  team.lastToucher = p.id;
  s.teams[opp].contactsLeft = 3;
  s.teams[opp].lastToucher = -1;
  s.lastTouchTeam = T;
  s.lastContactKind = kind;
  s.blockedThisAttack = false;
  s.antennaFault = false;
  s.landTick = -1;
  if (kind !== 'toss') s.tossTarget = -1;
  s.aiMissTick = [-1, -1];
  s.aiJumpTick = [-1, -1];
  s.aiReadyTick[opp] = ballTick + Math.round((AI.reactionDelay + (kind === 'spike' ? AI.spikeReactionExtra : 0)) * TICK_RATE);
  computePath(s, ballTick);

  const info: ContactInfo = {
    tick: ballTick,
    team: T,
    player: p.id,
    kind,
    judgment: pc.judgment,
    charge: pc.charge,
    effCharge: ce,
    dt: pc.dt,
    dive: !!pc.dive,
    apex: kind === 'spike' ? Math.max(...s.path.slice(0, 60).map((q) => q.y), from.y) : apex,
    speed: Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z),
    scatter,
    targetX: tx,
    targetZ: tz,
    landX: s.predLandX,
    landZ: s.predLandZ,
  };
  s.lastContact = info;
  s.events.push({ type: 'contact', info });
  updateActors(s);
  return true;
}

/** トスを上げる相手を選ぶ。スティックを左に倒すとレフト、右でライト、中立でセンター側 */
export function chooseAttacker(s: GameState, team: TeamId, tosser: Player, mx: number, random = false): Player {
  let cands = s.players.filter((q) => q.team === team && q.id !== tosser.id && isFrontRow(positionOf(s, q)));
  if (cands.length === 0) cands = s.players.filter((q) => q.team === team && q.id !== tosser.id);
  if (random) return cands[Math.floor(rand(s.rng) * cands.length)];
  const want = mx < -0.35 ? -3.3 : mx > 0.35 ? 3.3 : 0;
  let best = cands[0];
  let bd = Infinity;
  for (const q of cands) {
    const d = Math.abs(FORMATION.offense[positionOf(s, q)][0] - want);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/**
 * 人のトスを上げる相手。打点の近くにいるときだけスティックの左右で選ぶ
 * （ボールを追って走っている最中のスティックで勝手に決まらないように）。押している間、画面に印を出す。
 */
export function tossAimTarget(s: GameState, team: TeamId): Player {
  const t = s.teams[team];
  return chooseAttacker(s, team, s.players[t.controlled], nearTossPoint(s, team) ? t.mx : 0);
}

/** 操作選手がトスの打点の近くにいるか。近くでボタンを押している間は、スティックで動かず向きを選ぶ */
export function nearTossPoint(s: GameState, team: TeamId): boolean {
  const p = s.players[s.teams[team].controlled];
  const ip = interceptPoint(s, team, TOSS_HIT_HEIGHT);
  return ip !== null && Math.hypot(ip.x - p.x, ip.z - p.z) <= TOSS_AIM_MAX_DIST;
}

export function attackZone(s: GameState, p: Player): 'left' | 'center' | 'right' {
  const pos = positionOf(s, p);
  if (pos === 4 || pos === 5) return 'left';
  if (pos === 2 || pos === 1) return 'right';
  return 'center';
}

// ---------------------------------------------------------------- サーブトス

export function serveToss(s: GameState): void {
  const p = s.players[s.server];
  const dir = p.team === 0 ? -1 : 1;
  const from = v3(p.x, 1.3, p.z + dir * 0.25);
  const apex = SERVE_HIT_HEIGHT + SERVE_TOSS_HEIGHT * 0.4;
  launch(s.ball, from, v3(0, Math.sqrt(2 * G * (apex - from.y)), dir * 0.35));
  s.serveTossed = true;
  s.lastTouchTeam = p.team;
  computePath(s, s.tick);
  s.events.push({ type: 'serveToss', player: p.id });
}

/** サーブトス後、打点に最も近づく tick を返す */
export function serveHitTick(s: GameState): number {
  const p = s.players[s.server];
  let best = Infinity;
  let bt = s.tick;
  for (let i = 0; i < s.path.length; i++) {
    const t = s.pathTick + i + 1;
    const d = dist3(s.path[i], hitPoint(s, p, 'serve', t));
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return bt;
}

// ---------------------------------------------------------------- ジャンプ・ブロック

export function startJump(s: GameState, p: Player, kind: 'attack' | 'block', charge: number): void {
  if (p.y > 0 || p.jump !== 'none') return;
  const h = kind === 'attack' ? lerp(JUMP_HEIGHT_MIN, JUMP_HEIGHT_MAX, charge) : lerp(BLOCK_JUMP_MIN, BLOCK_JUMP_MAX, charge);
  p.vy = Math.sqrt(2 * G * h);
  p.y = 0.0001;
  p.jump = kind;
  p.swung = false;
  // その場で真上に跳ぶ（助走の勢いは残さない）
  p.vx = 0;
  p.vz = 0;
  s.events.push({ type: 'jump', player: p.id, height: h, charge });
}

/** ジャンプにかかる上昇時間（秒） */
export const riseTime = (h: number): number => Math.sqrt((2 * h) / G);

export function stepJumps(s: GameState): void {
  const dt = 1 / TICK_RATE;
  for (const p of s.players) {
    if (p.jump === 'none') continue;
    p.y += p.vy * dt - 0.5 * G * dt * dt;
    p.vy -= G * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.jump = 'none';
      p.vx = 0;
      p.vz = 0;
    }
  }
}

/** ブロックの手にボールが当たったか調べ、当たったら跳ね返す */
export function checkBlocks(s: GameState): void {
  if (s.blockedThisAttack || s.ball.mode !== 'flying' || s.lastTouchTeam < 0) return;
  if (s.lastContactKind === 'serve' || s.lastContactKind === 'block') return; // サーブはブロックできない
  const b = s.ball.pos;
  for (const p of s.players) {
    if (p.jump !== 'block' || p.team === s.lastTouchTeam) continue;
    const { lz: blz } = toLocal(p.team, b.x, b.z);
    // 手はネットの上から相手側に少し出る
    if (blz < -0.35 || blz > BLOCK_DEPTH) continue;
    if (Math.abs(b.x - p.x) > BLOCK_HALF_WIDTH + BALL_RADIUS) continue;
    if (b.y < p.y + BLOCK_HAND_BOTTOM - BALL_RADIUS || b.y > p.y + BLOCK_HAND_TOP + BALL_RADIUS) continue;
    applyBlock(s, p);
    return;
  }
}

function applyBlock(s: GameState, p: Player): void {
  const v = s.ball.vel;
  const T = p.team;
  const attacker = (1 - T) as TeamId;
  const top = s.ball.pos.y > p.y + BLOCK_HAND_TOP - 0.08;
  if (top) {
    // 手の上端に当たった：勢いが落ちて自陣側へ（ワンタッチ）
    v.z *= 0.45;
    v.y = Math.abs(v.y) * 0.3 + 2.5;
    v.x += randRange(s.rng, -1, 1);
  } else {
    v.z = -v.z * BLOCK_RESTITUTION;
    v.y = -Math.abs(v.y) * 0.3 - 1;
    v.x = v.x * 0.5 + randRange(s.rng, -1.5, 1.5);
  }
  // ボールをネットの手前側（攻撃側）へ戻しておくと、すぐ下でネット判定に引っかからない
  s.blockedThisAttack = true;
  s.lastTouchTeam = T;
  s.lastContactKind = 'block';
  s.teams[T].lastToucher = p.id;
  // ブロックはコンタクト数に数えない。攻撃側へ戻れば攻撃側はまた3回触れる
  s.teams[T].contactsLeft = 3;
  s.teams[attacker].contactsLeft = 3;
  s.teams[attacker].lastToucher = -1;
  s.antennaFault = false;
  s.aiMissTick = [-1, -1];
  s.aiReadyTick = [s.tick + 6, s.tick + 6];
  computePath(s, s.tick + 1);
  s.events.push({ type: 'block', player: p.id });
  updateActors(s);
}

// ---------------------------------------------------------------- 操作選手の自動切り替え

/** ボールが高さ height まで下りてくる、team 側の地点と tick */
export function interceptPoint(s: GameState, team: TeamId, height: number): { x: number; z: number; tick: number } | null {
  for (let i = 1; i < s.path.length; i++) {
    const q = s.path[i];
    if (sideOf(q.z) !== team) continue;
    if (q.y <= height && q.y < s.path[i - 1].y) return { x: q.x, z: q.z, tick: s.pathTick + i + 1 };
  }
  if (s.predLandTick >= 0 && sideOf(s.predLandZ) === team) return { x: s.predLandX, z: s.predLandZ, tick: s.predLandTick };
  return null;
}

/** 選手が地点に着くまでの秒数（空中なら着地までの時間を足す） */
export function travelTime(p: Player, x: number, z: number): number {
  let air = 0;
  if (p.y > 0) air = (p.vy + Math.sqrt(p.vy * p.vy + 2 * G * p.y)) / G;
  return air + dist2(p.x, p.z, x, z) / PLAYER_SPEED;
}

/** 地点に（空中かどうかに関わらず）距離が最も近い選手 */
export function nearestTo(s: GameState, team: TeamId, x: number, z: number, exclude: number): Player {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of s.players) {
    if (p.team !== team || p.id === exclude) continue;
    const d = dist2(p.x, p.z, x, z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best!;
}

export function fastestTo(s: GameState, team: TeamId, x: number, z: number, exclude: number, row: 'all' | 'back' = 'all'): Player {
  let best: Player | null = null;
  let bt = Infinity;
  for (const p of s.players) {
    if (p.team !== team || p.id === exclude) continue;
    if (row === 'back' && isFrontRow(positionOf(s, p))) continue;
    const t = travelTime(p, x, z);
    if (t < bt) {
      bt = t;
      best = p;
    }
  }
  return best!;
}

/** 次に触るべきチームが team か（ボールが team 側に来る・留まる） */
export function ballComingTo(s: GameState, team: TeamId): boolean {
  if (s.ball.mode === 'held') return s.servingTeam === team;
  if (s.predLandTick >= 0) return sideOf(s.predLandZ) === team;
  return sideOf(s.ball.pos.z) === team;
}

/** 相手が攻撃しようとしているか（トス済み、または残り1回） */
export function opponentAttacking(s: GameState, team: TeamId): boolean {
  const opp = (1 - team) as TeamId;
  return s.lastTouchTeam === opp && ballComingTo(s, opp) && (s.lastContactKind === 'toss' || s.teams[opp].contactsLeft === 1);
}

/** 操作する選手を状況に合わせて切り替える（CPUチームでは「次に動く選手」として使う） */
export function updateActors(s: GameState): void {
  for (const T of [0, 1] as TeamId[]) {
    const team = s.teams[T];
    if (s.phase === 'serve' && !s.serveTossed) {
      team.controlled = s.servingTeam === T ? s.server : s.players.find((p) => p.team === T && positionOf(s, p) === 6)!.id;
      continue;
    }
    const doubleBan = s.lastTouchTeam === T && s.lastContactKind !== 'block' ? team.lastToucher : -1;
    if (ballComingTo(s, T)) {
      if (team.contactsLeft <= 0) continue;
      if (s.lastTouchTeam === T && s.lastContactKind === 'toss' && s.tossTarget >= 0) {
        team.controlled = s.tossTarget;
      } else if (s.lastTouchTeam === T && team.contactsLeft === 2) {
        // レシーブ後 → セッター（トスの打点に最も早く着ける選手）
        const ip = interceptPoint(s, T, TOSS_HIT_HEIGHT);
        if (ip) team.controlled = fastestTo(s, T, ip.x, ip.z, doubleBan).id;
      } else {
        // 1本目のボール（相手から来た、または自チームのブロックで跳ね返った）：
        // 前（ネットから FRONT_RECEIVE_DEPTH 以内）以外は後衛、相手のフェイントも後衛。
        // 自チームのブロック後に前へ落ちるボールは、前衛・後衛を問わず距離が近い選手（跳んでいたブロッカーも着地を待たずに候補にする）
        const ip = interceptPoint(s, T, RECEIVE_HIT_HEIGHT);
        let row: 'all' | 'back' = 'all';
        let nearest = false;
        if (ip && team.contactsLeft === 3) {
          const front = toLocal(T, ip.x, ip.z).lz <= FRONT_RECEIVE_DEPTH;
          if (!front || s.lastContactKind === 'feint') row = 'back';
          else if (s.lastTouchTeam === T && s.lastContactKind === 'block') nearest = true;
        }
        if (ip) team.controlled = (nearest ? nearestTo(s, T, ip.x, ip.z, doubleBan) : fastestTo(s, T, ip.x, ip.z, doubleBan, row)).id;
      }
    } else if (opponentAttacking(s, T)) {
      // 相手の攻撃 → ネット際の前衛でブロック
      team.controlled = blockerFor(s, T).id;
    }
  }
}

export function blockerFor(s: GameState, T: TeamId): Player {
  const ax = s.predLandTick >= 0 ? s.predLandX : s.ball.pos.x;
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of s.players) {
    if (p.team !== T || !isFrontRow(positionOf(s, p))) continue;
    const d = Math.abs(p.x - ax);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best!;
}
