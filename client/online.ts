// オンライン対戦：部屋コードで相手とつなぎ、入力を送って、サーバーから届いた状態を描く。
// 遅延対策（時刻合わせ・補間・予測）は netsync.ts
import { NET } from '../shared/constants.ts';
import type { ClientMsg, ServerMsg, Snapshot } from '../shared/net.ts';
import type { GameEvent, GameState, TeamId } from '../shared/types.ts';
import { Hud, ACTION_LABEL } from './hud.ts';
import { combine, Keyboard, KEYS_ANY, TouchPad } from './input.ts';
import { showMatchEnd, showPauseMenu } from './menus.ts';
import { NetSession } from './netsync.ts';
import type { Renderer } from './renderer.ts';
import type { Settings } from './settings.ts';
import { drawState, showEvents, type ViewOptions } from './view.ts';

/** 接続先：?server=ws://... で指定できる。既定は画面と同じホストの /ws（開発中は Vite がサーバーへ中継する） */
function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${NET.path}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function button(parent: HTMLElement, text: string, onClick: () => void, cls = 'btn wide'): HTMLButtonElement {
  const b = el('button', cls, parent, text);
  b.onclick = onClick;
  return b;
}

export function startOnline(
  ui: HTMLElement,
  r: Renderer,
  settings: Settings,
  back: () => void,
  onSettings: (s: Settings) => void,
): { destroy(): void } {
  let ws: WebSocket | null = null;
  let panel: HTMLDivElement | null = null;
  let match: Match | null = null;
  let closedByUs = false;

  const send = (m: ClientMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  function showPanel(build: (p: HTMLDivElement) => void): void {
    panel?.remove();
    panel = el('div', 'menu online', ui);
    build(panel);
  }

  /** 最初の画面：部屋を作るか、コードを入れて参加する */
  function lobby(status = ''): void {
    showPanel((p) => {
      el('h2', '', p, 'オンライン対戦');
      const st = el('p', 'sub', p, status || '部屋を作るか、相手の部屋コードを入れてください');
      button(p, '部屋を作る', () => {
        st.textContent = '接続中…';
        connect(() => send({ t: 'create', rules: settings.rules }));
      }, 'btn wide primary');
      const input = el('input', '', p);
      input.inputMode = 'numeric';
      input.maxLength = NET.codeDigits;
      input.placeholder = '0'.repeat(NET.codeDigits);
      input.style.marginTop = '16px';
      const join = () => {
        const code = input.value.replace(/\D/g, '');
        if (code.length !== NET.codeDigits) {
          st.textContent = `${NET.codeDigits}桁の部屋コードを入れてください`;
          return;
        }
        st.textContent = '接続中…';
        connect(() => send({ t: 'join', code }));
      };
      input.onkeydown = (e) => e.key === 'Enter' && join();
      button(p, '参加する', join);
      const help = el('p', 'help', p);
      help.innerHTML = 'ルールは部屋を作った人の設定を使います。<br>部屋を作った人が手前（チーム0）になります。';
      button(p, 'もどる', leaveToTitle, 'btn wide ghost');
    });
  }

  function waiting(code: string): void {
    showPanel((p) => {
      el('h2', '', p, '相手を待っています');
      el('p', 'sub', p, '相手に部屋コードを伝えてください');
      const c = el('div', 'room-code', p, code);
      c.style.cssText = 'font-size:44px;font-weight:700;letter-spacing:.3em;margin:8px 0 4px';
      button(p, 'やめる', () => {
        send({ t: 'leave' });
        lobby();
      }, 'btn wide ghost');
    });
  }

  function message(title: string, text: string): void {
    match?.destroy();
    match = null;
    showPanel((p) => {
      el('h2', '', p, title);
      el('p', 'sub', p, text);
      button(p, 'オンライン対戦へ', () => lobby(), 'btn wide primary');
      button(p, 'タイトルへ', leaveToTitle, 'btn wide ghost');
    });
  }

  function connect(then: () => void): void {
    if (ws && ws.readyState === WebSocket.OPEN) return then();
    ws?.close();
    closedByUs = false;
    const sock = new WebSocket(serverUrl());
    ws = sock;
    sock.onopen = then;
    sock.onmessage = (e) => onMessage(JSON.parse(String(e.data)) as ServerMsg);
    sock.onclose = () => {
      if (ws !== sock || closedByUs) return;
      ws = null;
      if (match) message('接続が切れました', 'サーバーとの接続が切れました');
      else lobby('サーバーにつながりません。サーバー（npm run server）が動いているか確認してください');
    };
  }

  function onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'created':
        waiting(m.code);
        return;
      case 'error':
        lobby(m.msg);
        return;
      case 'start':
        panel?.remove();
        panel = null;
        if (match && match.team === m.team) match.restart();
        else {
          match?.destroy();
          match = new Match(ui, r, m.team, settings, send, {
            title: leaveToTitle,
            settings: (st) => {
              settings = st;
              onSettings(st);
            },
          });
        }
        return;
      case 'snap':
        match?.receive(m.s, m.ev);
        return;
      case 'pong':
        match?.onPong(m.c, m.tick);
        return;
      case 'rematchWait':
        match?.opponentWantsRematch();
        return;
      case 'opponentLeft':
        message('相手が退出しました', '試合は終了しました');
        return;
    }
  }

  function leaveToTitle(): void {
    destroy();
    back();
  }

  function destroy(): void {
    closedByUs = true;
    send({ t: 'leave' });
    ws?.close();
    ws = null;
    match?.destroy();
    match = null;
    panel?.remove();
  }

  lobby();
  return { destroy };
}

