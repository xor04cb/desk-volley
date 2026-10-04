// 端末ごとの設定（ブラウザに保存）
import { DEFAULT_RULES, type Rules } from '../shared/types.ts';

export interface Settings {
  rules: Rules;
  showPad: boolean;
  debug: boolean;
}

const KEY = 'desk-volley:settings';

export function loadSettings(): Settings {
  const base: Settings = { rules: { ...DEFAULT_RULES }, showPad: true, debug: new URLSearchParams(location.search).has('debug') };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Partial<Settings>;
    return { ...base, ...v, rules: { ...DEFAULT_RULES, ...v.rules }, debug: base.debug || !!v.debug };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できない環境（プライベートモードなど）では何もしない
  }
}
