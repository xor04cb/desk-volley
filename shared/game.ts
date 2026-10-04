// ゲームの進行。状態は「前の状態＋入力＋1tick」だけで決まる（決定論的）
import {
  AI,
  BALL_RADIUS,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  DT,
  HISTORY_TICKS,
  LANDING_GRACE_TICKS,
  PLAYER_SPEED,
  POINT_PAUSE,
  STANDING_REACH,
  TICK_RATE,
} from './constants.ts';
import {
  advanceBall,
  applyContact,
  ballComingTo,
  ballSpeed,
  chargeOf,
  checkBlocks,
  computePath,
  hitPoint,
  interceptPoint,
  judgeRelease,
  opponentAttacking,
  reachOf,
  scheduleContact,
  serveHitTick,
  serveToss,
  startJump,
  stepJumps,
  updateActors,
} from './actions.ts';
import { formationSpot, moveToward, runAI, type Target } from './ai.ts';
import { clampToSide, isFrontRow, playerAtPosition, positionOf, serveSpot, toLocal, toWorld } from './court.ts';
import { makeBall, sideOf } from './physics.ts';
import { makeRng, rand } from './prng.ts';
import type { ActionKind, ContactKind, GameState, Player, Rules, Team, TeamId } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { clamp, dist3, v3 } from './vec.ts';

const NAMES: [string[], string[]] = [
  ['アオイ', 'ハル', 'ソラ', 'リク', 'ユウ', 'カイ'],
  ['レン', 'ミナト', 'タク', 'ショウ', 'ケン', 'ジン'],
];

export interface GameOptions {
  rules?: Partial<Rules>;
  seed?: number;
  /** 人が操作するチーム */
  humans?: [boolean, boolean];
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
    events: [],
  };
  startServe(s);
  recordHistory(s);
  return s;
}

/** サーブの準備：全員を定位置へ、ボールをサーバーへ */
export function startServe(s: GameState): void {
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
    p.x = spot.x;
    p.z = spot.z;
    p.y = 0;
    p.vy = 0;
    p.vx = 0;
    p.vz = 0;
    p.jump = 'none';
    p.swung = false;
  }
  s.ball = makeBall();
  holdBall(s);
  computePath(s);
  updateActors(s);
}

function holdBall(s: GameState): void {
  const p = s.players[s.server];
  const dir = p.team === 0 ? -1 : 1;
  s.ball.pos = v3(p.x + 0.25, 1.1, p.z + dir * 0.3);
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
  const charge = chargeOf(t.pressTick, tick);
  t.pressTick = -1;
  const p = s.players[t.controlled];
  const action = currentAction(s, team);
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
      s.events.push({ type: 'judge', team, player: p.id, judgment: r.judgment, action, dt: r.dt, charge });
      if (kind === 'spike') p.swung = true;
      if (r.judgment === 'MISS') return;
      scheduleContact(s, { tick: r.tStar, team, player: p.id, kind, judgment: r.judgment, charge, mx: t.mx, mf: t.mf, dt: r.dt });
      return;
    }
    default:
      return;
  }
}

/** いまボタンを離したら何が起きるか（HUD表示にも使う） */
export function currentAction(s: GameState, team: TeamId): ActionKind {
  const t = s.teams[team];
  const p = s.players[t.controlled];
  if (s.phase === 'serve') return s.servingTeam === team && s.serveTossed && p.id === s.server ? 'serve' : 'none';
  if (s.phase !== 'rally') return 'none';
  if (p.jump === 'attack') return p.swung ? 'none' : 'spike';
  if (p.jump === 'block') return 'none';
  if (ballComingTo(s, team)) {
    if (t.contactsLeft <= 0) return 'none';
    if (t.lastToucher === p.id && s.lastTouchTeam === team && s.lastContactKind !== 'block') return 'none';
    if (t.contactsLeft === 3) return 'receive';
    if (t.contactsLeft === 2) {
      const front = isFrontRow(positionOf(s, p)) && toLocal(team, p.x, p.z).lz < 3.5;
      return front && t.mf > 0.5 ? 'twoJump' : 'toss';
    }
    // 残り1回：高いボールならジャンプ、低いボールなら山なりで返す
    const high = interceptPoint(s, team, STANDING_REACH + 0.3);
    return high ? 'jump' : 'free';
  }
  if (opponentAttacking(s, team) || toLocal(team, p.x, p.z).lz < 1.6) return 'block';
  return 'none';
}

// ---------------------------------------------------------------- 1tick

export function step(s: GameState): void {
  s.events.length = 0;

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
  for (const T of [0, 1] as TeamId[]) if (!s.teams[T].human) aiTargets[T] = runAI(s, T);

  for (const p of s.players) {
    const team = s.teams[p.team];
    if (p.jump !== 'none') {
      // 空中では踏み切った勢いのまま
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
    if (isActor && team.human) {
      const w = toWorld(p.team, team.mx, -team.mf);
      const nx = p.x + w.x * PLAYER_SPEED * DT;
      const nz = p.z + w.z * PLAYER_SPEED * DT;
      p.vx = (nx - p.x) / DT;
      p.vz = (nz - p.z) / DT;
      p.x = nx;
      p.z = nz;
    } else {
      const target = isActor && !team.human && aiTargets[p.team] ? aiTargets[p.team]! : isActor && !team.human ? null : formationSpot(s, p);
      if (target) moveToward(p, target, PLAYER_SPEED * AI.speedFactor, DT);
      else {
        p.vx = 0;
        p.vz = 0;
      }
    }
    clampToSide(p, false);
    // 向き：動いていれば進行方向、止まっていればボールの方
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0.3) {
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

function resolveLanding(s: GameState): void {
  const x = s.landX;
  const z = s.landZ;
  const side = sideOf(z);
  const inCourt = Math.abs(x) <= COURT_HALF_WIDTH + BALL_RADIUS && Math.abs(z) <= COURT_HALF_LENGTH + BALL_RADIUS;
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
    const d = dist3(s.path[i], hitPoint(s, p, kind, t));
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  if (bt < 0 || best > reachOf(kind, ballSpeed(s)) * 1.5) return -1;
  return (bt - s.tick) / TICK_RATE;
}
