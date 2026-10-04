// 画面遷移（タイトル・設定・試合）とローカル対戦のゲームループ
import { DT } from '../shared/constants.ts';
import { createGame, press, release, setStick, step } from '../shared/game.ts';
import { DEFAULT_RULES, type GameEvent, type GameState, type Rules, type TeamId } from '../shared/types.ts';
import { Hud, ACTION_LABEL } from './hud.ts';
import { combine, Keyboard, KEYS_ANY, TouchPad, type PadState } from './input.ts';
import { Renderer } from './renderer.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { showMatchEnd, showPauseMenu, showSettings, showTitle } from './menus.ts';
import { drawState, showEvents, type ViewOptions } from './view.ts';
import { startOnline } from './online.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const renderer = new Renderer(canvas);
const NAMES: [string, string] = ['あなた', 'CPU'];
let settings: Settings = loadSettings();

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
  ctrl: Controller;
  paused = false;
  acc = 0;
  last = performance.now();
  raf = 0;
  ended = false;
  view: ViewOptions;

  constructor(readonly rules: Rules) {
    this.s = createGame({ rules, seed: (Date.now() & 0x7fffffff) >>> 0, humans: [true, false] });
    renderer.view = 0;
    this.view = { humanTeam: 0 };
    this.hud = new Hud(ui, { names: NAMES, mainTeam: 0, onPause: () => this.pause() });
    this.ctrl = new Controller(0, new TouchPad(ui), new Keyboard(KEYS_ANY));
    this.ctrl.pad.setVisible(settings.showPad);
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
      retry: () => restart(this.rules),
      title: () => goTitle(),
      changed: (st) => {
        settings = st;
        saveSettings(st);
        this.ctrl.pad.setVisible(st.showPad);
        this.hud.debugOn = st.debug;
      },
    });
  }

  /** n tick 進める（テスト・デバッグ用にも使う） */
  tick(n = 1): GameEvent[] {
    const all: GameEvent[] = [];
    for (let i = 0; i < n; i++) {
      this.ctrl.apply(this.s);
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
    this.ctrl.pad.setLabel(ACTION_LABEL[actions[this.ctrl.team]]);
    if (this.s.phase === 'matchEnd' && !this.ended) {
      this.ended = true;
      showMatchEnd(ui, this.s, NAMES, { retry: () => restart(this.rules), title: () => goTitle() });
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.hud.destroy();
    this.ctrl.pad.destroy();
  }
}

let session: { destroy(): void } | null = null;

function clearUI(): void {
  session?.destroy();
  session = null;
  ui.innerHTML = '';
}

function restart(rules: Rules): void {
  clearUI();
  session = new LocalSession(rules);
}

function goTitle(): void {
  clearUI();
  renderer.view = 0;
  showTitle(ui, {
    cpu: () => restart(settings.rules),
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
    renderer.setMarker(null);
    renderer.updateCamera(dt, s0.ball.pos.z);
    renderer.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// URL で直接CPU対戦を始められる（?mode=cpu）
const q = new URLSearchParams(location.search);
if (q.get('mode') === 'cpu') restart(settings.rules);
else goTitle();
