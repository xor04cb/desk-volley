import { describe, expect, it } from 'vitest';
import { applyContact, computePath, interceptPoint, updateActors } from '../shared/actions.ts';
import { formationSpot } from '../shared/ai.ts';
import { FORMATION, isFrontRow, positionOf, roleOf, setterOf, SETTER_SPOT, switchedPos, toLocal, toWorld } from '../shared/court.ts';
import { createGame } from '../shared/game.ts';
import { launch, solveByApex } from '../shared/physics.ts';
import type { GameState, Rules } from '../shared/types.ts';
import { v3 } from '../shared/vec.ts';

const game = (rules: Partial<Rules> = {}) => createGame({ seed: 1, rules: { serveTime: 30, ...rules } });
const local = (s: GameState, id: number) => {
  const p = s.players[id];
  const t = formationSpot(s, p);
  return toLocal(p.team, t.x, t.z);
};

/** チーム0 にボールが来るラリー（相手から：contactsLeft=3、自チームのレシーブ後：contactsLeft=2） */
function rallyTo0(s: GameState, contactsLeft: 3 | 2) {
  s.phase = 'rally';
  s.serveTossed = true;
  s.lastTouchTeam = contactsLeft === 3 ? 1 : 0;
  s.lastContactKind = contactsLeft === 3 ? 'spike' : 'receive';
  s.teams[0].contactsLeft = contactsLeft;
  s.teams[0].lastToucher = contactsLeft === 2 ? playerOf(s, 0, 'OH', false).id : -1;
  const from = contactsLeft === 3 ? v3(0, 3, -4) : v3(-2, 0.9, 6);
  const to = toWorld(0, 0.4, contactsLeft === 3 ? 6 : 1.2);
  launch(s.ball, from, solveByApex(from, to.x, to.z, 4));
  computePath(s);
  updateActors(s);
}

const playerOf = (s: GameState, team: 0 | 1, role: string, front: boolean) =>
  s.players.find((p) => p.team === team && roleOf(s, p) === role && isFrontRow(positionOf(s, p)) === front)!;

describe('役割とローテシステム', () => {
  it('5-1：S・OH・MB・OP・OH・MB の順で、向かい合う2人が同じ組。セッターは1人', () => {
    const s = game({ system: '5-1' });
    const roles = s.players.filter((p) => p.team === 0).map((p) => roleOf(s, p));
    expect(roles).toEqual(['S', 'OH', 'MB', 'OP', 'OH', 'MB']);
    expect(roleOf(s, setterOf(s, 0)!)).toBe('S');
  });

  it('4-2 は前衛のセッター、6-2 は後衛のセッターが上げる', () => {
    for (let rot = 0; rot < 6; rot++) {
      const a = game({ system: '4-2' });
      a.teams[0].rotation = rot;
      expect(isFrontRow(positionOf(a, setterOf(a, 0)!))).toBe(true);
      const b = game({ system: '6-2' });
      b.teams[0].rotation = rot;
      expect(isFrontRow(positionOf(b, setterOf(b, 0)!))).toBe(false);
    }
  });

  it('サーブの後の入れ替え：どのローテーションでも、前衛はレフト・センター・ライトに1人ずつ', () => {
    for (const system of ['5-1', '4-2', '6-2'] as const) {
      for (let rot = 0; rot < 6; rot++) {
        const s = game({ system });
        s.teams[0].rotation = rot;
        const team = s.players.filter((p) => p.team === 0);
        const front = team.filter((p) => isFrontRow(positionOf(s, p))).map((p) => switchedPos(s, p));
        const back = team.filter((p) => !isFrontRow(positionOf(s, p))).map((p) => switchedPos(s, p));
        expect(front.sort()).toEqual([2, 3, 4]);
        expect(back.sort()).toEqual([1, 5, 6]);
        // OH はレフト、MB はセンター
        for (const p of team) {
          if (roleOf(s, p) === 'OH' && isFrontRow(positionOf(s, p))) expect(switchedPos(s, p)).toBe(4);
          if (roleOf(s, p) === 'MB' && isFrontRow(positionOf(s, p))) expect(switchedPos(s, p)).toBe(3);
        }
      }
    }
  });

  it('none は今までどおり（入れ替えなし・ローテーションの位置のまま）', () => {
    const s = game({ system: 'none' });
    for (const p of s.players) expect(switchedPos(s, p)).toBe(positionOf(s, p));
    expect(setterOf(s, 0)).toBeNull();
    s.servingTeam = 1;
    s.phase = 'serve';
    for (const p of s.players.filter((q) => q.team === 0)) {
      const l = local(s, p.id);
      const [lx, lz] = FORMATION.receive[positionOf(s, p)];
      expect(l.lx).toBeCloseTo(lx, 6);
      expect(l.lz).toBeCloseTo(lz, 6);
    }
  });
});

describe('サーブレシーブの陣形', () => {
  const receivers = (receive: Rules['receive']) => {
    const s = game({ system: '5-1', receive });
    s.servingTeam = 1;
    s.phase = 'serve';
    // 後ろ（エンドライン寄り、lz 4 以上）で受ける人数
    return s.players.filter((p) => p.team === 0 && local(s, p.id).lz >= 4).length;
  };
  it('W は5人、4人型は4人、3人型は3人で受ける（ほかはネット際に隠れる）', () => {
    expect(receivers('W')).toBe(5);
    expect(receivers('four')).toBe(4);
    expect(receivers('three')).toBe(3);
  });
  it('3人型で受けるのは OH 2人と後衛の MB', () => {
    const s = game({ system: '5-1', receive: 'three' });
    s.servingTeam = 1;
    s.phase = 'serve';
    const roles = s.players.filter((p) => p.team === 0 && local(s, p.id).lz >= 4).map((p) => `${roleOf(s, p)}${isFrontRow(positionOf(s, p)) ? 'F' : 'B'}`);
    expect(roles.sort()).toEqual(['MBB', 'OHB', 'OHF']);
  });
});

