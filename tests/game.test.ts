import { describe, expect, it } from 'vitest';
import { aimPoint, applyContact, serveHitTick, ballAt, contactDist, hitPoint, interceptPoint, riseTime, startJump, tossAimTarget, updateActors } from '../shared/actions.ts';
import {
  BLOCK_JUMP_MAX,
  RECEIVE_RECOVER_TICKS,
  SERVE_RECEIVE_APEX_BONUS,
  SET_TARGET,
  SPIKE_REACH,
  SPIKE_SCATTER_MIN,
  STANDING_REACH,
  TICK_RATE,
  TOSS_HIT_HEIGHT,
  TOSS_TARGET_LZ,
} from '../shared/constants.ts';
import { FORMATION, isFrontRow, judgeOf, playerAtPosition, positionOf, switchedPos, toWorld } from '../shared/court.ts';
import { createGame, currentAction, press, release, setStick, step } from '../shared/game.ts';
import { launch, solveByApex } from '../shared/physics.ts';
import { computePath } from '../shared/actions.ts';
import type { ContactInfo, ContactKind, GameEvent, GameState, TeamId } from '../shared/types.ts';
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
    const d = contactDist(s, p, kind, t, s.path[i]);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return bt;
}

/** 目標tickの holdTicks 前に押し、offsetTicks ずらして離す */
function hitAt(s: GameState, team: TeamId, target: number, offsetTicks: number, holdTicks: number, stick?: [number, number]): GameEvent[] {
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
  if (stick) setStick(s, team, stick[0], stick[1]); // 離す瞬間だけ倒す（移動はしない）
  release(s, team);
  if (stick) setStick(s, team, 0, 0);
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
    [-5, 'PERFECT'], // レシーブは早めに離すと甘い（EARLY_GRACE）
    [-8, 'GOOD'],
    [-12, 'BAD'],
    [-20, 'MISS'],
    [6, 'MISS'], // レシーブの打点からすぐ床に落ちる。落ちた後に離しても上がらない
    [13, 'MISS'],
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

  it('遅れて離したときは、理想の時刻のボール位置から打ち直される（床に落ちる前なら）', () => {
    const s = createGame({ seed: 3 });
    incoming(s, receiver, { contactsLeft: 2, lastTouch: 0 }); // トス：打点が高く、すぐには落ちない
    const t = contactTick(s, receiver, 'toss');
    hitAt(s, 0, t, 7, 20); // 117ms 遅れ
    expect(s.lastContact?.tick).toBe(t);
    expect(s.lastContact?.judgment).toBe('GOOD');
    // 打球は上向きに飛び、まだ接地していない
    expect(s.landTick).toBe(-1);
  });
});

describe('イベントの受け渡し', () => {
  it('離した瞬間の判定（judge）も、画面と同じ順（入力→step→読む）で受け取れる', () => {
    const s = createGame({ seed: 1, rules: { serveTime: 30 } });
    const seen: string[] = [];
    const tick = (input?: () => void) => {
      input?.();
      step(s);
      for (const e of s.events) seen.push(e.type);
    };
    for (let i = 0; i < 5; i++) tick();
    tick(() => press(s, 0));
    for (let i = 0; i < 15; i++) tick();
    tick(() => release(s, 0));
    for (let i = 0; i < 30; i++) tick();
    expect(seen.filter((t) => t === 'judge')).toHaveLength(1);
    expect(seen.filter((t) => t === 'contact')).toHaveLength(1);
  });
});

