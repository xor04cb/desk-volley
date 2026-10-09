// ゲームの進行。状態は「前の状態＋入力＋1tick」だけで決まる（決定論的）
import {
  AI,
  BALL_RADIUS,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  DIVE_RECOVER_TICKS,
  DIVE_SLIDE_TICKS,
  DT,
  HISTORY_TICKS,
  LANDING_GRACE_TICKS,
  OFFBALL,
  PLAYER_SPEED,
  POINT_PAUSE,
  STANDING_REACH,
  TICK_RATE,
  TWO_ATTACK_MAX_DIST,
} from './constants.ts';
import {
  advanceBall,
  aimDive,
  applyContact,
  ballComingTo,
  ballSpeed,
  chargeOf,
  checkBlocks,
  computePath,
  contactDist,
  hitPoint,
  interceptPoint,
  judgeRelease,
  maxReachOf,
  opponentAttacking,
  reachOf,
  scheduleContact,
  serveHitTick,
  serveToss,
  startDive,
  startJump,
  nearTossPoint,
  stepJumps,
  tossAimTarget,
  updateActors,
} from './actions.ts';
import { formationSpot, moveToward, runAI, type Target } from './ai.ts';
import { clampToSide, isFrontRow, playerAtPosition, positionOf, serveSpot, toLocal, toWorld } from './court.ts';
import { makeBall, sideOf } from './physics.ts';
import {
  autoTossActive,
  practiceActors,
  practiceLanded,
  practiceMoveTarget,
  practicePostStep,
  practicePreMove,
  practiceServingTeam,
  setupRep,
} from './practice.ts';
import { makeRng, rand } from './prng.ts';
import type { ActionKind, ContactKind, GameState, Player, PracticeKind, Rules, Team, TeamId, TossZone } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { clamp, dist2, dist3, v3 } from './vec.ts';

const NAMES: [string[], string[]] = [
  ['アオイ', 'ハル', 'ソラ', 'リク', 'ユウ', 'カイ'],
  ['レン', 'ミナト', 'タク', 'ショウ', 'ケン', 'ジン'],
];

export interface GameOptions {
  rules?: Partial<Rules>;
  seed?: number;
  /** 人が操作するチーム */
  humans?: [boolean, boolean];
  /** 練習モード（チーム0が人、チーム1がCPU） */
  practice?: { kind: PracticeKind; tossZone?: TossZone | 'random' };
}

function makeTeam(human: boolean): Team {
  return { score: 0, setsWon: 0, rotation: 0, contactsLeft: 3, lastToucher: -1, controlled: 0, pressTick: -1, mx: 0, mf: 0, human };
}

export function createGame(opts: GameOptions = {}): GameState {
  const humans = opts.humans ?? [true, false];
  const players: Player[] = [];
  for (const team of [0, 1] as TeamId[]) {
    for (let slot = 0; slot < 6; slot++) {
      players.push({
        id: team * 6 + slot,
        team,
        slot,
        name: NAMES[team][slot],
        x: 0,
        z: 0,
        y: 0,
        vy: 0,
        vx: 0,
        vz: 0,
        jump: 'none',
        swung: false,
        recoverTick: -1,
        diveTick: -1,
        diveX: 0,
        diveZ: 0,
        gx: 0,
        gz: 0,
        fx: 0,
        fz: team === 0 ? -1 : 1,
      });
    }
  }
  const s: GameState = {
    tick: 0,
    rules: { ...DEFAULT_RULES, ...opts.rules },
    rng: makeRng(opts.seed ?? 1),
    players,
    teams: [makeTeam(humans[0]), makeTeam(humans[1])],
    ball: makeBall(),
    phase: 'serve',
    phaseTick: 0,
    set: 1,
    setScores: [],
    servingTeam: 0,
    server: 0,
    serveTossed: false,
    lastTouchTeam: -1,
    lastContactKind: null,
    antennaFault: false,
    landTick: -1,
    landX: 0,
    landZ: 0,
    pending: null,
    predLandTick: -1,
    predLandX: 0,
    predLandZ: 0,
    pathTick: 0,
    path: [],
    history: [],
    lastContact: null,
    aiReadyTick: [0, 0],
    aiMissTick: [-1, -1],
    blockedThisAttack: false,
    tossTarget: -1,
    winner: -1,
    setPending: false,
    aiServeTick: 0,
    aiJumpTick: [-1, -1],
    practice: opts.practice
      ? { kind: opts.practice.kind, tossZone: opts.practice.tossZone ?? 'left', setter: -1, attacker: -1, nextRepTick: -1, aiOff: [false, false] }
      : null,
    events: [],
    stepEventCount: 0,
  };
  startServe(s);
  recordHistory(s);
  return s;
}

