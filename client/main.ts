// 画面遷移（タイトル・設定・試合）とローカル対戦のゲームループ
import { DT } from '../shared/constants.ts';
import { createGame, press, release, setStick, step } from '../shared/game.ts';
import { DEFAULT_RULES, type GameEvent, type GameState, type Rules, type TeamId } from '../shared/types.ts';
import { Hud, ACTION_LABEL } from './hud.ts';
import { combine, Keyboard, KEYS_ANY, KEYS_P1, KEYS_P2, TouchPad, type PadState } from './input.ts';
import { Renderer } from './renderer.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { showMatchEnd, showPauseMenu, showSettings, showTitle } from './menus.ts';
import { drawState, showEvents, type ViewOptions } from './view.ts';
import { startOnline } from './online.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const renderer = new Renderer(canvas);
let settings: Settings = loadSettings();

export type Mode = 'cpu' | 'local2p';

/** 1人分の入力（タッチ＋キーボード）と、押した・離した瞬間の検出 */
class Controller {
  private wasHeld = false;
  constructor(
    readonly team: TeamId,
    readonly pad: TouchPad,
    private kb: Keyboard,
  ) {}
  read(): PadState {
    return combine(this.pad.state(), this.kb.state());
  }
  apply(s: GameState): void {
    const st = this.read();
    setStick(s, this.team, st.mx, st.mf);
    if (st.held && !this.wasHeld) press(s, this.team);
    if (!st.held && this.wasHeld) release(s, this.team);
    this.wasHeld = st.held;
  }
}

class LocalSession {
  s: GameState;
  hud: Hud;
  ctrls: Controller[] = [];
  paused = false;
  acc = 0;
  last = performance.now();
  raf = 0;
  ended = false;
  view: ViewOptions;

  constructor(
    readonly mode: Mode,
    readonly rules: Rules,
  ) {
    const two = mode === 'local2p';
    this.s = createGame({ rules, seed: (Date.now() & 0x7fffffff) >>> 0, humans: [true, two] });
    renderer.view = two ? 'top' : 0;
    this.view = { humanTeams: two ? [0, 1] : [0], flippedTeam: two ? 1 : null, landingFor: two ? [0, 1] : [0] };
    this.hud = new Hud(ui, {
      names: two ? ['プレイヤー1', 'プレイヤー2'] : ['あなた', 'CPU'],
      mainTeam: 0,
      topTeam: two ? 1 : null,
      onPause: () => this.pause(),
    });
    this.ctrls.push(new Controller(0, new TouchPad(ui, false, two), new Keyboard(two ? KEYS_P1 : KEYS_ANY)));
    if (two) this.ctrls.push(new Controller(1, new TouchPad(ui, true, true), new Keyboard(KEYS_P2)));
    for (const c of this.ctrls) c.pad.setVisible(settings.showPad);
    this.hud.debugOn = settings.debug;
    window.addEventListener('keydown', this.onKey);
    this.raf = requestAnimationFrame(this.frame);
    (window as unknown as { __dv: unknown }).__dv = this; // デバッグ用
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape' || e.code === 'KeyP') this.paused ? null : this.pause();
  };

  pause(): void {
    if (this.paused || this.ended) return;
    this.paused = true;
    showPauseMenu(ui, this.s, settings, {
      resume: () => {
        this.paused = false;
        this.last = performance.now();
      },
      retry: () => restart(this.mode, this.rules),
      title: () => goTitle(),
      changed: (st) => {
        settings = st;
        saveSettings(st);
        for (const c of this.ctrls) c.pad.setVisible(st.showPad);
        this.hud.debugOn = st.debug;
      },
    });
  }

  /** n tick 進める（テスト・デバッグ用にも使う） */
  tick(n = 1): GameEvent[] {
    const all: GameEvent[] = [];
    for (let i = 0; i < n; i++) {
      for (const c of this.ctrls) c.apply(this.s);
      step(this.s);
      all.push(...this.s.events);
    }
    return all;
  }

  frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (!this.paused && !this.ended) {
      this.acc += dt;
      while (this.acc >= DT) {
        this.acc -= DT;
        const ev = this.tick(1);
        if (ev.length) showEvents(renderer, this.hud, this.s, ev, this.view);
      }
    }
    const actions = drawState(renderer, this.hud, this.s, this.view, dt);
    this.ctrls.forEach((c) => c.pad.setLabel(ACTION_LABEL[actions[c.team]]));
    if (this.s.phase === 'matchEnd' && !this.ended) {
      this.ended = true;
      const names: [string, string] = this.mode === 'local2p' ? ['プレイヤー1', 'プレイヤー2'] : ['あなた', 'CPU'];
      showMatchEnd(ui, this.s, names, { retry: () => restart(this.mode, this.rules), title: () => goTitle() });
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.hud.destroy();
    for (const c of this.ctrls) c.pad.destroy();
  }
}

let session: { destroy(): void } | null = null;

function clearUI(): void {
  session?.destroy();
  session = null;
  ui.innerHTML = '';
}

function restart(mode: Mode, rules: Rules): void {
  clearUI();
  session = new LocalSession(mode, rules);
}

function goTitle(): void {
  clearUI();
  renderer.view = 0;
  showTitle(ui, {
    cpu: () => restart('cpu', settings.rules),
    local2p: () => restart('local2p', settings.rules),
    online: () => {
      clearUI();
      session = startOnline(ui, renderer, settings, goTitle);
    },
    settings: () =>
      showSettings(ui, settings.rules, (rules) => {
        settings = { ...settings, rules };
        saveSettings(settings);
        goTitle();
      }),
  });
  idle();
}

/** タイトル画面の背景：コートをゆっくり描く */
function idle(): void {
  const s0 = createGame({ rules: DEFAULT_RULES, humans: [false, false], seed: 7 });
  let last = performance.now();
  let acc = 0;
  const loop = (now: number) => {
    if (session) return;
    if (!ui.querySelector('.menu')) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      step(s0);
    }
    renderer.setBall(s0.ball.pos);
    renderer.setPlayers(s0.players.map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y, z: p.z, fx: p.fx, fz: p.fz, armsUp: p.jump !== 'none' })));
    renderer.setLanding(0, 0, false);
    renderer.setMarker(0, null);
    renderer.setMarker(1, null);
    renderer.updateCamera(dt, s0.ball.pos.z);
    renderer.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// URL で直接モードを指定できる（?mode=cpu / local2p）
const q = new URLSearchParams(location.search);
const m = q.get('mode');
if (m === 'cpu' || m === 'local2p') restart(m, settings.rules);
else goTitle();
