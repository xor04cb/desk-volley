// 状態を画面に描く処理（ローカル対戦とオンライン対戦で共通）
import { currentAction, timeToContact } from '../shared/game.ts';
import type { ActionKind, GameEvent, GameState, TeamId } from '../shared/types.ts';
import type { Hud } from './hud.ts';
import type { Renderer } from './renderer.ts';

export interface ViewOptions {
  /** マーカー・名前を出すチーム（人が操作するチーム） */
  humanTeams: TeamId[];
  /** 上下反転して表示するチーム（同一端末2人の上側） */
  flippedTeam: TeamId | null;
  /** 落下予測円を出すチーム（そのチーム側に落ちるときだけ表示） */
  landingFor: TeamId[];
}

export function drawState(r: Renderer, hud: Hud, s: GameState, o: ViewOptions, dt: number): [ActionKind, ActionKind] {
  r.setBall(s.ball.pos, true);
  r.setPlayers(
    s.players.map((p) => ({
      id: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
      z: p.z,
      fx: p.fx,
      fz: p.fz,
      armsUp: p.jump !== 'none' || (s.phase === 'serve' && p.id === s.server && s.serveTossed),
    })),
  );
  const actions: [ActionKind, ActionKind] = [currentAction(s, 0), currentAction(s, 1)];

  // 落下予測円：人が操作するチーム側に落ちるときに表示
  const showLanding =
    s.ball.mode === 'flying' && !s.ball.grounded && s.predLandTick > s.tick && s.phase === 'rally' &&
    o.landingFor.some((T) => (s.predLandZ >= 0 ? 0 : 1) === T);
  const landTeam = (s.predLandZ >= 0 ? 0 : 1) as TeamId;
  const ctrl = s.players[s.teams[landTeam].controlled];
  r.setLanding(s.predLandX, s.predLandZ, showLanding, showLanding && o.humanTeams.includes(landTeam) ? ctrl : undefined);

  for (let i = 0; i < 2; i++) {
    const T = o.humanTeams[i];
    if (T === undefined || s.phase === 'matchEnd') {
      r.setMarker(i, null);
      hud.setNameTag(i, null);
      continue;
    }
    const team = s.teams[T];
    const p = s.players[team.controlled];
    const charge = team.pressTick >= 0 ? Math.min((s.tick - team.pressTick) / 60 / 0.6, 1) : -1;
    const timing = s.phase === 'rally' || s.phase === 'serve' ? timeToContact(s, T) : -1;
    r.setMarker(i, { player: p.id, name: p.name, charge, timing }, p);
    const sp = r.project(p.x, 0, p.z);
    hud.setNameTag(i, sp.visible ? p.name : null, sp.x, sp.y, o.flippedTeam === T);
  }
  r.updateCamera(dt, s.ball.pos.z);
  r.render();
  hud.update(s, actions);
  return actions;
}

/** イベントに応じたポップアップ（判定の文字など） */
export function showEvents(r: Renderer, hud: Hud, s: GameState, events: GameEvent[], o: ViewOptions): void {
  for (const e of events) {
    if (e.type === 'judge') {
      const p = s.players[e.player];
      const sp = r.project(p.x, p.y + 2.3, p.z);
      // 人の判定は大きく、CPUの判定は表示しない（調整用にデバッグ表示時のみ）
      if (o.humanTeams.includes(e.team) || hud.debugOn) hud.popJudgment(e.judgment, sp.x, sp.y, o.flippedTeam === e.team);
    }
  }
  hud.handleEvents(s, events);
}