/** サーブの準備：全員を定位置へ、ボールをサーバーへ */
export function startServe(s: GameState): void {
  if (s.practice) s.servingTeam = practiceServingTeam(s.practice.kind);
  if (s.setPending) {
    s.setPending = false;
    s.set++;
    s.teams[0].score = 0;
    s.teams[1].score = 0;
    // セットごとにサーブ権を交互に
    s.servingTeam = ((s.set - 1) % 2) as TeamId;
  }
  s.phase = 'serve';
  s.phaseTick = s.tick;
  s.serveTossed = false;
  s.server = playerAtPosition(s, s.servingTeam, 1).id;
  s.lastTouchTeam = -1;
  s.lastContactKind = null;
  s.antennaFault = false;
  s.landTick = -1;
  s.pending = null;
  s.tossTarget = -1;
  s.blockedThisAttack = false;
  s.aiMissTick = [-1, -1];
  s.aiJumpTick = [-1, -1];
  s.aiReadyTick = [s.tick, s.tick];
  s.aiServeTick = s.tick + 60 + Math.floor(rand(s.rng) * 40);
  for (const t of s.teams) {
    t.contactsLeft = 3;
    t.lastToucher = -1;
    t.pressTick = -1;
  }
  for (const p of s.players) {
    const spot = p.id === s.server ? serveSpot(p.team) : formationSpot(s, p);
    p.x = p.gx = spot.x;
    p.z = p.gz = spot.z;
    p.y = 0;
    p.vy = 0;
    p.vx = 0;
    p.vz = 0;
    p.jump = 'none';
    p.swung = false;
    p.diveTick = -1;
    p.recoverTick = -1;
  }
  s.ball = makeBall();
  holdBall(s);
  computePath(s);
  updateActors(s);
  if (s.practice) setupRep(s); // 練習：1本の状況を作る
}

function holdBall(s: GameState): void {
  const p = s.players[s.server];
  const dir = p.team === 0 ? -1 : 1;
  // 右手で持つ（ネットを向いたときの右は、チーム0なら +x、チーム1なら -x）
  s.ball.pos = v3(p.x - dir * 0.25, 1.1, p.z + dir * 0.3);
}

// ---------------------------------------------------------------- 入力

export function setStick(s: GameState, team: TeamId, mx: number, mf: number): void {
  const len = Math.sqrt(mx * mx + mf * mf);
  const k = len > 1 ? 1 / len : 1;
  s.teams[team].mx = mx * k;
  s.teams[team].mf = mf * k;
}

/** ボタンを押した。tick を省略すると現在の tick（オンラインではクライアントの推定tick） */
export function press(s: GameState, team: TeamId, tick = s.tick): void {
  const t = s.teams[team];
  if (t.pressTick >= 0) return;
  t.pressTick = tick;
  if (s.phase === 'serve' && s.servingTeam === team && !s.serveTossed && t.controlled === s.server) serveToss(s);
}

