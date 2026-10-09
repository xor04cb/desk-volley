// 練習モード：試合のエンジンをそのまま使い、1本ごとに状況を作り直す。点数は数えない。
// チーム0が人、チーム1がCPU（サーブを打つ・スパイクを打つなどの球出し役）。
import { PRACTICE, RECEIVE_HIT_HEIGHT, SET_TARGET, TICK_RATE, TOSS_HIT_HEIGHT, TOSS_TARGET_LX, TOSS_TARGET_LZ } from './constants.ts';
import { applyContact, ballAt, ballComingTo, computePath, contactDist, interceptPoint, opponentAttacking, reachOf, updateActors } from './actions.ts';
import type { Target } from './ai.ts';
import { FORMATION, isFrontRow, playerAtPosition, positionOf, switchedPos, toWorld } from './court.ts';
import { launch, solveByApex } from './physics.ts';
import { rand } from './prng.ts';
import type { GameState, Player, PracticeKind, TeamId, TossZone } from './types.ts';
import { dist2, v3 } from './vec.ts';

const ZONES: TossZone[] = ['left', 'center', 'right'];

/** その練習でサーブを打つチーム（サーブ練習は自分、それ以外はCPU） */
export function practiceServingTeam(kind: PracticeKind): TeamId {
  return kind === 'serve' ? 0 : 1;
}

const hasSpike = (kind: PracticeKind) => kind === 'spike' || kind === 'serveCutSpike';

/** 前衛のうち、ゾーン（レフト・センター・ライト）で打つ選手 */
function attackerFor(s: GameState, T: TeamId, zone: TossZone): Player {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of s.players) {
    if (p.team !== T) continue;
    if (!isFrontRow(positionOf(s, p))) continue;
    const d = Math.abs(FORMATION.offense[switchedPos(s, p)][0] - TOSS_TARGET_LX[zone]);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best!;
}

/** ラリーの途中から始めるので、入れ替わった後のポジションで並べる */
function placeTeam(s: GameState, T: TeamId, f: keyof typeof FORMATION): void {
  for (const p of s.players) {
    if (p.team !== T) continue;
    const [lx, lz] = FORMATION[f][switchedPos(s, p)];
    const w = toWorld(T, lx, lz);
    p.x = w.x;
    p.z = w.z;
  }
}

/** チーム T が kind で触った直後のラリーの状態にする */
function rallyFrom(s: GameState, T: TeamId, kind: 'toss' | 'receive', contactsLeft: number, toucher: number): void {
  const opp = (1 - T) as TeamId;
  s.phase = 'rally';
  s.phaseTick = s.tick;
  s.serveTossed = true;
  s.lastTouchTeam = T;
  s.lastContactKind = kind;
  s.teams[T].contactsLeft = contactsLeft;
  s.teams[T].lastToucher = toucher;
  s.teams[opp].contactsLeft = 3;
  s.teams[opp].lastToucher = -1;
  s.aiReadyTick = [s.tick, s.tick];
  s.landTick = -1;
}

/** startServe の最後に呼ぶ：練習の種類に合わせて1本の状況を作る */
export function setupRep(s: GameState): void {
  const pr = s.practice!;
  pr.nextRepTick = -1;
  pr.setter = -1;
  pr.aiOff = [false, pr.kind === 'serve']; // サーブ練習では相手は拾わない
  const zone = pr.tossZone === 'random' ? ZONES[Math.floor(rand(s.rng) * 3)] : pr.tossZone;
  pr.attacker = hasSpike(pr.kind) ? attackerFor(s, 0, zone).id : -1;

  if (pr.kind === 'serveCut' || pr.kind === 'serveCutSpike') {
    s.aiServeTick = s.tick + Math.round(PRACTICE.serveDelay * TICK_RATE);
  } else if (pr.kind === 'spikeReceive') {
    // 相手のセッターがアタッカーへトスを上げたところから
    const z = ZONES[Math.floor(rand(s.rng) * 3)];
    const atk = attackerFor(s, 1, z);
    placeTeam(s, 0, 'defense');
    placeTeam(s, 1, 'offense');
    const f = toWorld(1, SET_TARGET.lx, SET_TARGET.lz);
    const t = toWorld(1, TOSS_TARGET_LX[z], TOSS_TARGET_LZ);
    const from = v3(f.x, TOSS_HIT_HEIGHT, f.z);
    launch(s.ball, from, solveByApex(from, t.x, t.z, PRACTICE.tossApex));
    const setter = s.players.find((p) => p.team === 1 && p.id !== atk.id && !isFrontRow(positionOf(s, p)))!;
    rallyFrom(s, 1, 'toss', 1, setter.id);
    s.tossTarget = atk.id;
  } else if (pr.kind === 'spike') {
    // 後衛からセッターへパスが返ってきたところから
    placeTeam(s, 0, 'offense');
    placeTeam(s, 1, 'defense');
    const passer = playerAtPosition(s, 0, 6);
    const st = toWorld(0, SET_TARGET.lx, SET_TARGET.lz);
    const setter = closestTo(s, 0, st.x, st.z, [passer.id, pr.attacker]);
    setter.x = st.x;
    setter.z = toWorld(0, SET_TARGET.lx, SET_TARGET.lz + 0.4).z;
    pr.setter = setter.id;
    const from = v3(passer.x, RECEIVE_HIT_HEIGHT, passer.z);
    launch(s.ball, from, solveByApex(from, st.x, st.z, PRACTICE.passApex));
    rallyFrom(s, 0, 'receive', 2, passer.id);
  }
  for (const p of s.players) {
    p.gx = p.x;
    p.gz = p.z;
  }
  computePath(s);
  updateActors(s);
  practiceActors(s);
}