describe('ブロックの後の操作', () => {
  it('ブロックで相手コートへ返したら、相手が次にトスを上げるまでブロックした前衛を操作する', () => {
    const s = createGame({ seed: 2, rules: { feint: false } });
    for (const p of s.players) {
      const [lx, lz] = (p.team === 0 ? FORMATION.defense : FORMATION.offense)[positionOf(s, p)];
      const w = toWorld(p.team, lx, lz);
      p.x = w.x;
      p.z = w.z;
    }
    // 相手のセンターへトスが上がったところ
    const atk = playerAtPosition(s, 1, 3);
    const f = toWorld(1, SET_TARGET.lx, SET_TARGET.lz);
    const t = toWorld(1, 0, TOSS_TARGET_LZ);
    const from = v3(f.x, TOSS_HIT_HEIGHT, f.z);
    launch(s.ball, from, solveByApex(from, t.x, t.z, 5));
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = 'toss';
    s.tossTarget = atk.id;
    s.teams[1].contactsLeft = 1;
    s.aiReadyTick = [s.tick, s.tick];
    computePath(s);
    updateActors(s);
    const blocker = s.players[s.teams[0].controlled];
    blocker.x = t.x;
    const hit = interceptPoint(s, 1, STANDING_REACH + 0.9)!;
    const jumpAt = hit.tick - Math.round(riseTime(BLOCK_JUMP_MAX) * TICK_RATE) - 4;
    let blocked = false;
    const after: number[] = [];
    for (let i = 0; i < 300 && s.phase === 'rally'; i++) {
      if (s.tick === jumpAt - 30) press(s, 0);
      if (s.tick === jumpAt) release(s, 0);
      step(s);
      if (s.events.some((e) => e.type === 'block')) blocked = true;
      if (s.events.some((e) => e.type === 'contact' && e.info.kind === 'toss')) break;
      if (blocked) after.push(s.teams[0].controlled);
    }
    expect(blocked).toBe(true);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((id) => id === blocker.id)).toBe(true);
  });
});

describe('サーブの後の操作', () => {
  it('サーブを打ったら前衛の選手に切り替わり、サーバーは自動で戻る', () => {
    const s = createGame({ seed: 1, rules: { serveTime: 30 } });
    const server = s.server;
    expect(s.teams[0].controlled).toBe(server);
    press(s, 0);
    for (let i = 0; i < 10; i++) step(s);
    release(s, 0);
    while (!s.lastContact) step(s);
    step(s);
    const c = s.players[s.teams[0].controlled];
    expect(c.id).not.toBe(server);
    expect(isFrontRow(positionOf(s, c))).toBe(true);
    const z0 = s.players[server].z;
    for (let i = 0; i < 30; i++) step(s);
    expect(s.players[server].z).toBeLessThan(z0); // コートの中へ戻っている
  });
});

describe('カットの後の硬直', () => {
  it('カットした選手は RECEIVE_RECOVER_TICKS の間動けず、その後は動ける', () => {
    const s = createGame({ seed: 3 });
    incoming(s, receiver);
    const t = contactTick(s, receiver, 'receive');
    while (s.tick < t - 20) step(s);
    press(s, 0);
    while (s.tick < t) step(s);
    release(s, 0);
    while (!s.lastContact) step(s);
    const c = s.lastContact;
    expect(c.kind).toBe('receive');
    expect(s.tick - c.tick).toBeLessThan(3); // 打った直後から見る
    const p = s.players[receiver];
    p.x += 3; // 守備位置から離しておき、動けるようになったら戻るのを見る
    const x = p.x;
    const z = p.z;
    while (s.tick < c.tick + RECEIVE_RECOVER_TICKS) step(s);
    expect(p.x).toBeCloseTo(x, 6);
    expect(p.z).toBeCloseTo(z, 6);
    for (let i = 0; i < 30; i++) step(s);
    expect(Math.hypot(p.x - x, p.z - z)).toBeGreaterThan(0.05); // 起きたら守備位置へ戻り始める
  });
});