/** ボタンを離した。この瞬間に動作が確定する */
export function release(s: GameState, team: TeamId, tick = s.tick): void {
  const t = s.teams[team];
  if (t.pressTick < 0) return;
  const p = s.players[t.controlled];
  const action = currentAction(s, team);
  const charge = chargeOf(t.pressTick, tick, action);
  t.pressTick = -1;
  switch (action) {
    case 'jump':
    case 'twoJump':
      startJump(s, p, 'attack', charge);
      return;
    case 'block':
      startJump(s, p, 'block', charge);
      return;
    case 'serve':
    case 'receive':
    case 'toss':
    case 'spike':
    case 'free': {
      if (s.pending && s.pending.team === team) return;
      const kind: ContactKind = action;
      const r = judgeRelease(s, p, kind, tick);
      // フライングはスティックの向き（倒していなければ走っていた向き）へ飛ぶ。手が落下予測円に入らなければ上がらない
      const aim = r.dive && r.judgment !== 'MISS' ? aimDive(s, p, diveDirection(p, t.mx, t.mf)) : null;
      if (aim && !aim.ok) r.judgment = 'MISS';
      s.events.push({ type: 'judge', team, player: p.id, judgment: r.judgment, action, dt: r.dt, charge, dive: r.dive });
      if (kind === 'spike') p.swung = true;
      if (aim) startDive(s, p, r.tStar, aim);
      if (r.judgment === 'MISS') return;
      if (kind === 'toss') s.tossTarget = tossAimTarget(s, team).id; // 押している間に印を出していた相手へ上げる
      scheduleContact(s, { tick: r.tStar, team, player: p.id, kind, judgment: r.judgment, charge, mx: t.mx, mf: t.mf, dt: r.dt, dive: r.dive });
      return;
    }
    default:
      return;
  }
}

/** フライングの向き（ワールド座標）：スティック → 走っていた向き → ネット方向 */
function diveDirection(p: Player, mx: number, mf: number): { x: number; z: number } {
  if (Math.hypot(mx, mf) > 0.2) return toWorld(p.team, mx, -mf);
  if (Math.hypot(p.vx, p.vz) > 0.5) return { x: p.vx, z: p.vz };
  return toWorld(p.team, 0, -1);
}

/** いまボタンを離したら何が起きるか（HUD表示にも使う） */
export function currentAction(s: GameState, team: TeamId): ActionKind {
  const t = s.teams[team];
  const p = s.players[t.controlled];
  if (s.phase === 'serve') return s.servingTeam === team && s.serveTossed && p.id === s.server ? 'serve' : 'none';
  if (s.phase !== 'rally') return 'none';
  if (team === 0 && autoTossActive(s)) return 'none'; // 練習：トスは味方セッターが自動で上げる
  if (p.diveTick >= 0) return 'none'; // フライング中は何もできない
  if (p.jump === 'attack') return p.swung ? 'none' : 'spike';
  if (p.jump === 'block') return 'none';
  if (ballComingTo(s, team)) {
    if (t.contactsLeft <= 0) return 'none';
    if (t.lastToucher === p.id && s.lastTouchTeam === team && s.lastContactKind !== 'block') return 'none';
    if (t.contactsLeft === 3) return 'receive';
    if (t.contactsLeft === 2) {
      const front = isFrontRow(positionOf(s, p)) && toLocal(team, p.x, p.z).lz < 3.5;
      if (!front || t.mf <= 0.5) return 'toss';
      // 走って追いかけている最中（打てる位置から遠い）はトスにする
      const hp = interceptPoint(s, team, STANDING_REACH + 0.3);
      const near = hp !== null && Math.hypot(hp.x - p.x, hp.z - p.z) <= TWO_ATTACK_MAX_DIST;
      return near ? 'twoJump' : 'toss';
    }
    // 残り1回：高いボールならジャンプ、低いボールなら山なりで返す
    const high = interceptPoint(s, team, STANDING_REACH + 0.3);
    return high ? 'jump' : 'free';
  }
  if (team === 0 && s.practice?.kind === 'spikeReceive') return 'none'; // 練習：拾う練習なのでブロックはしない
  if (opponentAttacking(s, team) || toLocal(team, p.x, p.z).lz < 1.6) return 'block';
  return 'none';
}

// ---------------------------------------------------------------- 1tick

