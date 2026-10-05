// タイトル・設定・一時停止・試合終了の画面
import type { GameState, PracticeKind, Rules, TossZone } from '../shared/types.ts';
import type { Settings } from './settings.ts';

function panel(ui: HTMLElement, cls = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = `menu ${cls}`;
  ui.appendChild(d);
  return d;
}

function button(parent: HTMLElement, text: string, onClick: () => void, cls = 'btn wide'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.onclick = onClick;
  parent.appendChild(b);
  return b;
}

export function showTitle(ui: HTMLElement, h: { cpu: () => void; practice: () => void; online: () => void; settings: () => void }): void {
  const p = panel(ui, 'title');
  p.innerHTML = '<h1>卓上バレー</h1><p class="sub">ACTIONボタンひとつで<br>レシーブ・トス・スパイク</p>';
  button(p, 'CPUと対戦', h.cpu, 'btn wide primary');
  button(p, '練習', h.practice);
  button(p, 'オンライン対戦', h.online);
  button(p, 'ルール設定', h.settings, 'btn wide ghost');
  const help = document.createElement('p');
  help.className = 'help';
  help.innerHTML = '左下：スティックで移動　右下：ACTION<br>長押しで溜め、ボールが来た瞬間に離す<br>PC：WASD/矢印キー＋スペース';
  p.appendChild(help);
}

function stepper(parent: HTMLElement, label: string, value: number, min: number, max: number, onChange: (v: number) => void, unit = ''): void {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span>${label}</span>`;
  const box = document.createElement('div');
  box.className = 'stepper';
  const out = document.createElement('b');
  const set = (v: number) => {
    value = Math.max(min, Math.min(max, v));
    out.textContent = `${value}${unit}`;
    onChange(value);
  };
  button(box, '−', () => set(value - 1), 'btn small');
  box.appendChild(out);
  button(box, '＋', () => set(value + 1), 'btn small');
  set(value);
  row.appendChild(box);
  parent.appendChild(row);
}

function choice<T extends string | number | boolean>(parent: HTMLElement, label: string, value: T, options: [T, string][], onChange: (v: T) => void): void {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span>${label}</span>`;
  const box = document.createElement('div');
  box.className = 'seg';
  const btns: HTMLButtonElement[] = [];
  for (const [v, text] of options) {
    const b = button(
      box,
      text,
      () => {
        btns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(v);
      },
      'btn small' + (v === value ? ' on' : ''),
    );
    btns.push(b);
  }
  row.appendChild(box);
  parent.appendChild(row);
}

export function showSettings(ui: HTMLElement, rules: Rules, done: (r: Rules) => void): void {
  ui.querySelectorAll('.menu').forEach((m) => m.remove());
  const r = { ...rules };
  const p = panel(ui, 'settings');
  p.innerHTML = '<h2>ルール設定</h2>';
  stepper(p, '1セットの点数', r.pointsPerSet, 5, 25, (v) => (r.pointsPerSet = v), '点');
  choice(p, 'セット数', r.sets, [[1, '1'], [3, '3'], [5, '5']], (v) => (r.sets = v));
  stepper(p, '最終セットの点数', r.finalSetPoints, 5, 25, (v) => (r.finalSetPoints = v), '点');
  choice(p, 'デュース', r.deuce, [[true, 'あり'], [false, 'なし']], (v) => (r.deuce = v));
  choice(p, 'フェイント', r.feint, [[true, 'ON'], [false, 'OFF']], (v) => (r.feint = v));
  stepper(p, 'サーブ制限時間', r.serveTime, 3, 30, (v) => (r.serveTime = v), '秒');
  const h3 = document.createElement('h3');
  h3.textContent = '陣形（両チーム共通）';
  p.appendChild(h3);
  choice(p, 'ローテシステム', r.system, [['5-1', '5-1'], ['4-2', '4-2'], ['6-2', '6-2'], ['none', 'なし']], (v) => (r.system = v));
  choice(p, 'サーブレシーブ', r.receive, [['W', 'W型5人'], ['four', '4人'], ['three', '3人']], (v) => (r.receive = v));
  choice(p, '守備', r.defense, [['perimeter', 'ペリメーター'], ['rotation', 'ローテーション']], (v) => (r.defense = v));
  const note = document.createElement('p');
  note.className = 'help';
  note.textContent =
    'セット数3は2セット先取、5は3セット先取。最終セットの点数はセット数3・5のときに使います。人数は6人です。' +
    'ローテシステム：S=セッター、OH=アウトサイド、MB=ミドル、OP=オポジット。サーブの後は得意な位置へ入れ替わります。' +
    '「なし」は役割なし（ローテーションの位置のまま）で、サーブレシーブ・守備の選択は使いません。';
  p.appendChild(note);
  button(p, '決定', () => done(r), 'btn wide primary');
}

