import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { NET } from '../shared/constants.ts';
import { createGame, currentAction, step, timeToContact } from '../shared/game.ts';
import { fromSnapshot, parseClientMsg, sanitizeRules, toSnapshot, type ClientMsg, type ServerMsg } from '../shared/net.ts';
import { startServer, type RunningServer } from '../server/rooms.ts';

describe('状態の送受信', () => {
  it('受け取った状態から、サーバーと同じ動作・タイミングを表示できる', () => {
    const s = createGame({ seed: 3, humans: [false, false] });
    for (let i = 0; i < 60 * 60; i++) {
      step(s);
      const c = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))));
      for (const T of [0, 1] as const) {
        expect(currentAction(c, T)).toBe(currentAction(s, T));
        expect(timeToContact(c, T)).toBeCloseTo(timeToContact(s, T), 9);
      }
      expect(c.predLandTick).toBe(s.predLandTick);
    }
  });

  it('送る状態に履歴・予測軌道・乱数は入らない', () => {
    const s = createGame({ seed: 1 });
    for (let i = 0; i < 120; i++) step(s);
    const snap = toSnapshot(s) as unknown as Record<string, unknown>;
    expect(snap.history).toBeUndefined();
    expect(snap.path).toBeUndefined();
    expect(snap.rng).toBeUndefined();
  });

  it('おかしなルール・メッセージは受け付けない', () => {
    const r = sanitizeRules({ pointsPerSet: 999, sets: 4 as never, serveTime: -1, system: 'x' as never });
    expect(r.pointsPerSet).toBe(25);
    expect(r.sets).toBe(1);
    expect(r.serveTime).toBe(3);
    expect(r.system).toBe('5-1');
    expect(parseClientMsg('{')).toBeNull();
    expect(parseClientMsg('{"t":"stick","mx":"a","mf":0}')).toBeNull();
    expect(parseClientMsg('{"t":"hack"}')).toBeNull();
  });
});

/** テスト用のクライアント。届いたメッセージを順に待てる */
class TestClient {
  ws: WebSocket;
  private queue: ServerMsg[] = [];
  private waiters: ((m: ServerMsg) => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  open = () => new Promise<void>((ok) => this.ws.once('open', () => ok()));
  send = (m: ClientMsg) => this.ws.send(JSON.stringify(m));
  next(): Promise<ServerMsg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((ok) => this.waiters.push(ok));
  }
  /** 条件に合うメッセージが来るまで読み飛ばす */
  async until<T extends ServerMsg>(f: (m: ServerMsg) => m is T, limit = 2000): Promise<T> {
    for (let i = 0; i < limit; i++) {
      const m = await this.next();
      if (f(m)) return m;
    }
    throw new Error('来なかった');
  }
}

const isT =
  <K extends ServerMsg['t']>(t: K) =>
  (m: ServerMsg): m is Extract<ServerMsg, { t: K }> =>
    m.t === t;

describe('サーバー', () => {
  let srv: RunningServer;
  let url = '';
  beforeAll(async () => {
    srv = await startServer({ port: 0 });
    url = `ws://localhost:${(srv.http.address() as AddressInfo).port}${NET.path}`;
  });
  afterAll(() => srv.close());

  it('部屋を作って参加すると試合が始まり、入力でサーブが打て、退出が相手に伝わる', async () => {
    const a = new TestClient(url);
    const b = new TestClient(url);
    await Promise.all([a.open(), b.open()]);

    a.send({ t: 'create', rules: { ...sanitizeRules(undefined), pointsPerSet: 5 } });
    const created = await a.until(isT('created'));
    expect(created.code).toMatch(/^\d{4}$/);

    b.send({ t: 'join', code: '----' });
    expect((await b.until(isT('error'))).msg).toContain('見つかりません');

    b.send({ t: 'join', code: created.code });
    expect((await a.until(isT('start'))).team).toBe(0);
    expect((await b.until(isT('start'))).team).toBe(1);

    // 両方に同じ状態が届く。ルールは作った人のもの
    const sa = await a.until(isT('snap'));
    expect(sa.s.rules.pointsPerSet).toBe(5);
    expect(sa.s.teams[0].human && sa.s.teams[1].human).toBe(true);
    const sb = await b.until(isT('snap'));
    expect(sb.s.tick).toBeGreaterThan(0);

    // 3人目は入れない
    const c = new TestClient(url);
    await c.open();
    c.send({ t: 'join', code: created.code });
    expect((await c.until(isT('error'))).msg).toContain('満員');
    c.ws.close();

    // チーム0（作った人）のサーブ：押すとトス、離すとサーブ
    a.send({ t: 'press', rt: 1e9 });
    await a.until((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap' && m.s.serveTossed);
    await new Promise((ok) => setTimeout(ok, 500));
    a.send({ t: 'release', rt: 1e9 });
    const judged = await b.until((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap' && m.ev.some((e) => e.type === 'judge' && e.team === 0));
    expect(judged.ev.find((e) => e.type === 'judge')).toMatchObject({ action: 'serve' });

    // 1回分の状態の大きさ（通信量の目安）
    const bytes = JSON.stringify(judged).length;
    console.log(`状態1回 ${bytes} バイト、${60 / NET.snapshotEvery}Hzで 約${((bytes * 60) / NET.snapshotEvery / 1024).toFixed(0)}KB/秒`);

    b.ws.close();
    await a.until(isT('opponentLeft'));
    a.ws.close();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(srv.rooms.size).toBe(0);
  }, 15000);
});
