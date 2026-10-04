// 入力：左下の仮想スティック＋右下のACTIONボタン、またはキーボード
export interface PadState {
  /** 右が+ */
  mx: number;
  /** 画面の上（ネット方向）が+ */
  mf: number;
  held: boolean;
}

const STICK_RADIUS = 52; // px

/** タッチ操作パッド */
export class TouchPad {
  readonly el: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private button: HTMLDivElement;
  private label: HTMLSpanElement;
  private stickId = -1;
  private ox = 0;
  private oy = 0;
  private mx = 0;
  private mf = 0;
  private buttonIds = new Set<number>();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pad';
    const zone = document.createElement('div');
    zone.className = 'stick-zone';
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'stick-base';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'stick-knob';
    this.stickBase.appendChild(this.stickKnob);
    zone.appendChild(this.stickBase);
    this.button = document.createElement('div');
    this.button.className = 'action-btn';
    this.label = document.createElement('span');
    this.label.textContent = 'ACTION';
    this.button.appendChild(this.label);
    this.el.append(zone, this.button);
    parent.appendChild(this.el);

    zone.addEventListener('pointerdown', (e) => {
      if (this.stickId >= 0) return;
      e.preventDefault();
      capture(zone, e.pointerId);
      this.stickId = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      const r = zone.getBoundingClientRect();
      // スティックは触った位置に出す（フローティング）
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      this.stickBase.style.left = `${lx}px`;
      this.stickBase.style.top = `${ly}px`;
      this.stickBase.classList.add('active');
      this.update(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.update(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.mx = 0;
      this.mf = 0;
      this.stickKnob.style.transform = '';
      this.stickBase.classList.remove('active');
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    this.button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(this.button, e.pointerId);
      this.buttonIds.add(e.pointerId);
      this.button.classList.add('down');
    });
    const bend = (e: PointerEvent) => {
      this.buttonIds.delete(e.pointerId);
      if (this.buttonIds.size === 0) this.button.classList.remove('down');
    };
    this.button.addEventListener('pointerup', bend);
    this.button.addEventListener('pointercancel', bend);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private update(cx: number, cy: number): void {
    let dx = cx - this.ox;
    let dy = cy - this.oy;
    const d = Math.hypot(dx, dy);
    const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    dx *= k;
    dy *= k;
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    // 小さな遊びを入れる
    const n = Math.hypot(dx, dy) / STICK_RADIUS;
    if (n < 0.12) {
      this.mx = 0;
      this.mf = 0;
    } else {
      this.mx = dx / STICK_RADIUS;
      this.mf = -dy / STICK_RADIUS;
    }
  }

  setLabel(text: string): void {
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('ghost', !v);
  }

  state(): PadState {
    return { mx: this.mx, mf: this.mf, held: this.buttonIds.size > 0 };
  }

  destroy(): void {
    this.el.remove();
  }
}

export interface KeyMap {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  action: string[];
}

export const KEYS_ANY: KeyMap = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  action: ['Space', 'KeyJ', 'KeyZ', 'Enter'],
};

const down = new Set<string>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    down.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());
}

export class Keyboard {
  constructor(private map: KeyMap) {
    listen();
  }
  state(): PadState {
    const any = (keys: string[]) => keys.some((k) => down.has(k));
    let mx = (any(this.map.right) ? 1 : 0) - (any(this.map.left) ? 1 : 0);
    let mf = (any(this.map.up) ? 1 : 0) - (any(this.map.down) ? 1 : 0);
    if (mx && mf) {
      mx *= Math.SQRT1_2;
      mf *= Math.SQRT1_2;
    }
    return { mx, mf, held: any(this.map.action) };
  }
}

/** タッチとキーボードを合わせる */
export function combine(a: PadState, b: PadState): PadState {
  const useA = Math.hypot(a.mx, a.mf) >= Math.hypot(b.mx, b.mf);
  return { mx: useA ? a.mx : b.mx, mf: useA ? a.mf : b.mf, held: a.held || b.held };
}

function capture(el: HTMLElement, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // ポインタが既に離れている場合などは無視する
  }
}
