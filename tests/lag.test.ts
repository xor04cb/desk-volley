// 遅延を模擬して、ラグ補償で判定が破綻しないことを確かめる（フェーズ9の完了条件）。
// サーバー（shared の状態＋applyGameMsg）とクライアント（client/netsync.ts の NetSession）を、時刻を進めながら手で配達してつなぐ。
// クライアントは「画面に見えている状態」だけを見て動き、ボールが打点に来た瞬間に離すボット
import { describe, expect, it } from 'vitest';
import { interceptPoint, riseTime } from '../shared/actions.ts';
import { JUMP_HEIGHT_MAX, JUMP_HEIGHT_MIN, NET, STANDING_REACH, TICK_RATE } from '../shared/constants.ts';
import { createGame, currentAction, step, timeToContact } from '../shared/game.ts';
import { applyGameMsg, toSnapshot, type ClientMsg, type ServerMsg } from '../shared/net.ts';
import type { GameEvent, GameState, Judgment, PracticeKind } from '../shared/types.ts';
import { NetSession, type PadInput } from '../client/netsync.ts';

interface SimResult {
  judgments: Judgment[];
  /** ずれ（秒、+は遅い）の平均 */
  meanDt: number;
}

function simulate(o: { lagMs: number; jitterMs?: number; compensate: boolean; drill: PracticeKind; seconds: number }): SimResult {
  const S = createGame({ seed: 11, humans: [true, false], practice: { kind: o.drill, tossZone: 'left' } });
  const net = new NetSession(0);
  const tickMs = 1000 / TICK_RATE;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const queue = <T>() => ({ list: [] as { at: number; m: T }[], last: 0 });
  const up = queue<ClientMsg>();
  const down = queue<ServerMsg>();
  const post = <T>(q: { list: { at: number; m: T }[]; last: number }, now: number, m: T) => {
    const at = Math.max(q.last, now + o.lagMs / 2 + rnd() * (o.jitterMs ?? 0));
    q.last = at;
    q.list.push({ at, m: JSON.parse(JSON.stringify(m)) });
  };
  const judged: GameEvent[] = [];
  let nextTick = 0;
  let nextFrame = 5;
  let nextPing = 0;
  let pings = 0;
  let lastTick = 0;
  let held = false;
  let sinceSnap = 0;

  for (let now = 0; now < o.seconds * 1000; now += 0.5) {
    // サーバー：届いた入力を当て、tick を進めて状態を送る
    while (up.list.length && up.list[0].at <= now) {
      let m = up.list.shift()!.m;
      if (!o.compensate && (m.t === 'press' || m.t === 'release')) m = { ...m, rt: 1e9 }; // 補償なし：届いた時点で判定
      const reply = applyGameMsg(S, 0, m, (now - lastTick) / tickMs);
      if (reply) post(down, now, reply);
    }
    if (now >= nextTick) {
      lastTick = nextTick;
      nextTick += tickMs;
      step(S);
      for (const e of S.events) if (e.type === 'judge' && e.team === 0) judged.push(e);
      if (++sinceSnap >= NET.snapshotEvery) {
        sinceSnap = 0;
        post(down, now, { t: 'snap', s: toSnapshot(S), ev: [] });
      }
    }
    // クライアント
    while (down.list.length && down.list[0].at <= now) {
      const m = down.list.shift()!.m;
      if (m.t === 'snap') net.onSnap(m.s, m.ev);
      else if (m.t === 'pong') net.onPong(m.c, m.tick, now);
    }
    if (now >= nextPing) {
      post(up, now, net.pingMsg(now));
      nextPing = now + (++pings < 5 ? 150 : NET.pingMs);
    }
    if (now >= nextFrame) {
      nextFrame += tickMs;
      const f = net.frame(now);
      if (!f) continue;
      const pad = bot(f.view, net.r, held);
      held = pad.held;
      for (const m of net.input(pad)) post(up, now, m);
    }
  }
  // 見るのはレシーブ・スパイク（ボットはトスの位置へ入らないので、拾った後のトスは数えない）
  const js = judged.filter((e): e is Extract<GameEvent, { type: 'judge' }> => e.type === 'judge' && e.action !== 'jump' && e.action !== 'toss');
  return { judgments: js.map((e) => e.judgment), meanDt: js.reduce((a, e) => a + e.dt, 0) / Math.max(js.length, 1) };
}

