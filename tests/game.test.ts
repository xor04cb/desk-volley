import { describe, expect, it } from 'vitest';
import { hitPoint } from '../shared/actions.ts';
import { TICK_RATE } from '../shared/constants.ts';
import { createGame, press, release, step } from '../shared/game.ts';
import { launch, solveByApex } from '../shared/physics.ts';
import { computePath } from '../shared/actions.ts';
import type { ContactKind, GameEvent, GameState, TeamId } from '../shared/types.ts';
import { dist3, v3 } from '../shared/vec.ts';
import { simulate } from './sim.ts';

/** チーム0の選手 id に向けて、相手コートからボールを送る */
function incoming(s: GameState, id: number, opts: { contactsLeft?: number; lastTouch?: TeamId; apex?: number } = {}): void {
  const p = s.players[id];
  s.phase = 'rally';
  s.serveTossed = true;
  s.lastContactKind = 'spike';
  s.lastTouchTeam = opts.lastTouch ?? 1;
  s.teams[0].contactsLeft = opts.contactsLeft ?? 3;
  s.teams[0].lastToucher = -1;
  s.teams[0].controlled = id;
  // CPU側が邪魔をしないように、相手のAIは反応させない
  s.aiReadyTick = [s.tick + 100000, s.tick + 100000];
  const from = opts.lastTouch === 0 ? v3(p.x + 1, 1, p.z + 2) : v3(p.x, 3, -5);
  launch(s.ball, from, solveByApex(from, p.x, p.z, opts.apex ?? 5));
  computePath(s);
}