export function step(s: GameState): void {
  // 前の step のイベントは読み終わっているので消す。その後の入力（press/release）で出たイベントは残して、この step の分と一緒に渡す
  s.events.splice(0, s.stepEventCount);

  // 予約された打球（ボタンを早めに離した場合など）
  if (s.pending && s.pending.tick <= s.tick) {
    const pc = s.pending;
    s.pending = null;
    const p = s.players[pc.player];
    const b = s.ball.pos;
    if (s.ball.mode === 'flying' && dist3(b, hitPoint(s, p, pc.kind, s.tick)) <= reachOf(pc.kind, ballSpeed(s)) * 1.5) {
      applyContact(s, pc, s.tick);
    }
  }

  if (s.phase === 'serve') stepServe(s);
  practicePreMove(s);
  movePlayers(s);
  if (s.ball.mode === 'flying') advanceBall(s, s.tick);
  else if (s.phase === 'serve' && !s.serveTossed) holdBall(s);
  checkBlocks(s);
  stepJumps(s);

  // 接地 → 少し待ってから得点を確定（遅れて離した入力の巻き戻しに備える）
  if ((s.phase === 'rally' || s.phase === 'serve') && s.landTick >= 0 && s.tick + 1 - s.landTick >= LANDING_GRACE_TICKS) {
    resolveLanding(s);
  }
  if (s.phase === 'point' && s.tick - s.phaseTick >= POINT_PAUSE * TICK_RATE) {
    if (s.winner >= 0) {
      s.phase = 'matchEnd';
      s.phaseTick = s.tick;
    } else startServe(s);
  }
  if (practicePostStep(s)) startServe(s); // 練習：次の1本
  else practiceActors(s);

  s.stepEventCount = s.events.length;
  s.tick++;
  recordHistory(s);
}

function stepServe(s: GameState): void {
  const team = s.teams[s.servingTeam];
  if (team.human && !s.serveTossed && s.tick - s.phaseTick >= s.rules.serveTime * TICK_RATE) {
    // 時間切れ：自動サーブ（溜め0・GOOD相当）
    team.pressTick = -1;
    serveToss(s);
    s.pending = { tick: serveHitTick(s), team: s.servingTeam, player: s.server, kind: 'serve', judgment: 'GOOD', charge: 0, mx: 0, mf: 0, dt: 0 };
  }
}

