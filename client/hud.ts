// HUD（得点・セット・残りコンタクト・判定表示・メニュー）。DOMで描く
import { setTarget } from '../shared/game.ts';
import type { ActionKind, ContactInfo, GameEvent, GameState, Judgment, TeamId } from '../shared/types.ts';

export const ACTION_LABEL: Record<ActionKind, string> = {
  serve: 'サーブ',
  receive: 'レシーブ',
  toss: 'トス',
  jump: 'ジャンプ',
  twoJump: 'ツー',
  spike: 'スパイク',
  free: '返球',
  block: 'ブロック',
  none: 'ACTION',
};

const KIND_LABEL: Record<string, string> = {
  serve: 'サーブ',
  receive: 'レシーブ',
  toss: 'トス',
  spike: 'スパイク',
  feint: 'フェイント',
  free: '返球',
  block: 'ブロック',
};

const REASON_LABEL: Record<string, string> = {
  in: '',
  out: 'ボールアウト',
  antenna: 'アンテナの外',
  serveMiss: 'サーブミス',
  fault: '反則',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export interface HudOptions {
  names: [string, string];
  /** 残りコンタクトなどを表示するチーム（この端末の人） */
  mainTeam: TeamId;
  onPause: () => void;
}

export class Hud {
  readonly root: HTMLDivElement;
  private score: HTMLDivElement;
  private s0: HTMLSpanElement;
  private s1: HTMLSpanElement;
  private setLabel: HTMLDivElement;
  private contacts: HTMLDivElement;
  private serveTimer: HTMLDivElement;
  private nameTag: HTMLDivElement;
  private debug: HTMLPreElement;
  private banner: HTMLDivElement;
  private bannerUntil = 0;
  debugOn = false;

  constructor(parent: HTMLElement, private opts: HudOptions) {
    this.root = el('div', 'hud', parent);
    const top = el('div', 'hud-top', this.root);
    const pause = el('button', 'hud-pause', top, 'Ⅱ');
    pause.setAttribute('aria-label', '一時停止');
    pause.onclick = () => opts.onPause();
    this.score = el('div', 'hud-score', top);
    el('span', 'team-name t0', this.score, opts.names[0]);
    this.s0 = el('span', 'pts', this.score, '0');
    el('span', 'dash', this.score, '-');
    this.s1 = el('span', 'pts', this.score, '0');
    el('span', 'team-name t1', this.score, opts.names[1]);
    this.setLabel = el('div', 'hud-set', top, 'SET 1');

    this.contacts = el('div', 'hud-contacts', this.root);
    this.serveTimer = el('div', 'hud-serve', this.root);
    this.nameTag = el('div', 'name-tag', this.root);
    this.debug = el('pre', 'hud-debug', this.root);
    this.banner = el('div', 'hud-banner', this.root);
  }

  update(s: GameState, actions: [ActionKind, ActionKind]): void {
    this.s0.textContent = String(s.teams[0].score);
    this.s1.textContent = String(s.teams[1].score);
    this.setLabel.textContent = `SET ${s.set}`;
    s.servingTeam === 0 ? this.score.classList.add('serve0') : this.score.classList.remove('serve0');
    s.servingTeam === 1 ? this.score.classList.add('serve1') : this.score.classList.remove('serve1');

    const T = this.opts.mainTeam;
    const n = s.phase === 'rally' && s.teams[T].contactsLeft > 0 && actions[T] !== 'none' && actions[T] !== 'block' ? s.teams[T].contactsLeft : 0;
    this.contacts.style.visibility = n > 0 ? 'visible' : 'hidden';
    const html = `<small>残りコンタクト</small><b>${n}</b>`;
    if (this.contacts.innerHTML !== html) this.contacts.innerHTML = html;

    const humanServe = s.phase === 'serve' && s.teams[s.servingTeam].human && !s.serveTossed;
    this.serveTimer.style.visibility = humanServe ? 'visible' : 'hidden';
    if (humanServe) {
      const left = Math.max(0, s.rules.serveTime - (s.tick - s.phaseTick) / 60);
      this.serveTimer.textContent = `サーブ ${left.toFixed(1)}`;
    }

    if (performance.now() > this.bannerUntil) this.banner.classList.remove('show');

    this.debug.style.display = this.debugOn ? 'block' : 'none';
    if (this.debugOn) this.debug.textContent = debugText(s, this.opts.mainTeam, actions);
  }

  /** 操作中の選手の名前を足元に出す */
  setNameTag(name: string | null, x = 0, y = 0): void {
    const t = this.nameTag;
    if (!name) {
      t.style.display = 'none';
      return;
    }
    t.style.display = 'block';
    if (t.textContent !== name) t.textContent = name;
    t.style.transform = `translate(${x}px, ${y}px) translate(-50%, 30%)`;
  }

  /** note：判定の下に小さく出す補足（「フライング！」など） */
  popJudgment(j: Judgment, x: number, y: number, note?: string): void {
    const p = el('div', `judge ${j.toLowerCase()}`, this.root, j);
    if (note) el('small', 'judge-note', p, note);
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    setTimeout(() => p.remove(), 900);
  }

  showBanner(html: string, ms: number): void {
    this.banner.innerHTML = html;
    this.banner.classList.add('show');
    this.bannerUntil = performance.now() + ms;
  }

  handleEvents(s: GameState, events: GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'point') {
        const reason = REASON_LABEL[e.reason];
        const name = this.opts.names[e.team];
        this.showBanner(
          `${reason ? `<div class="reason">${reason}</div>` : ''}<div class="who">${name} の得点</div>` +
            `<div class="big"><span class="t0">${s.teams[0].score}</span> - <span class="t1">${s.teams[1].score}</span></div>`,
          1600,
        );
      } else if (e.type === 'setEnd' && s.winner < 0) {
        const last = s.setScores[s.setScores.length - 1];
        this.showBanner(`<div class="who">SET ${e.set} 終了</div><div class="big">${last[0]} - ${last[1]}</div><div class="reason">${this.opts.names[e.winner]} が取りました</div>`, 1700);
      }
    }
  }

  destroy(): void {
    this.root.remove();
  }
}

function debugText(s: GameState, T: TeamId, actions: [ActionKind, ActionKind]): string {
  const team = s.teams[T];
  const p = s.players[team.controlled];
  const hold = team.pressTick >= 0 ? Math.min((s.tick - team.pressTick) / 60 / 0.6, 1) : -1;
  const lines = [
    `tick ${s.tick}  phase ${s.phase}  目標 ${setTarget(s)}点`,
    `操作: ${p.name}  動作: ${ACTION_LABEL[actions[T]]}  残り ${team.contactsLeft}`,
    `溜め: ${hold >= 0 ? hold.toFixed(2) : '-'}`,
  ];
  const c: ContactInfo | null = s.lastContact;
  if (c) {
    lines.push(
      `── 直前の打球 (${s.players[c.player].name}) ──`,
      `${KIND_LABEL[c.kind]}  ${c.judgment}  Δt ${(c.dt * 1000).toFixed(0)}ms`,
      `溜め c=${c.charge.toFixed(2)}  効果=${c.effCharge.toFixed(2)}`,
      `最高点 ${c.apex.toFixed(2)}m  初速 ${c.speed.toFixed(1)}m/s`,
      `ぶれ半径 ${c.scatter.toFixed(2)}m`,
      `狙い (${c.targetX.toFixed(1)}, ${c.targetZ.toFixed(1)}) → 落下 (${c.landX.toFixed(1)}, ${c.landZ.toFixed(1)})`,
    );
  }
  return lines.join('\n');
}
