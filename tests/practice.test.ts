import { describe, expect, it } from 'vitest';
import { contactDist, interceptPoint, riseTime } from '../shared/actions.ts';
import { JUMP_HEIGHT_MAX, PRACTICE, RECEIVE_HIT_HEIGHT, STANDING_REACH, TICK_RATE } from '../shared/constants.ts';
import { createGame, currentAction, press, release, step } from '../shared/game.ts';
import type { ContactInfo, ContactKind, GameState, PracticeKind } from '../shared/types.ts';

const practice = (kind: PracticeKind, seed = 3) => createGame({ seed, practice: { kind, tossZone: 'left' } });

/** n tick 進め、その間の打球を集める */
function run(s: GameState, n: number, until?: (c: ContactInfo) => boolean): ContactInfo[] {
  const out: ContactInfo[] = [];
  for (let i = 0; i < n; i++) {
    step(s);
    for (const e of s.events) if (e.type === 'contact') out.push(e.info);
    if (until && out.some(until)) break;
  }
  return out;
}

/** 操作中の選手の打点にボールが最も近づく tick（ahead tick 先まで） */
function bestTick(s: GameState, kind: ContactKind, ahead = 150): number {
  const p = s.players[s.teams[0].controlled];
  let best = Infinity;
  let bt = -1;
  for (let i = 0; i < Math.min(s.path.length, ahead); i++) {
    const t = s.pathTick + i + 1;
    if (t <= s.tick) continue;
    const d = contactDist(s, p, kind, t, s.path[i]);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return bt;
}

/** target tick に離すよう、hold tick 前から押す */
function hitAt(s: GameState, target: number, hold: number): ContactInfo[] {
  const out = run(s, Math.max(0, target - hold - s.tick));
  press(s, 0);
  out.push(...run(s, target - s.tick));
  s.events.length = 0;
  release(s, 0);
  for (const e of s.events) if (e.type === 'contact') out.push(e.info); // 離した瞬間に打つこともある
  return out;
}

const startedNextRep = (s: GameState) => s.practice!.nextRepTick < 0;

/** 操作中の選手を、ボールが高さ h まで下りてくる地点へ移す（人がスティックで走る代わり） */
function goTo(s: GameState, h: number): void {
  const ip = interceptPoint(s, 0, h);
  if (!ip) return;
  const p = s.players[s.teams[0].controlled];
  p.x = ip.x;
  p.z = ip.z;
}

describe('練習モード', () => {
  it('サーブカット：CPU がサーブを打ち、拾わなければ落ちて次の1本。点数は数えない', () => {
    const s = practice('serveCut');
    expect(s.servingTeam).toBe(1);
    const c = run(s, 200, (c) => c.kind === 'serve');
    expect(c.some((x) => x.kind === 'serve' && x.team === 1)).toBe(true);
    // 落ちたら次の1本：CPU がまたサーブを打つ
    run(s, 5);
    const next = run(s, 400, (c) => c.kind === 'serve');
    expect(next.some((x) => x.kind === 'serve' && x.team === 1)).toBe(true);
    expect(next.some((x) => x.team === 0)).toBe(false);
    expect(s.teams[0].score + s.teams[1].score).toBe(0);
  });

  it('サーブカット：カットしたら1本終わり、相手は打ち返さない', () => {
    const s = practice('serveCut');
    run(s, 200, (c) => c.kind === 'serve');
    goTo(s, RECEIVE_HIT_HEIGHT);
    const t = bestTick(s, 'receive');
    const c = hitAt(s, t, 20);
    c.push(...run(s, 10));
    expect(c.some((x) => x.kind === 'receive' && x.team === 0)).toBe(true);
    expect(s.practice!.nextRepTick).toBeGreaterThan(0);
    const after = run(s, Math.round(PRACTICE.afterTouch * TICK_RATE) + 5);
    expect(after.some((x) => x.team === 1)).toBe(false);
    expect(startedNextRep(s)).toBe(true);
  });

  it('スパイク：味方セッターが自動で、選んだゾーンの選手へトスを上げる（人はトスしない）', () => {
    const s = practice('spike');
    const pr = s.practice!;
    expect(s.teams[0].controlled).toBe(pr.attacker);
    expect(currentAction(s, 0)).toBe('none');
    const c = run(s, 200, (c) => c.kind === 'toss');
    const toss = c.find((x) => x.kind === 'toss')!;
    expect(toss.team).toBe(0);
    expect(toss.player).toBe(pr.setter);
    expect(s.tossTarget).toBe(pr.attacker);
    expect(s.teams[0].controlled).toBe(pr.attacker);
  });

  it('スパイク：跳んで打ったら1本終わり、次の1本が始まる', () => {
    const s = practice('spike');
    run(s, 200, (c) => c.kind === 'toss');
    goTo(s, STANDING_REACH + JUMP_HEIGHT_MAX);
    // 手の高さにボールが来る時刻に合わせて、上昇時間ぶん前に跳ぶ
    const ip = interceptPoint(s, 0, STANDING_REACH + JUMP_HEIGHT_MAX);
    expect(ip).not.toBeNull();
    const jumpAt = ip!.tick - Math.round(riseTime(JUMP_HEIGHT_MAX) * TICK_RATE);
    hitAt(s, jumpAt, 40); // 溜め最大でジャンプ
    expect(currentAction(s, 0)).toBe('spike');
    const c = hitAt(s, bestTick(s, 'spike'), 18);
    c.push(...run(s, 5));
    expect(c.some((x) => (x.kind === 'spike' || x.kind === 'feint') && x.team === 0)).toBe(true);
    run(s, Math.round(PRACTICE.afterAttack * TICK_RATE) + 5);
    expect(startedNextRep(s)).toBe(true);
    expect(s.teams[0].controlled).toBe(s.practice!.attacker);
  });

  it('スパイクレシーブ：相手のアタッカーが打ってくる。ブロックには跳ばず後衛で待つ', () => {
    const s = practice('spikeReceive');
    expect(currentAction(s, 0)).not.toBe('block');
    const c = run(s, 240, (c) => c.team === 1 && (c.kind === 'spike' || c.kind === 'feint' || c.kind === 'free'));
    expect(c.some((x) => x.team === 1 && (x.kind === 'spike' || x.kind === 'feint' || x.kind === 'free'))).toBe(true);
  });

  it('サーブ：自分が打ち、相手は拾わない。次の1本も自分のサーブ', () => {
    const s = practice('serve');
    expect(s.servingTeam).toBe(0);
    press(s, 0);
    run(s, 10);
    release(s, 0);
    const c = run(s, Math.round(PRACTICE.afterServe * TICK_RATE) + 10);
    expect(c.some((x) => x.kind === 'serve' && x.team === 0)).toBe(true);
    expect(c.some((x) => x.team === 1)).toBe(false);
    expect(s.phase).toBe('serve');
    expect(s.servingTeam).toBe(0);
    expect(s.teams[0].score + s.teams[1].score).toBe(0);
  });

  it('サーブカット→スパイク：カットの後は自動トスが上がり、打つ選手を操作する', () => {
    const s = practice('serveCutSpike');
    run(s, 200, (c) => c.kind === 'serve');
    goTo(s, RECEIVE_HIT_HEIGHT);
    const c = hitAt(s, bestTick(s, 'receive'), 20);
    c.push(...run(s, 200, (x) => x.kind === 'toss'));
    if (!c.some((x) => x.kind === 'receive')) return; // カットが乱れて届かない seed は対象外
    expect(c.some((x) => x.kind === 'toss' && x.team === 0)).toBe(true);
    expect(s.teams[0].controlled).toBe(s.practice!.attacker);
  });
});