function closestTo(s: GameState, T: TeamId, x: number, z: number, exclude: number[]): Player {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of s.players) {
    if (p.team !== T || exclude.includes(p.id)) continue;
    const d = dist2(p.x, p.z, x, z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best!;
}

/** 味方セッターが自動でトスを上げる場面か（スパイクのある練習で、自チームの2本目） */
export function autoTossActive(s: GameState): boolean {
  const pr = s.practice;
  return (
    !!pr && hasSpike(pr.kind) && pr.nextRepTick < 0 && s.phase === 'rally' && s.lastTouchTeam === 0 && s.teams[0].contactsLeft === 2 && ballComingTo(s, 0)
  );
}

/** 操作する選手の上書き：自動トスの間は打つ選手、スパイクレシーブではブロックに跳ばず後衛で待つ */
export function practiceActors(s: GameState): void {
  const pr = s.practice;
  if (!pr) return;
  if (autoTossActive(s)) s.teams[0].controlled = pr.attacker;
  else if (pr.kind === 'spikeReceive' && opponentAttacking(s, 0)) s.teams[0].controlled = playerAtPosition(s, 0, 6).id;
}

/** 選手を動かす前に呼ぶ：操作選手の上書きと、味方セッターの自動トス */
export function practicePreMove(s: GameState): void {
  const pr = s.practice;
  if (!pr) return;
  practiceActors(s);
  if (!autoTossActive(s)) return;
  if (pr.setter < 0) {
    // サーブカットの後：カットした人と打つ人以外で、トスの打点に一番近い選手がセッター
    const ip = interceptPoint(s, 0, TOSS_HIT_HEIGHT);
    if (!ip) return;
    pr.setter = closestTo(s, 0, ip.x, ip.z, [s.teams[0].lastToucher, pr.attacker]).id;
  }
  if (s.pending || s.landTick >= 0) return;
  const p = s.players[pr.setter];
  const b0 = ballAt(s, s.tick);
  const b1 = ballAt(s, s.tick + 1);
  if (!b0 || !b1) return;
  const d0 = contactDist(s, p, 'toss', s.tick, b0);
  const d1 = contactDist(s, p, 'toss', s.tick + 1, b1);
  if (d0 > reachOf('toss') || d1 < d0) return;
  s.tossTarget = pr.attacker;
  applyContact(s, { tick: s.tick, team: 0, player: p.id, kind: 'toss', judgment: 'PERFECT', charge: PRACTICE.tossCharge, mx: 0, mf: 0, dt: 0 }, s.tick);
}

/** 自動トスを上げる味方セッターの行き先（それ以外は null） */
export function practiceMoveTarget(s: GameState, p: Player): Target | null {
  const pr = s.practice;
  if (!pr || p.id !== pr.setter || !autoTossActive(s)) return null;
  const ip = interceptPoint(s, 0, TOSS_HIT_HEIGHT);
  return ip ? { x: ip.x, z: ip.z } : null;
}

function endRep(s: GameState, sec: number): void {
  const pr = s.practice!;
  const t = s.tick + Math.round(sec * TICK_RATE);
  pr.nextRepTick = pr.nextRepTick < 0 ? t : Math.min(pr.nextRepTick, t);
  pr.aiOff = [true, true];
}

/** ボールが床に落ちた（練習では得点にせず、1本を終える） */
export function practiceLanded(s: GameState): void {
  endRep(s, PRACTICE.afterLand);
}

/** 1tickの最後に呼ぶ：1本の終わりを見つける。次の1本を始めるときは true */
export function practicePostStep(s: GameState): boolean {
  const pr = s.practice;
  if (!pr) return false;
  if (pr.nextRepTick < 0) {
    for (const e of s.events) {
      if (e.type !== 'contact' || e.info.team !== 0) continue;
      const k = e.info.kind;
      if (pr.kind === 'serve') {
        if (k === 'serve') endRep(s, PRACTICE.afterServe);
      } else if (pr.kind === 'serveCut' || pr.kind === 'spikeReceive') {
        endRep(s, PRACTICE.afterTouch); // カット・レシーブしたら終わり
      } else if (k === 'spike' || k === 'feint' || k === 'free') {
        endRep(s, PRACTICE.afterAttack); // スパイクのある練習は打ったら終わり
      }
    }
  }
  return pr.nextRepTick >= 0 && s.tick >= pr.nextRepTick;
}