function movePlayers(s: GameState): void {
  const aiTargets: (Target | null)[] = [null, null];
  for (const T of [0, 1] as TeamId[]) if (!s.teams[T].human && !s.practice?.aiOff[T]) aiTargets[T] = runAI(s, T);

  for (const p of s.players) {
    const team = s.teams[p.team];
    if (p.diveTick >= 0) {
      // フライング：飛び込む先へ滑り込み、起き上がるまで動けない
      const e = s.tick - p.diveTick;
      if (e < DIVE_SLIDE_TICKS) {
        const k = 1 / (DIVE_SLIDE_TICKS - e);
        p.x += (p.diveX - p.x) * k;
        p.z += (p.diveZ - p.z) * k;
      }
      if (e >= DIVE_RECOVER_TICKS) p.diveTick = -1;
      clampToSide(p, false);
      continue;
    }
    if (s.tick < p.recoverTick) {
      // カットの直後は少しの間動けない
      p.vx = 0;
      p.vz = 0;
      continue;
    }
    if (p.jump !== 'none') {
      // 空中では動けない（踏み切りで速度を0にしているので、真上に上がって降りる）
      p.x += p.vx * DT;
      p.z += p.vz * DT;
      clampToSide(p, false);
      continue;
    }
    const isActor = team.controlled === p.id;
    const serving = s.phase === 'serve' && p.id === s.server;
    if (serving) {
      // サーバーはエンドラインの後ろで左右だけ動ける。トス後は動かない
      if (team.human && !s.serveTossed) {
        p.x = clamp(p.x + team.mx * (p.team === 0 ? 1 : -1) * PLAYER_SPEED * DT, -COURT_HALF_WIDTH + 0.3, COURT_HALF_WIDTH - 0.3);
      }
      p.vx = 0;
      p.vz = 0;
      continue;
    }
    if (s.phase === 'serve' && !s.serveTossed) continue; // サーブ前はその場で待つ
    // ボールの下でトスのボタンを押している間は、スティックはトスの向きを選ぶだけで動かない
    const aimingToss = isActor && team.human && team.pressTick >= 0 && currentAction(s, p.team) === 'toss' && nearTossPoint(s, p.team);
    if (aimingToss) {
      p.vx = 0;
      p.vz = 0;
    } else if (isActor && team.human) {
      const w = toWorld(p.team, team.mx, -team.mf);
      const nx = p.x + w.x * PLAYER_SPEED * DT;
      const nz = p.z + w.z * PLAYER_SPEED * DT;
      p.vx = (nx - p.x) / DT;
      p.vz = (nz - p.z) / DT;
      p.x = nx;
      p.z = nz;
    } else {
      const target = practiceMoveTarget(s, p) ?? (isActor && !team.human ? aiTargets[p.team] : null);
      if (target) moveToward(p, target, PLAYER_SPEED * AI.speedFactor, DT);
      else if (isActor) {
        p.vx = 0;
        p.vz = 0;
      } else moveOffBall(s, p);
    }
    if (isActor) {
      // ボールに向かう選手は陣形の目標を持たない（操作から外れたら、少し様子を見てから陣形へ戻る）
      p.gx = p.x;
      p.gz = p.z;
    }
    clampToSide(p, false);
    // 向き：走っていれば進行方向、止まっている・陣形の近くで動いているときはボールの方
    const sp = Math.hypot(p.vx, p.vz);
    const shuffling = !isActor && dist2(p.x, p.z, p.gx, p.gz) < OFFBALL.faceRunDist;
    if (sp > 0.3 && !shuffling) {
      p.fx = p.vx / sp;
      p.fz = p.vz / sp;
    } else {
      const dx = s.ball.pos.x - p.x;
      const dz = s.ball.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) {
        p.fx = dx / d;
        p.fz = dz / d;
      }
    }
  }
}

/**
 * 操作していない選手を陣形の位置へ動かす。
 * 打球の直後（自チームのスパイク・フェイントならボールがネットを越えるまで）は前の目標へ向かい続け、
 * 次にボールが落ちるまでに間に合う速さで、加速・減速しながら動く
 */
function moveOffBall(s: GameState, p: Player): void {
  const c = s.lastContact;
  const ownAttack = s.lastTouchTeam === p.team && (s.lastContactKind === 'spike' || s.lastContactKind === 'feint');
  const watching =
    s.phase === 'rally' && c !== null && (s.tick - c.tick < OFFBALL.reaction * TICK_RATE || (ownAttack && sideOf(s.ball.pos.z) === p.team));
  if (!watching) {
    const t = formationSpot(s, p);
    p.gx = t.x;
    p.gz = t.z;
  }
  const dx = p.gx - p.x;
  const dz = p.gz - p.z;
  const d = Math.hypot(dx, dz);
  const full = PLAYER_SPEED * AI.speedFactor;
  let want = 0;
  if (d > OFFBALL.stopDist) {
    // 次にボールが落ちるまでの時間で着ける速さ（急がなくてよいときはゆっくり）。近づいたら止まれる速さまで落とす
    const left = s.predLandTick >= 0 ? (s.predLandTick - s.tick) / TICK_RATE - OFFBALL.margin : Infinity;
    const pace = left > 0 ? d / left : full;
    want = Math.min(clamp(pace, full * OFFBALL.minPace, full), Math.sqrt(2 * OFFBALL.accel * d));
  }
  const wx = d > 1e-6 ? (dx / d) * want : 0;
  const wz = d > 1e-6 ? (dz / d) * want : 0;
  // 速度を目標の速度へ、加速度の上限つきで近づける
  const ax = wx - p.vx;
  const az = wz - p.vz;
  const a = Math.hypot(ax, az);
  const maxDv = OFFBALL.accel * DT;
  const k = a > maxDv ? maxDv / a : 1;
  p.vx += ax * k;
  p.vz += az * k;
  if (Math.hypot(p.vx, p.vz) < 0.05 && want === 0) {
    p.vx = 0;
    p.vz = 0;
  }
  p.x += p.vx * DT;
  p.z += p.vz * DT;
}