/** ボールが選手の打点に最も近づく tick */
function contactTick(s: GameState, id: number, kind: ContactKind): number {
  const p = s.players[id];
  let best = Infinity;
  let bt = -1;
  for (let i = 0; i < s.path.length; i++) {
    const t = s.pathTick + i + 1;
    const d = dist3(s.path[i], hitPoint(s, p, kind, t));
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return bt;
}

/** 目標tickの holdTicks 前に押し、offsetTicks ずらして離す */
function hitAt(s: GameState, team: TeamId, target: number, offsetTicks: number, holdTicks: number): GameEvent[] {
  const ev: GameEvent[] = [];
  const releaseAt = target + offsetTicks;
  while (s.tick < releaseAt - holdTicks) {
    step(s);
    ev.push(...s.events);
  }
  press(s, team);
  while (s.tick < releaseAt) {
    step(s);
    ev.push(...s.events);
  }
  s.events.length = 0;
  release(s, team);
  ev.push(...s.events);
  for (let i = 0; i < 30; i++) {
    step(s);
    ev.push(...s.events);
  }
  return ev;
}

const receiver = 5; // チーム0の slot5（後衛中央）

describe('タイミング判定（フェーズ4）', () => {
  const cases: [number, string][] = [
    [0, 'PERFECT'],
    [2, 'PERFECT'],
    [-5, 'GOOD'],
    [6, 'GOOD'], // 遅れて離した → 巻き戻して打つ
    [-12, 'BAD'],
    [13, 'BAD'],
    [-20, 'MISS'],
  ];
  for (const [off, want] of cases) {
    it(`${((off / TICK_RATE) * 1000).toFixed(0)}ms ずれ → ${want}`, () => {
      const s = createGame({ seed: 3 });
      incoming(s, receiver);
      const t = contactTick(s, receiver, 'receive');
      const ev = hitAt(s, 0, t, off, 20);
      const j = ev.find((e) => e.type === 'judge');
      expect(j && j.type === 'judge' ? j.judgment : null).toBe(want);
      const contacted = ev.some((e) => e.type === 'contact' && e.info.kind === 'receive');
      expect(contacted).toBe(want !== 'MISS');
    });
  }

  it('遅れて離したときは、理想の時刻のボール位置から打ち直される', () => {
    const s = createGame({ seed: 3 });
    incoming(s, receiver);
    const t = contactTick(s, receiver, 'receive');
    hitAt(s, 0, t, 7, 20); // 117ms 遅れ
    expect(s.lastContact?.tick).toBe(t);
    expect(s.lastContact?.judgment).toBe('GOOD');
    // 打球は上向きに飛び、まだ接地していない
    expect(s.landTick).toBe(-1);
  });
});

describe('溜めの効果（フェーズ3）', () => {
  it('レシーブ：溜めるほどぶれ半径が小さい', () => {
    const r: number[] = [];
    for (const hold of [1, 18, 36]) {
      const s = createGame({ seed: 4 });
      incoming(s, receiver);
      hitAt(s, 0, contactTick(s, receiver, 'receive'), 0, hold);
      r.push(s.lastContact!.scatter);
    }
    expect(r[0]).toBeGreaterThan(r[1]);
    expect(r[1]).toBeGreaterThan(r[2]);
  });

  it('トス：溜めるほど最高点が高い', () => {
    const apex: number[] = [];
    for (const hold of [1, 18, 36]) {
      const s = createGame({ seed: 5 });
      const setter = s.players.find((p) => p.team === 0 && p.slot === 2)!.id;
      incoming(s, setter, { contactsLeft: 2, lastTouch: 0, apex: 4 });
      s.teams[0].lastToucher = receiver;
      hitAt(s, 0, contactTick(s, setter, 'toss'), 0, hold);
      expect(s.lastContact?.kind).toBe('toss');
      apex.push(s.lastContact!.apex);
    }
    expect(apex[0]).toBeLessThan(apex[1]);
    expect(apex[1]).toBeLessThan(apex[2]);
  });

  it('ジャンプ：溜めるほど高く跳ぶ', () => {
    const h: number[] = [];
    for (const hold of [1, 36]) {
      const s = createGame({ seed: 6 });
      const atk = s.players.find((p) => p.team === 0 && p.slot === 3)!;
      incoming(s, atk.id, { contactsLeft: 1, lastTouch: 0, apex: 6 });
      s.lastContactKind = 'toss';
      s.tossTarget = atk.id;
      press(s, 0);
      for (let i = 0; i < hold; i++) step(s);
      s.events.length = 0;
      release(s, 0);
      const j = s.events.find((e) => e.type === 'jump');
      h.push(j && j.type === 'jump' ? j.height : 0);
    }
    expect(h[1]).toBeGreaterThan(h[0]);
  });

  it('スパイク：溜めるほど打球が速い（短いタップはフェイント）', () => {
    const res: { kind: string; speed: number }[] = [];
    for (const hold of [2, 18, 36]) {
      const s = createGame({ seed: 7 });
      const atk = s.players.find((p) => p.team === 0 && p.slot === 3)!;
      // 空中の選手の手元にボールが来るようにする
      atk.x = 0;
      atk.z = 1.0;
      s.teams[0].controlled = atk.id;
      press(s, 0);
      for (let i = 0; i < 30; i++) step(s);
      // 先にトスの状況を作ってからジャンプ
      incoming(s, atk.id, { contactsLeft: 1, lastTouch: 0, apex: 6 });
      s.lastContactKind = 'toss';
      s.tossTarget = atk.id;
      s.teams[0].pressTick = -1;
      // 手の高さに来る少し前にジャンプする
      const handPath = s.path.findIndex((q, i) => i > 0 && q.y < s.path[i - 1].y && q.y < 3.2);
      const jumpAt = s.pathTick + handPath - 30;
      while (s.tick < jumpAt) step(s);
      press(s, 0);
      step(s);
      release(s, 0);
      expect(atk.jump).toBe('attack');
      const t = contactTick(s, atk.id, 'spike');
      hitAt(s, 0, t, 0, hold);
      res.push({ kind: s.lastContact!.kind, speed: s.lastContact!.speed });
    }
    expect(res[0].kind).toBe('feint');
    expect(res[1].kind).toBe('spike');
    expect(res[2].kind).toBe('spike');
    expect(res[2].speed).toBeGreaterThan(res[1].speed);
  });
});

describe('試合の進行', () => {
  it('同じseed・同じ入力なら同じ結果になる（決定論的）', () => {
    const a = simulate(11, { pointsPerSet: 5 }).s;
    const b = simulate(11, { pointsPerSet: 5 }).s;
    expect(a.tick).toBe(b.tick);
    expect(a.setScores).toEqual(b.setScores);
    expect(a.ball.pos).toEqual(b.ball.pos);
  });

  it('CPU同士で3セットマッチが最後まで終わる', () => {
    const { s } = simulate(12, { pointsPerSet: 5, sets: 3, finalSetPoints: 5 });
    expect(s.phase).toBe('matchEnd');
    expect(Math.max(s.teams[0].setsWon, s.teams[1].setsWon)).toBe(2);
    for (const [a, b] of s.setScores) {
      expect(Math.max(a, b)).toBeGreaterThanOrEqual(5);
      expect(Math.abs(a - b)).toBeGreaterThanOrEqual(2); // デュースあり
    }
  });

  it('デュースなしなら点数ちょうどで終わる', () => {
    for (const seed of [21, 22, 23]) {
      const { s } = simulate(seed, { pointsPerSet: 7, deuce: false });
      const [a, b] = s.setScores[0];
      expect(Math.max(a, b)).toBe(7);
    }
  });

  it('サーブ時間切れで自動サーブ', () => {
    const s = createGame({ seed: 1, rules: { serveTime: 3 } });
    for (let i = 0; i < 3 * 60 + 2; i++) step(s);
    expect(s.serveTossed).toBe(true);
    for (let i = 0; i < 120; i++) step(s);
    expect(s.lastContact?.kind).toBe('serve');
    expect(s.lastContact?.charge).toBe(0);
    expect(s.lastContact?.judgment).toBe('GOOD');
  });
});