export const PRACTICE_LABEL: Record<PracticeKind, string> = {
  serveCut: 'サーブカット',
  serveCutSpike: 'サーブカット→スパイク',
  spikeReceive: 'スパイクレシーブ',
  spike: 'スパイク',
  serve: 'サーブ',
};

const PRACTICE_HELP: Record<PracticeKind, string> = {
  serveCut: '相手のサーブをカットする',
  serveCutSpike: 'カットすると味方がトスを上げる。跳んで打つ',
  spikeReceive: '相手のスパイク・フェイントを拾う',
  spike: '味方のトスを跳んで打つ',
  serve: '自分のサーブを打ち続ける',
};

/** 練習メニュー：種類とトスの向きを選ぶ */
export function showPracticeMenu(
  ui: HTMLElement,
  zone: TossZone | 'random',
  h: { start: (kind: PracticeKind, zone: TossZone | 'random') => void; back: () => void },
): void {
  ui.querySelectorAll('.menu').forEach((m) => m.remove());
  const p = panel(ui, 'practice');
  p.innerHTML = '<h2>練習</h2>';
  let z = zone;
  choice<TossZone | 'random'>(p, 'トス', z, [['left', 'レフト'], ['center', 'センター'], ['right', 'ライト'], ['random', 'ランダム']], (v) => (z = v));
  for (const kind of Object.keys(PRACTICE_LABEL) as PracticeKind[]) {
    const b = button(p, PRACTICE_LABEL[kind], () => h.start(kind, z));
    el(b, 'small', PRACTICE_HELP[kind]);
  }
  const note = document.createElement('p');
  note.className = 'help';
  note.textContent = '1本ずつ区切って繰り返します。点数は数えません。トスの向きはスパイクのある練習で使います。';
  p.appendChild(note);
  button(p, 'もどる', h.back, 'btn wide ghost');
}

function el(parent: HTMLElement, tag: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  parent.appendChild(e);
  return e;
}

function setTable(s: GameState): string {
  const rows: string[] = [];
  const n = Math.max(s.rules.sets, 1);
  for (let i = 0; i < n; i++) {
    const sc = s.setScores[i] ?? (i === s.set - 1 && s.winner < 0 ? [s.teams[0].score, s.teams[1].score] : null);
    rows.push(`<tr><th>${i + 1}</th><td class="t0">${sc ? sc[0] : '-'}</td><td class="t1">${sc ? sc[1] : '-'}</td></tr>`);
  }
  return `<table class="sets"><tr><th>SET</th><th class="t0">●</th><th class="t1">●</th></tr>${rows.join('')}</table>`;
}

export function showPauseMenu(
  ui: HTMLElement,
  s: GameState,
  settings: Settings,
  h: { resume: () => void; retry: () => void; title: () => void; changed: (s: Settings) => void; practiceMenu?: () => void },
): void {
  const p = panel(ui, 'pause');
  p.innerHTML = s.practice ? `<h2>一時停止</h2><p class="sub">練習：${PRACTICE_LABEL[s.practice.kind]}</p>` : `<h2>一時停止</h2>${setTable(s)}`;
  const st = { ...settings };
  choice(p, '操作パッド', st.showPad, [[true, 'ON'], [false, 'OFF']], (v) => {
    st.showPad = v;
    h.changed({ ...st });
  });
  choice(p, 'デバッグ表示', st.debug, [[true, 'ON'], [false, 'OFF']], (v) => {
    st.debug = v;
    h.changed({ ...st });
  });
  button(p, '再開', () => {
    p.remove();
    h.resume();
  }, 'btn wide primary');
  if (h.practiceMenu) button(p, '練習を選ぶ', h.practiceMenu);
  else button(p, 'リトライ', h.retry);
  button(p, 'タイトルへ', h.title, 'btn wide ghost');
}

export function showMatchEnd(ui: HTMLElement, s: GameState, names: [string, string], h: { retry: () => void; title: () => void }): void {
  const p = panel(ui, 'end');
  const w = s.winner as 0 | 1;
  p.innerHTML = `<h2 class="t${w}">${names[w]} の勝ち</h2><p class="sub">${s.teams[0].setsWon} - ${s.teams[1].setsWon}</p>${setTable(s)}`;
  button(p, 'もう一度', h.retry, 'btn wide primary');
  button(p, 'タイトルへ', h.title, 'btn wide ghost');
}