function resolveLanding(s: GameState): void {
  const x = s.landX;
  const z = s.landZ;
  const side = sideOf(z);
  const inCourt = Math.abs(x) <= COURT_HALF_WIDTH + BALL_RADIUS && Math.abs(z) <= COURT_HALF_LENGTH + BALL_RADIUS;
  if (s.practice) return practiceLanded(s); // 練習は点数を数えない（落ちたボールは打てないよう landTick は残す）
  s.landTick = -1;
  if (s.lastContactKind === null) return awardPoint(s, (1 - s.servingTeam) as TeamId, 'serveMiss');
  const last = s.lastTouchTeam === -1 ? s.servingTeam : s.lastTouchTeam;
  if (s.antennaFault) return awardPoint(s, (1 - last) as TeamId, 'antenna');
  if (inCourt) return awardPoint(s, (1 - side) as TeamId, 'in');
  return awardPoint(s, (1 - last) as TeamId, 'out');
}

export function setTarget(s: GameState): number {
  const final = s.rules.sets > 1 && s.set === s.rules.sets;
  return final ? s.rules.finalSetPoints : s.rules.pointsPerSet;
}

function awardPoint(s: GameState, team: TeamId, reason: 'in' | 'out' | 'antenna' | 'serveMiss' | 'fault'): void {
  const me = s.teams[team];
  const other = s.teams[1 - team];
  me.score++;
  s.events.push({ type: 'point', team, reason });
  if (team !== s.servingTeam) {
    // サイドアウト：サーブ権を得たチームがローテーション
    me.rotation = (me.rotation + 1) % 6;
    s.servingTeam = team;
  }
  const target = setTarget(s);
  const won = me.score >= target && (!s.rules.deuce || me.score - other.score >= 2);
  if (won) {
    me.setsWon++;
    s.setScores.push([s.teams[0].score, s.teams[1].score]);
    s.events.push({ type: 'setEnd', winner: team, set: s.set });
    if (me.setsWon >= Math.ceil(s.rules.sets / 2)) {
      s.winner = team;
      s.events.push({ type: 'matchEnd', winner: team });
    } else s.setPending = true;
  }
  s.phase = 'point';
  s.phaseTick = s.tick;
  s.pending = null;
  for (const t of s.teams) t.pressTick = -1;
}

function recordHistory(s: GameState): void {
  const players: number[] = new Array(s.players.length * 3);
  for (const p of s.players) {
    players[p.id * 3] = p.x;
    players[p.id * 3 + 1] = p.z;
    players[p.id * 3 + 2] = p.y;
  }
  s.history.push({
    tick: s.tick,
    ball: { ...s.ball.pos },
    vel: { ...s.ball.vel },
    mode: s.ball.mode,
    grounded: s.ball.grounded,
    drop: s.ball.drop,
    players,
  });
  if (s.history.length > HISTORY_TICKS) s.history.shift();
}

/** 操作中の選手から見たヒント用：ボールが打点に来るまでの秒数（来ないなら -1） */
export function timeToContact(s: GameState, team: TeamId): number {
  const action = currentAction(s, team);
  const p = s.players[s.teams[team].controlled];
  const kind: ContactKind | null =
    action === 'receive' || action === 'toss' || action === 'serve' || action === 'free' ? action : action === 'spike' ? 'spike' : null;
  if (!kind || s.ball.mode !== 'flying') return -1;
  let best = Infinity;
  let bt = -1;
  for (let i = 0; i < Math.min(s.path.length, 120); i++) {
    const t = s.pathTick + i + 1;
    if (t <= s.tick) continue;
    const d = contactDist(s, p, kind, t, s.path[i]);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  if (bt < 0 || best > Math.max(reachOf(kind, ballSpeed(s)) * 1.5, maxReachOf(kind, ballSpeed(s)))) return -1;
  return (bt - s.tick) / TICK_RATE;
}
