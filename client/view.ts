// 状態を画面に描く処理（ローカル対戦とオンライン対戦で共通）
import { chargeOf, tossAimTarget } from '../shared/actions.ts';
import { currentAction, timeToContact } from '../shared/game.ts';
import type { ActionKind, GameEvent, GameState, Player, TeamId } from '../shared/types.ts';
import type { Hud } from './hud.ts';
import type { Pose, Renderer } from './renderer.ts';

export interface ViewOptions {
  /** この端末の人が操作するチーム（マーカー・名前・落下予測円を出す） */
  humanTeam: TeamId;
}

export function drawState(r: Renderer, hud: Hud, s: GameState, o: ViewOptions): [ActionKind, ActionKind] {
  r.setBall(s.ball.pos, true, s.ball.mode === 'flying' ? s.ball.vel : undefined);
  r.setPlayers(
    s.players.map((p) => ({
      id: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
      z: p.z,
      fx: p.fx,
      fz: p.fz,
      pose: poseOf(s, p),
    })),
  );
  const actions: [ActionKind, ActionKind] = [currentAction(s, 0), currentAction(s, 1)];
  const T = o.humanTeam;
  const team = s.teams[T];
  const p = s.players[team.controlled];

  // 落下予測円：どちらのコートに落ちるときも表示する。矢印は自チーム側に落ちるときだけ
  const showLanding = s.ball.mode === 'flying' && !s.ball.grounded && s.predLandTick > s.tick && s.phase === 'rally';
  const ownSide = (s.predLandZ >= 0 ? 0 : 1) === T;
  r.setLanding(s.predLandX, s.predLandZ, showLanding, showLanding && ownSide ? p : undefined);

  // トスのボタンを押している間は、上げる相手に印を出す（スティックの左右で移る）
  const aim = team.pressTick >= 0 && actions[T] === 'toss' ? s.players[tossAimTarget(s, T).id] : null;
  r.setTossAim(aim);

  if (s.phase === 'matchEnd') {
    r.setMarker(null);
    hud.setNameTag(null);
  } else {
    const charge = team.pressTick >= 0 ? chargeOf(team.pressTick, s.tick, actions[T]) : -1;
    const timing = s.phase === 'rally' || s.phase === 'serve' ? timeToContact(s, T) : -1;
    r.setMarker({ player: p.id, name: p.name, charge, timing }, p);
    const sp = r.project(p.x, 0, p.z);
    hud.setNameTag(sp.visible ? p.name : null, sp.x, sp.y);
  }
  r.updateCamera();
  r.render();
  hud.update(s, actions);
  return actions;
}

/** イベントに応じたポップアップ（判定の文字など） */
export function showEvents(r: Renderer, hud: Hud, s: GameState, events: GameEvent[], o: ViewOptions): void {
  for (const e of events) {
    // 打球に合わせてボールを回す（見た目だけ）
    if (e.type === 'contact') r.spinBall(e.info.kind, s.ball.vel, e.info.charge);
    else if (e.type === 'block') r.spinBall('block', s.ball.vel);
    else if (e.type === 'net') r.spinBall('net', s.ball.vel);
    if (e.type === 'judge') {
      const p = s.players[e.player];
      const sp = r.project(p.x, p.y + 2.3, p.z);
      // 人の判定は大きく、CPUの判定は表示しない（調整用にデバッグ表示時のみ）
      if (e.team === o.humanTeam || hud.debugOn) hud.popJudgment(e.judgment, sp.x, sp.y, e.dive && e.judgment !== 'MISS' ? 'フライング！' : undefined);
    }
  }
  hud.handleEvents(s, events);
}

const SERVE_SWING_TICKS = 24; // サーブを打ったあと振り下ろしの姿勢を見せる長さ（0.4秒）

/** 選手の姿勢（描画用） */
export function poseOf(s: GameState, p: Player): Pose {
  if (p.jump === 'attack') return p.swung ? 'spikeSwing' : 'spikeReady';
  if (p.jump === 'block') return 'block';
  if (p.diveTick >= 0) return 'dive';
  // サーブもスパイクと同じ動き：トスを上げたら振りかぶり、打ったら振り下ろす
  if (s.phase === 'serve' && p.id === s.server && s.serveTossed) return 'spikeReady';
  const c = s.lastContact;
  if (c && c.kind === 'serve' && c.player === p.id && s.tick - c.tick < SERVE_SWING_TICKS) return 'spikeSwing';
  return 'idle';
}