/** 試合中の画面：入力を送り、遅延対策（補間・予測）をした状態を描く */
class Match {
  private hud: Hud;
  private pad: TouchPad;
  private kb = new Keyboard(KEYS_ANY);
  private net: NetSession;
  /** 最後に描いた状態（メニューのセット表に使う） */
  private s: GameState | null = null;
  private view: ViewOptions;
  private names: [string, string];
  private raf = 0;
  private pingTimer = 0;
  private pings = 0;
  private endPanel: HTMLElement | null = null;
  private retryBtn: HTMLButtonElement | null = null;
  private wantRematch = false;

  constructor(
    private ui: HTMLElement,
    private r: Renderer,
    readonly team: TeamId,
    private settings: Settings,
    private send: (m: ClientMsg) => void,
    private h: { title: () => void; settings: (s: Settings) => void },
  ) {
    r.view = team;
    this.net = new NetSession(team);
    this.view = { humanTeam: team };
    this.names = team === 0 ? ['あなた', 'あいて'] : ['あいて', 'あなた'];
    this.hud = new Hud(ui, { names: this.names, mainTeam: team, onPause: () => this.menu() });
    this.hud.debugOn = settings.debug;
    this.pad = new TouchPad(ui);
    this.pad.setVisible(settings.showPad);
    this.ping();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** 時刻合わせ：最初は短い間隔で数回、その後は NET.pingMs ごと */
  private ping = () => {
    this.send(this.net.pingMsg(performance.now()));
    this.pings++;
    this.pingTimer = window.setTimeout(this.ping, this.pings < 5 ? 150 : NET.pingMs);
  };

  onPong(c: number, tick: number): void {
    this.net.onPong(c, tick, performance.now());
  }

  private menu(): void {
    if (!this.s || this.ui.querySelector('.menu.pause')) return;
    showPauseMenu(this.ui, this.s, this.settings, {
      online: true,
      resume: () => {},
      title: this.h.title,
      changed: (st) => {
        this.settings = st;
        this.pad.setVisible(st.showPad);
        this.hud.debugOn = st.debug;
        this.h.settings(st);
      },
    });
  }

  /** もう一度：同じ画面のまま新しい試合を始める */
  restart(): void {
    this.endPanel?.remove();
    this.endPanel = null;
    this.retryBtn = null;
    this.wantRematch = false;
    this.s = null;
    this.net.reset();
  }

  receive(snap: Snapshot, events: GameEvent[]): void {
    // 自分の判定（PERFECTなど）は届いたらすぐ出す。それ以外は画面のボールが追いついたときに出す
    const mine = this.net.onSnap(snap, events);
    if (mine.length && this.s) showEvents(this.r, this.hud, this.s, mine, this.view);
  }

  opponentWantsRematch(): void {
    if (this.retryBtn && !this.wantRematch) this.retryBtn.textContent = 'もう一度（相手は待っています）';
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    for (const m of this.net.input(combine(this.pad.state(), this.kb.state()))) this.send(m);
    const f = this.net.frame(now);
    if (!f) return;
    for (const e of f.events) showEvents(this.r, this.hud, e.s, e.ev, this.view);
    const s = f.view;
    this.s = s;
    this.hud.debugExtra = `往復 ${this.net.clock.rttMs.toFixed(0)}ms  表示 ${this.net.r.toFixed(1)}  予測 ${this.net.a.toFixed(1)}`;
    const actions = drawState(this.r, this.hud, s, this.view);
    this.pad.setLabel(ACTION_LABEL[actions[this.team]]);
    if (s.phase === 'matchEnd' && !this.endPanel) {
      this.ui.querySelector('.menu.pause')?.remove();
      this.retryBtn = showMatchEnd(this.ui, s, this.names, {
        retry: () => {
          if (this.wantRematch) return;
          this.wantRematch = true;
          this.retryBtn!.textContent = '相手を待っています…';
          this.send({ t: 'rematch' });
        },
        title: this.h.title,
      });
      this.endPanel = this.ui.querySelector('.menu.end');
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.pingTimer);
    this.hud.destroy();
    this.pad.destroy();
    this.endPanel?.remove();
    this.ui.querySelector('.menu.pause')?.remove();
  }
}
