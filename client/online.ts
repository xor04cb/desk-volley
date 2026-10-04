// オンライン対戦（フェーズ8で実装）
import type { Renderer } from './renderer.ts';
import type { Settings } from './settings.ts';

export function startOnline(ui: HTMLElement, _r: Renderer, _settings: Settings, back: () => void): { destroy(): void } {
  const box = document.createElement('div');
  box.className = 'menu';
  box.innerHTML = '<h2>オンライン対戦</h2><p>準備中です</p>';
  const b = document.createElement('button');
  b.className = 'btn wide';
  b.textContent = 'もどる';
  b.onclick = back;
  box.appendChild(b);
  ui.appendChild(box);
  return { destroy: () => box.remove() };
}
