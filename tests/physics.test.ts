import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, NET_HEIGHT } from '../shared/constants.ts';
import { launch, makeBall, predict, solveByApex, solveBySpeed, stepBall, type BallEvent } from '../shared/physics.ts';
import { v3 } from '../shared/vec.ts';

describe('physics', () => {
  it('最高点指定の逆算で目標地点に落ちる', () => {
    const b = makeBall();
    const from = v3(1, 1, 6);
    launch(b, from, solveByApex(from, -2, -5, 5));
    const p = predict(b);
    expect(p.landTicks).toBeGreaterThan(0);
    expect(p.landX).toBeCloseTo(-2, 1);
    expect(p.landZ).toBeCloseTo(-5, 1);
    const maxY = Math.max(...p.path.map((q) => q.y));
    expect(maxY).toBeCloseTo(5, 1);
  });

  it('速度指定の逆算（スパイク）で目標地点に落ちる', () => {
    const b = makeBall();
    const from = v3(0, 3.2, 1);
    launch(b, from, solveBySpeed(from, 2, -6, 15));
    const p = predict(b);
    expect(p.landX).toBeCloseTo(2, 1);
    expect(p.landZ).toBeCloseTo(-6, 1);
  });

  it('ネットより低いボールは跳ね返る', () => {
    const b = makeBall();
    const from = v3(0, 1.5, 3);
    launch(b, from, v3(0, 0.5, -8));
    const ev: BallEvent[] = [];
    for (let i = 0; i < 300; i++) stepBall(b, ev);
    expect(ev.some((e) => e.type === 'net')).toBe(true);
    expect(b.pos.z).toBeGreaterThan(0);
  });

  it('ネットを越えるボールは相手コートへ', () => {
    const b = makeBall();
    const from = v3(0, 1, 5);
    launch(b, from, solveByApex(from, 0, -5, NET_HEIGHT + 2));
    const ev: BallEvent[] = [];
    for (let i = 0; i < 400; i++) stepBall(b, ev);
    expect(ev.some((e) => e.type === 'cross' && e.toSide === 1)).toBe(true);
    expect(b.pos.z).toBeLessThan(0);
  });

  it('床で止まる', () => {
    const b = makeBall();
    launch(b, v3(0, 3, 4), v3(1, 2, 0));
    for (let i = 0; i < 1000; i++) stepBall(b);
    expect(b.mode).toBe('rest');
    expect(b.pos.y).toBeCloseTo(BALL_RADIUS, 5);
  });
});
