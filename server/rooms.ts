// 部屋の管理と試合の進行（サーバー権威：物理とルールはここだけで確定させる）
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, NET } from '../shared/constants.ts';
import { createGame, step } from '../shared/game.ts';
import { applyGameMsg, parseClientMsg, toSnapshot, type ServerMsg } from '../shared/net.ts';
import type { GameEvent, GameState, Rules, TeamId } from '../shared/types.ts';

interface Room {
  code: string;
  rules: Rules;
  /** チーム0＝部屋を作った人、チーム1＝参加した人 */
  clients: [WebSocket | null, WebSocket | null];
  game: GameState | null;
  /** 次の状態配信までに溜めたイベント */
  events: GameEvent[];
  sinceSnap: number;
  rematch: [boolean, boolean];
}

export interface ServerOptions {
  port: number;
  /** ビルド済みのクライアント（dist）を配る場合のフォルダ */
  staticDir?: string;
  /** 確認用の人工的な遅延（往復 ms）。受信と送信に半分ずつ入れる */
  fakeLagMs?: number;
  /** 人工的な遅延のゆらぎ（片道に 0〜この ms を足す） */
  fakeJitterMs?: number;
}

/** 片道 ms（＋ゆらぎ）遅らせて実行する。同じ接続の中では順番を入れ替えない */
function makeDelayer(ms: number, jitter: number): (key: WebSocket, fn: () => void) => void {
  const last = new WeakMap<WebSocket, number>();
  return (key, fn) => {
    if (ms <= 0 && jitter <= 0) return fn();
    const at = Math.max(performance.now() + ms + Math.random() * jitter, last.get(key) ?? 0);
    last.set(key, at);
    setTimeout(fn, at - performance.now());
  };
}

export interface RunningServer {
  http: Server;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const rooms = new Map<string, Room>();
  const roomOf = new Map<WebSocket, { room: Room; team: TeamId }>();
  const oneWay = (opts.fakeLagMs ?? 0) / 2;
  const delayIn = makeDelayer(oneWay, opts.fakeJitterMs ?? 0);
  const delayOut = makeDelayer(oneWay, opts.fakeJitterMs ?? 0);
  const sendRaw = (ws: WebSocket | null, data: string) => {
    if (!ws) return;
    delayOut(ws, () => ws.readyState === ws.OPEN && ws.send(data));
  };
  const send = (ws: WebSocket | null, m: ServerMsg) => sendRaw(ws, JSON.stringify(m));

  const http = createServer((req, res) => {
    if (!opts.staticDir) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('desk-volley server');
      return;
    }
    serveStatic(opts.staticDir, req.url ?? '/').then(
      (r) => {
        res.writeHead(r ? 200 : 404, { 'content-type': r?.type ?? 'text/plain' });
        res.end(r?.body ?? 'not found');
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });
  const wss = new WebSocketServer({ server: http, path: NET.path });

  function newCode(): string {
    const n = 10 ** NET.codeDigits;
    for (;;) {
      const code = String(Math.floor(Math.random() * n)).padStart(NET.codeDigits, '0');
      if (!rooms.has(code)) return code;
    }
  }

  function startMatch(room: Room): void {
    room.game = createGame({ rules: room.rules, seed: (Math.random() * 0x7fffffff) >>> 0, humans: [true, true] });
    room.events = [];
    room.sinceSnap = NET.snapshotEvery; // すぐに最初の状態を送る
    room.rematch = [false, false];
    room.clients.forEach((ws, team) => send(ws, { t: 'start', team: team as TeamId }));
  }

  /** 部屋から抜ける。相手がいれば知らせて部屋を閉じる */
  function leave(ws: WebSocket): void {
    const r = roomOf.get(ws);
    if (!r) return;
    roomOf.delete(ws);
    const { room, team } = r;
    room.clients[team] = null;
    const other = room.clients[1 - team];
    if (other) {
      send(other, { t: 'opponentLeft' });
      roomOf.delete(other);
    }
    rooms.delete(room.code);
  }

  wss.on('connection', (ws) => {
    ws.on('message', (data) => delayIn(ws, () => onMessage(ws, String(data))));
    ws.on('close', () => delayIn(ws, () => leave(ws)));
    ws.on('error', () => leave(ws));
  });

  function onMessage(ws: WebSocket, data: string): void {
    const m = parseClientMsg(data);
    if (!m) return;
    const r = roomOf.get(ws);
    switch (m.t) {
      case 'create': {
        if (r) leave(ws);
        const room: Room = { code: newCode(), rules: m.rules, clients: [ws, null], game: null, events: [], sinceSnap: 0, rematch: [false, false] };
        rooms.set(room.code, room);
        roomOf.set(ws, { room, team: 0 });
        send(ws, { t: 'created', code: room.code });
        return;
      }
      case 'join': {
        if (r) leave(ws);
        const room = rooms.get(m.code);
        if (!room) return send(ws, { t: 'error', msg: 'その部屋コードは見つかりません' });
        if (room.clients[1]) return send(ws, { t: 'error', msg: 'その部屋は満員です' });
        room.clients[1] = ws;
        roomOf.set(ws, { room, team: 1 });
        startMatch(room);
        return;
      }
      case 'leave':
        leave(ws);
        return;
    }
    if (!r) return;
    const { room, team } = r;
    const s = room.game;
    if (!s) return;
    if (m.t === 'rematch') {
      if (s.phase !== 'matchEnd') return;
      room.rematch[team] = true;
      if (room.rematch[0] && room.rematch[1]) startMatch(room);
      else send(room.clients[1 - team], { t: 'rematchWait' });
      return;
    }
    const reply = applyGameMsg(s, team, m, acc / DT);
    if (reply) send(ws, reply);
  }

  // 固定タイムステップ。タイマーの精度（Windowsでは約16ms）に頼らず、経過時間ぶん tick を進める
  let last = performance.now();
  let acc = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + (now - last) / 1000, DT * 10); // 止まっていた後に一気に進めすぎない
    last = now;
    while (acc >= DT) {
      acc -= DT;
      for (const room of rooms.values()) tickRoom(room);
    }
  }, 4);

  function tickRoom(room: Room): void {
    const s = room.game;
    if (!s) return;
    if (s.phase !== 'matchEnd') {
      step(s);
      room.events.push(...s.events);
    }
    if (++room.sinceSnap >= NET.snapshotEvery) {
      room.sinceSnap = 0;
      const msg = JSON.stringify({ t: 'snap', s: toSnapshot(s), ev: room.events } satisfies ServerMsg);
      room.events = [];
      for (const ws of room.clients) sendRaw(ws, msg);
    }
  }

  return new Promise((ok) => {
    http.listen(opts.port, () =>
      ok({
        http,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(timer);
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => done());
          }),
      }),
    );
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(dir: string, url: string): Promise<{ body: Buffer; type: string } | null> {
  const root = resolve(dir);
  const path = decodeURIComponent(url.split('?')[0]);
  const file = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(root + sep)) return null; // フォルダの外は出さない
  try {
    return { body: await readFile(file), type: TYPES[extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}