describe('ラリー中の陣形', () => {
  it('相手からボールが来たら、セッター（後衛でも）はトスを上げる位置へ走り込む', () => {
    for (let rot = 0; rot < 6; rot++) {
      const s = game({ system: '5-1' });
      s.teams[0].rotation = rot;
      rallyTo0(s, 3);
      const setter = setterOf(s, 0)!;
      if (s.teams[0].controlled === setter.id) continue; // セッター自身がレシーブする場合は除く
      const l = local(s, setter.id);
      expect(l.lx).toBeCloseTo(SETTER_SPOT[0], 6);
      expect(l.lz).toBeCloseTo(SETTER_SPOT[1], 6);
    }
  });

  it('2本目はセッターが上げる（操作もセッターに切り替わる）', () => {
    const s = game({ system: '5-1' });
    const setter = setterOf(s, 0)!;
    const st = toWorld(0, SETTER_SPOT[0], SETTER_SPOT[1]);
    setter.x = st.x;
    setter.z = st.z + 1.5; // 少し遠いが、大きくは遅れない
    rallyTo0(s, 2);
    expect(s.teams[0].controlled).toBe(setter.id);
  });

  it('トスを上げたら、打つ人以外はスパイカーの後ろをカバーする', () => {
    const s = game({ system: '5-1' });
    rallyTo0(s, 2);
    const setter = s.players[s.teams[0].controlled];
    const hitter = playerOf(s, 0, 'OH', true);
    s.tossTarget = hitter.id;
    applyContact(s, { tick: s.tick, team: 0, player: setter.id, kind: 'toss', judgment: 'PERFECT', charge: 0.6, mx: 0, mf: 0, dt: 0 }, s.tick);
    expect(s.lastContactKind).toBe('toss');
    // スパイカーの打点（ボールが手の高さまで下りてくる所）の後ろ（自陣側、2.6m 以内）にカバーが3人
    const ip = interceptPoint(s, 0, 3.4)!;
    const hp = toLocal(0, ip.x, ip.z);
    const near = s.players.filter((p) => {
      if (p.team !== 0 || p.id === hitter.id) return false;
      const l = local(s, p.id);
      return Math.hypot(l.lx - hp.lx, l.lz - hp.lz) < 2.6 && l.lz > hp.lz;
    });
    expect(near.length).toBeGreaterThanOrEqual(3);
  });

  /** 相手が自コートの右側（lx=+3.3 の正面）から打ってくる */
  function attackFromRight(defense: Rules['defense']) {
    const s = game({ system: '5-1', defense });
    const atk = playerOf(s, 1, 'OH', true);
    const w = toWorld(0, 3.3, -0.9); // 相手コート内、自コートから見て右
    atk.x = w.x;
    atk.z = w.z;
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = 'toss';
    s.tossTarget = atk.id;
    s.teams[1].contactsLeft = 1;
    const from = v3(-0.6, 2.2, -1.2);
    launch(s.ball, from, solveByApex(from, atk.x, atk.z, 5));
    computePath(s);
    updateActors(s);
    const byPos = (pos: number) => s.players.find((p) => p.team === 0 && switchedPos(s, p) === pos)!;
    return { s, byPos };
  }

  it('ペリメーター：右から来る攻撃に、右後衛はストレート（右サイドライン寄り）を深めに守る', () => {
    const { s, byPos } = attackFromRight('perimeter');
    const l = local(s, byPos(1).id);
    expect(l.lx).toBeGreaterThan(3);
    expect(l.lz).toBeGreaterThan(5.5);
  });

  it('ローテーション：右から来る攻撃に、右後衛はブロックの後ろへ上がり、中央の後衛がストレートの奥へ回る', () => {
    const { s, byPos } = attackFromRight('rotation');
    const r = local(s, byPos(1).id);
    expect(r.lz).toBeLessThan(4);
    const m = local(s, byPos(6).id);
    expect(m.lx).toBeGreaterThan(3);
    expect(m.lz).toBeGreaterThan(7);
  });

  it('左から来る攻撃では左右反転する', () => {
    const s = game({ system: '5-1', defense: 'rotation' });
    const atk = playerOf(s, 1, 'OH', true);
    const w = toWorld(0, -3.3, -0.9);
    atk.x = w.x;
    atk.z = w.z;
    s.phase = 'rally';
    s.serveTossed = true;
    s.lastTouchTeam = 1;
    s.lastContactKind = 'toss';
    s.tossTarget = atk.id;
    s.teams[1].contactsLeft = 1;
    const from = v3(0.6, 2.2, -1.2);
    launch(s.ball, from, solveByApex(from, atk.x, atk.z, 5));
    computePath(s);
    updateActors(s);
    const left = s.players.find((p) => p.team === 0 && switchedPos(s, p) === 5)!;
    expect(local(s, left.id).lz).toBeLessThan(4); // 左後衛がブロックの後ろへ上がる
  });
});