describe('動作ごとの判定の違い', () => {
  it('スパイクは判定幅が広い（JUDGE_SCALE）', () => {
    expect(judgeOf(0.07, 'spike')).toBe('PERFECT');
    expect(judgeOf(0.07, 'receive')).toBe('GOOD');
    expect(judgeOf(0.17, 'spike')).toBe('GOOD');
    expect(judgeOf(-0.3, 'spike')).toBe('BAD');
    expect(judgeOf(0.3, 'receive')).toBe('MISS');
  });

  it('サーブカットは普通のレシーブより高く上がる', () => {
    const apex = (served: boolean) => {
      const s = createGame({ seed: 4 });
      incoming(s, receiver);
      if (served) s.lastContactKind = 'serve';
      hitAt(s, 0, contactTick(s, receiver, 'receive'), 0, 20);
      return s.lastContact!.apex;
    };
    expect(apex(true)).toBeCloseTo(apex(false) + SERVE_RECEIVE_APEX_BONUS, 5);
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
    for (const hold of [2, 10, 18]) {
      // 33ms＝フェイント、167ms、300ms＝溜め最大（SPIKE_CHARGE_MAX）
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

describe('スパイクは落下予測円の中にいれば打てる', () => {
  /** トスの落下地点から横に shiftX ずれた所で跳び、打点に合わせて2回目を押す */
  const spikeWithShift = (shiftX: number) => {
    const s = createGame({ seed: 7 });
    const atk = s.players.find((p) => p.team === 0 && p.slot === 3)!;
    atk.x = 0;
    atk.z = 1.0;
    incoming(s, atk.id, { contactsLeft: 1, lastTouch: 0, apex: 6 });
    // 横に離れたセッターから上げた低いトス：手の高さでは、ボールはまだ円の手前にある
    const from = v3(atk.x + 4, TOSS_HIT_HEIGHT, atk.z + 0.3);
    launch(s.ball, from, solveByApex(from, atk.x, atk.z, 3.8));
    computePath(s);
    s.lastContactKind = 'toss';
    s.tossTarget = atk.id;
    atk.x -= shiftX; // ボールが来る側と反対へずらす（手とボールの横のずれが大きくなる）
    const handPath = s.path.findIndex((q, i) => i > 0 && q.y < s.path[i - 1].y && q.y < 3.2);
    while (s.tick < s.pathTick + handPath - 30) step(s);
    press(s, 0);
    step(s);
    release(s, 0);
    const t = contactTick(s, atk.id, 'spike');
    const handDist = dist3(ballAt(s, t)!, hitPoint(s, atk, 'spike', t));
    const ev = hitAt(s, 0, t, 0, 18);
    const spiked = ev.some((e) => e.type === 'contact' && e.info.kind === 'spike');
    return { handDist, spiked };
  };
  it('円の中なら、手とボールが離れていても打てる', () => {
    const r = spikeWithShift(0.6);
    expect(r.handDist).toBeGreaterThan(SPIKE_REACH); // 今までの判定なら空振り
    expect(r.spiked).toBe(true);
  });
  it('円の外で手も届かなければ打てない', () => {
    expect(spikeWithShift(1.4).spiked).toBe(false);
  });
});

describe('フライング', () => {
  /** レシーブする選手を、ボールの落下地点から横に shiftX ずらしておく */
  const setup = (shiftX: number) => {
    const s = createGame({ seed: 3 });
    incoming(s, receiver, { apex: 4 });
    const t = contactTick(s, receiver, 'receive');
    s.players[receiver].x += shiftX;
    return { s, t };
  };
  it('普通には届かないボールは、スティックの向きへ飛び込んで上げる（返球は乱れる）', () => {
    const { s, t } = setup(2.0);
    const normal = setup(0);
    hitAt(normal.s, 0, normal.t, 0, 20);
    const ev = hitAt(s, 0, t, 0, 20, [-1, 0]); // ボールのある左へ
    const j = ev.find((e) => e.type === 'judge');
    expect(j && j.type === 'judge' && j.dive).toBe(true);
    expect(s.lastContact?.dive).toBe(true);
    expect(s.lastContact!.scatter).toBeGreaterThan(normal.s.lastContact!.scatter);
    // 飛び込んだ後は起き上がるまで動けない
    const p = s.players[receiver];
    expect(p.diveTick).toBeGreaterThanOrEqual(0);
    const x = p.x;
    const z = p.z;
    for (let i = 0; i < 10; i++) step(s);
    expect(p.x).toBeCloseTo(x, 6);
    expect(p.z).toBeCloseTo(z, 6);
  });
  it('向きを間違えると、飛び込んでも手が落下予測円に入らず上がらない', () => {
    for (const stick of [[1, 0], [0, 1], [0, 0]] as [number, number][]) {
      const { s, t } = setup(2.0);
      const ev = hitAt(s, 0, t, 0, 20, stick);
      const j = ev.find((e) => e.type === 'judge');
      expect(j && j.type === 'judge' ? j.judgment : null).toBe('MISS');
      expect(ev.some((e) => e.type === 'contact')).toBe(false);
      expect(s.players[receiver].diveTick).toBeGreaterThanOrEqual(0); // 飛び込みはする
    }
  });
  it('フライングでも届かないボールは空振り', () => {
    const { s, t } = setup(4.0);
    const ev = hitAt(s, 0, t, 0, 20);
    const j = ev.find((e) => e.type === 'judge');
    expect(j && j.type === 'judge' ? j.judgment : null).toBe('MISS');
  });
});

describe('ジャンプ', () => {
  it('その場で真上に跳び、走っていた勢いもスティックも空中では効かない', () => {
    const s = createGame({ seed: 6 });
    const p = playerAtPosition(s, 0, 3);
    incoming(s, p.id, { contactsLeft: 1, lastTouch: 0 });
    setStick(s, 0, 1, 1);
    step(s); // 走り出す
    const x0 = p.x;
    const z0 = p.z;
    startJump(s, p, 'attack', 1);
    for (let i = 0; i < 20; i++) step(s);
    expect(p.y).toBeGreaterThan(0);
    expect(p.x).toBeCloseTo(x0, 6);
    expect(p.z).toBeCloseTo(z0, 6);
  });
});

describe('ツーアタックの誤操作防止', () => {
  const setup = (shiftX: number) => {
    const s = createGame({ seed: 5 });
    const setter = playerAtPosition(s, 0, 3); // 前衛中央
    incoming(s, setter.id, { contactsLeft: 2, lastTouch: 0 });
    setter.x += shiftX; // ボールから離れた位置にずらす
    setStick(s, 0, 0, 1); // ネット方向へ倒す
    return s;
  };
  it('打てる位置の近くでスティックをネット方向に倒すとツー', () => {
    expect(currentAction(setup(0), 0)).toBe('twoJump');
  });
  it('ボールを追いかけて走っている最中はトスになる', () => {
    expect(currentAction(setup(3), 0)).toBe('toss');
  });
});

describe('トスの向き', () => {
  /** 後衛のセッターに2本目のボールを送り、shiftX だけ打点から離しておく */
  const setup = (shiftX: number, mx: number) => {
    const s = createGame({ seed: 5 });
    const setter = playerAtPosition(s, 0, 1);
    setter.x = 0.6;
    setter.z = 1.2;
    incoming(s, setter.id, { contactsLeft: 2, lastTouch: 0 });
    setter.x += shiftX;
    setStick(s, 0, mx, 0);
    return { s, setter };
  };
  // サーブの後は得意な位置へ入れ替わるので、入れ替わった後の位置（4=レフト、3=センター、2=ライト）で見る
  const posOf = (s: GameState, id: number) => switchedPos(s, s.players[id]);
  it('打点の近くでは、スティックの左右でレフト・センター・ライトを選べる', () => {
    expect(posOf(setup(0, -1).s, tossAimTarget(setup(0, -1).s, 0).id)).toBe(4);
    expect(posOf(setup(0, 0).s, tossAimTarget(setup(0, 0).s, 0).id)).toBe(3);
    expect(posOf(setup(0, 1).s, tossAimTarget(setup(0, 1).s, 0).id)).toBe(2);
  });
  it('ボールを追って走っている最中のスティックでは向きを変えない（センター）', () => {
    const { s } = setup(3, -1);
    expect(posOf(s, tossAimTarget(s, 0).id)).toBe(3);
  });
  it('押している間スティックを倒し続けても動かず、印を出していた相手にトスが上がる', () => {
    const { s, setter } = setup(0, 0);
    const t = contactTick(s, setter.id, 'toss');
    while (s.tick < t - 20) step(s);
    press(s, 0);
    setStick(s, 0, -1, 0); // 押したまま左へ倒し続ける
    const x0 = setter.x;
    while (s.tick < t) step(s);
    expect(setter.x).toBeCloseTo(x0, 6); // 歩いて打点から離れない
    expect(posOf(s, tossAimTarget(s, 0).id)).toBe(4);
    release(s, 0);
    for (let i = 0; i < 10; i++) step(s);
    expect(s.lastContact?.kind).toBe('toss');
    expect(posOf(s, s.tossTarget)).toBe(4);
  });
});

describe('レシーブの担当', () => {
  /** 前衛右の選手を (lx=3, lz) に置き、その足元へ相手からボールを送る */
  const setup = (lz: number, feint = false) => {
    const s = createGame({ seed: 5 });
    const front = playerAtPosition(s, 0, 2);
    const back = playerAtPosition(s, 0, 1); // 後衛右
    front.x = 3;
    front.z = lz;
    back.x = 3;
    back.z = 7;
    incoming(s, front.id);
    if (feint) s.lastContactKind = 'feint';
    updateActors(s);
    return { s, front, back };
  };
  it('前（アタックラインより手前）以外のボールは、前衛が近くても後衛がレシーブする', () => {
    const { s, back } = setup(4.5);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  it('前のボールは近い前衛がレシーブする', () => {
    const { s, front } = setup(2);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  /** ネット際 (0, 1.5) に落ちるボール。前衛中央・後衛中央をそれぞれ指定の位置に置く */
  const nearNet = (ownBlock: boolean, frontAt: [number, number], backAt: [number, number], frontInAir = false) => {
    const s = createGame({ seed: 5 });
    const back = playerAtPosition(s, 0, 6);
    const front = playerAtPosition(s, 0, 3);
    back.x = 0;
    back.z = 1.5;
    incoming(s, back.id, { lastTouch: ownBlock ? 0 : 1 });
    if (ownBlock) s.lastContactKind = 'block';
    [back.x, back.z] = backAt;
    [front.x, front.z] = frontAt;
    if (frontInAir) {
      front.y = 1.0; // ブロックで跳んでいて、着地まで約0.5秒
      front.vy = 0;
    }
    updateActors(s);
    return { s, back, front };
  };
  it('自チームのブロック後に手前に落ちるボール：後衛の方が近ければ後衛が取る', () => {
    const { s, back } = nearNet(true, [1.8, 1.5], [0.5, 2.3]);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  it('自チームのブロック後に手前に落ちるボール：まだ空中のブロッカーでも、一番近ければ取る', () => {
    const { s, front } = nearNet(true, [1.0, 1.5], [0, 3.0], true);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  it('相手から来た手前のボールは、今までどおり一番早く着ける選手（空中の選手は着地を待つ分遅い）', () => {
    const { s, back } = nearNet(false, [1.0, 1.5], [0, 3.0], true);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  it('アタックラインより前に落ちるフェイントは前衛が取る', () => {
    const { s, front } = setup(2, true);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  it('前に落ちるフェイントは、後衛の方が近くても前衛が取る', () => {
    const { s, front } = nearNet(false, [1.8, 1.5], [0.5, 2.3]);
    s.lastContactKind = 'feint';
    updateActors(s);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  it('前に落ちるフェイントは、ブロックに跳んでいる前衛は一番近くても取りに行かず、跳んでいない前衛が取る', () => {
    const { s, front } = nearNet(false, [0.3, 1.5], [0, 3.5]);
    front.jump = 'block';
    front.y = 0.05; // もうすぐ着地（着地を待っても一番早い）
    front.vy = 0;
    s.lastContactKind = 'feint';
    updateActors(s);
    const c = s.players[s.teams[0].controlled];
    expect(c.id).not.toBe(front.id);
    expect(isFrontRow(positionOf(s, c))).toBe(true);
  });
  it('前に落ちるフェイントは、前衛が全員ブロックに跳んでいれば後衛が取る', () => {
    const { s, back } = nearNet(false, [0.3, 1.5], [0, 3.5]);
    for (const pos of [2, 3, 4]) {
      const p = playerAtPosition(s, 0, pos);
      p.jump = 'block';
      p.y = 0.05;
      p.vy = 0;
    }
    s.lastContactKind = 'feint';
    updateActors(s);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  /** 相手が x=atkX から、自コートの (landX, 1.5) へフェイント。前衛右・中央をボールの近くに置く */
  const feintFrom = (atkX: number, landX: number) => {
    const s = createGame({ seed: 5 });
    const atk = playerAtPosition(s, 1, 4);
    atk.x = atkX;
    atk.z = -0.6;
    for (const pos of [2, 3, 4]) {
      const p = playerAtPosition(s, 0, pos);
      p.x = landX + (pos - 3) * 0.6;
      p.z = 2.0;
    }
    const from = v3(atkX, 3.0, -0.4);
    launch(s.ball, from, solveByApex(from, landX, 1.5, 3.6));
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = 'feint';
    s.lastContact = { team: 1, player: atk.id, kind: 'feint' } as ContactInfo;
    s.teams[0].contactsLeft = 3;
    computePath(s);
    updateActors(s);
    return s;
  };
  it('サイドからのまっすぐなフェイントも、アタックラインより前なら前衛が取る', () => {
    const ctrlFront = (s: GameState) => isFrontRow(positionOf(s, s.players[s.teams[0].controlled]));
    expect(ctrlFront(feintFrom(-3, -3))).toBe(true); // 自コートの左
    expect(ctrlFront(feintFrom(3, 3.2))).toBe(true); // 自コートの右
  });
  it('サイドからでもクロスのフェイント、中央からのフェイントは今までどおり', () => {
    const cross = feintFrom(-3, 1);
    expect(positionOf(cross, cross.players[cross.teams[0].controlled])).not.toBe(5);
    const center = feintFrom(0, 0.3);
    expect([1, 5]).not.toContain(positionOf(center, center.players[center.teams[0].controlled]));
  });
  it('アタックラインより奥に落ちるフェイントは後衛が取る', () => {
    const { s, back } = setup(4.5, true);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  /** 相手のスパイク（または kind の打球）が自コートの (3, 2.5) へ来る。前衛右を frontLz、後衛右を (3, 6) に置く */
  const spikeTo = (frontLz: number, kind: 'spike' | 'free' = 'spike') => {
    const s = createGame({ seed: 5 });
    const front = playerAtPosition(s, 0, 2);
    const back = playerAtPosition(s, 0, 1);
    front.x = 3;
    front.z = frontLz;
    back.x = 3;
    back.z = 6;
    const from = v3(3, 3.2, -0.5);
    launch(s.ball, from, solveByApex(from, 3, 2.5, 3.3));
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = kind;
    s.lastContact = { team: 1, player: playerAtPosition(s, 1, 4).id, kind } as ContactInfo;
    s.teams[0].contactsLeft = 3;
    computePath(s);
    updateActors(s);
    return { s, front, back };
  };
  /** 相手のサーブが自コートの (0, landLz) へ来る。前衛中央を (0, 4.8)、後衛中央を (1.6, 7.3) に置く（W型の受け方） */
  const serveTo = (landLz: number) => {
    const s = createGame({ seed: 5 });
    const front = playerAtPosition(s, 0, 3);
    const back = playerAtPosition(s, 0, 6);
    [front.x, front.z] = [0, 4.8];
    [back.x, back.z] = [1.6, 7.3];
    const from = v3(0, 3.0, -10);
    launch(s.ball, from, solveByApex(from, 0, landLz, 4.0));
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = 'serve';
    s.teams[0].contactsLeft = 3;
    computePath(s);
    updateActors(s);
    return { s, front, back };
  };
  it('サーブカットは、アタックラインより奥でも前衛の受け手が近ければ前衛が取る', () => {
    const { s, front } = serveTo(5.2);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  it('サーブカットは、前衛の受け手が後ろへ下がらないと取れない深いサーブなら後衛が取る', () => {
    const { s, back } = serveTo(7.8);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  it('速いスパイクは、後ろへ下がらないと取れない前衛には取らせず後衛が取る', () => {
    const { s, back } = spikeTo(1.0);
    expect(s.teams[0].controlled).toBe(back.id);
  });
  it('速いスパイクでも、前衛が打点より後ろにいて体の前で取れるなら前衛が取る', () => {
    const { s, front } = spikeTo(3.2);
    expect(s.teams[0].controlled).toBe(front.id);
  });
  it('山なりの返球（遅い球）は、下がって取れるので今までどおり一番早く着ける選手が取る', () => {
    const { s, front } = spikeTo(1.0, 'free');
    expect(s.teams[0].controlled).toBe(front.id);
  });
});

describe('スパイク・サーブのコース', () => {
  it('スパイクは空中でスティックを倒した向きを狙い、その印の位置へ打つ', () => {
    const s = createGame({ seed: 5 });
    const p = playerAtPosition(s, 0, 4);
    p.x = -3;
    p.z = 0.8;
    s.phase = 'rally';
    s.serveTossed = true;
    s.teams[0].controlled = p.id;
    startJump(s, p, 'attack', 1);
    setStick(s, 0, 1, 1); // 右・奥
    const deepRight = aimPoint(s, 0)!;
    setStick(s, 0, -1, -1); // 左・手前
    const shortLeft = aimPoint(s, 0)!;
    // 相手コートはチーム0から見て z<0。奥ほど z が小さい
    expect(deepRight.x).toBeGreaterThan(2);
    expect(shortLeft.x).toBeLessThan(-2);
    expect(deepRight.z).toBeLessThan(shortLeft.z - 3);
    expect(deepRight.z).toBeLessThan(0);
    // 打てば（PERFECT・ぶれ最小）印の近くに落ちる
    setStick(s, 0, 1, 1);
    s.ball.pos = v3(p.x, 3.4, p.z - 0.3);
    const { mx, mf } = s.teams[0];
    applyContact(s, { tick: s.tick, team: 0, player: p.id, kind: 'spike', judgment: 'PERFECT', charge: 1, mx, mf, dt: 0 }, s.tick);
    expect(Math.hypot(s.predLandX - deepRight.x, s.predLandZ - deepRight.z)).toBeLessThan(SPIKE_SCATTER_MIN + 0.3);
    p.swung = true; // 離したとき（release）に振った扱いになる
    expect(aimPoint(s, 0)).toBeNull(); // 振った後は消える
  });
  it('サーブはトスを上げてから打つまで印が出て、スティックの左右で動く', () => {
    const s = createGame({ seed: 5 });
    expect(aimPoint(s, 0)).toBeNull(); // トスの前は出ない（スティックはサーバーの移動）
    press(s, 0);
    setStick(s, 0, -1, 0);
    const left = aimPoint(s, 0)!;
    setStick(s, 0, 1, 0);
    const right = aimPoint(s, 0)!;
    expect(left.x).toBeLessThan(-2);
    expect(right.x).toBeGreaterThan(2);
    expect(right.z).toBeLessThan(0);
    setStick(s, 0, 0, 1);
    const deep = aimPoint(s, 0)!;
    setStick(s, 0, 0, -1);
    const short = aimPoint(s, 0)!;
    expect(deep.z).toBeLessThan(short.z - 4); // 上で奥、下で手前
  });
  /** サーブを打って、ネットを越えたか・水平の速さ・落ちた地点を返す */
  const serveWith = (charge: number, mf: number) => {
    const s = createGame({ seed: 5 });
    press(s, 0);
    while (s.tick < serveHitTick(s)) step(s);
    applyContact(s, { tick: s.tick, team: 0, player: s.server, kind: 'serve', judgment: 'PERFECT', charge, mx: 0, mf, dt: 0 }, s.tick);
    const hSpeed = Math.hypot(s.ball.vel.x, s.ball.vel.z);
    const landZ = s.predLandZ;
    let net = false;
    for (let i = 0; i < 200 && s.phase !== 'point'; i++) {
      step(s);
      if (s.events.some((e) => e.type === 'net')) net = true;
    }
    return { hSpeed, landZ, net };
  };
  it('サーブは溜めるほど速い。深く狙った速いサーブもネットを越える', () => {
    const slow = serveWith(0, 0.5);
    const fast = serveWith(1, 0.5);
    expect(fast.hSpeed).toBeGreaterThan(slow.hSpeed + 5);
    expect(fast.hSpeed).toBeGreaterThan(17);
    expect(fast.net).toBe(false);
    expect(fast.landZ).toBeLessThan(-6);
  });
  it('浅く狙うと、溜めてもネットを越えられる速さまでしか出ない', () => {
    const short = serveWith(1, -1);
    const deep = serveWith(1, 1);
    expect(short.net).toBe(false);
    expect(short.landZ).toBeGreaterThan(-5.5);
    expect(short.hSpeed).toBeLessThan(deep.hSpeed);
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
    let serve: ContactInfo | null = null;
    for (let i = 0; i < 120 && !serve; i++) {
      step(s);
      for (const e of s.events) if (e.type === 'contact' && e.info.kind === 'serve') serve = e.info;
    }
    expect(serve?.charge).toBe(0);
    expect(serve?.judgment).toBe('GOOD');
  });
});