/** 画面に見えている状態だけで動くボット：落下予測地点へ走り、打点に来る少し前に押して、来た瞬間に離す */
function bot(v: GameState, r: number, held: boolean): PadInput {
  const T = 0;
  const p = v.players[v.teams[T].controlled];
  let mx = 0;
  let mf = 0;
  if (v.phase === 'rally' && v.predLandTick > v.tick && v.predLandZ > 0 && !held) {
    const dx = v.predLandX - p.x;
    const dz = v.predLandZ - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.3) {
      mx = dx / d;
      mf = -dz / d; // チーム0：ネット方向（画面の上）は -z
    }
  }
  const action = currentAction(v, T);
  if (action === 'jump' || action === 'twoJump') {
    // 跳ぶ：最高点の少し前に手の高さへボールが来るように、溜め0.5で跳ぶ
    const h = JUMP_HEIGHT_MIN + (JUMP_HEIGHT_MAX - JUMP_HEIGHT_MIN) * 0.5;
    const hit = interceptPoint(v, T, STANDING_REACH + h);
    if (!hit) return { mx, mf, held: false };
    const jumpAt = hit.tick - riseTime(h) * TICK_RATE;
    if (!held) return { mx, mf, held: jumpAt - r < 0.3 * TICK_RATE && jumpAt - r > 1 };
    return { mx: 0, mf: 0, held: jumpAt - r > 1 };
  }
  const ttc = timeToContact(v, T);
  if (action === 'none' || ttc < 0) return { mx, mf, held: false };
  const contactTick = v.tick + ttc * TICK_RATE;
  if (!held) return { mx, mf, held: ttc < 0.35 && contactTick - r > 1 };
  return { mx, mf, held: contactTick - r > 1 }; // 次の tick で打点に来るなら離す
}

const count = (js: Judgment[]) => {
  const c: Record<Judgment, number> = { PERFECT: 0, GOOD: 0, BAD: 0, MISS: 0 };
  for (const j of js) c[j]++;
  return c;
};

describe('遅延150msでの判定（ラグ補償）', () => {
  for (const drill of ['serveCut', 'spikeReceive', 'spike'] as PracticeKind[]) {
    it(`${drill}：遅延なしと同じくらい判定が取れ、補償しないと遅れる`, () => {
      const base = simulate({ lagMs: 0, compensate: true, drill, seconds: 60 });
      const lag = simulate({ lagMs: 150, jitterMs: 15, compensate: true, drill, seconds: 60 });
      const raw = simulate({ lagMs: 150, jitterMs: 15, compensate: false, drill, seconds: 60 });
      const rate = (r: SimResult) => (count(r.judgments).PERFECT + count(r.judgments).GOOD) / Math.max(r.judgments.length, 1);
      const perfect = (r: SimResult) => count(r.judgments).PERFECT / Math.max(r.judgments.length, 1);
      console.log(
        `${drill}\n  遅延なし      ${JSON.stringify(count(base.judgments))} 平均ずれ ${(base.meanDt * 1000).toFixed(0)}ms` +
          `\n  150ms＋補償   ${JSON.stringify(count(lag.judgments))} 平均ずれ ${(lag.meanDt * 1000).toFixed(0)}ms` +
          `\n  150ms補償なし ${JSON.stringify(count(raw.judgments))} 平均ずれ ${(raw.meanDt * 1000).toFixed(0)}ms`,
      );
      // ボットが届かない・トスを失敗するなどのMISSは遅延なしでも起きるので、遅延なしと比べる
      expect(lag.judgments.length).toBeGreaterThanOrEqual(8);
      expect(rate(lag)).toBeGreaterThanOrEqual(rate(base) - 0.05);
      expect(Math.abs(lag.meanDt - base.meanDt)).toBeLessThan(0.02);
      expect(perfect(raw)).toBeLessThan(perfect(lag) - 0.5); // 補償しないと、同じ押し方でも遅れの判定になる
    }, 60000);
  }
});
