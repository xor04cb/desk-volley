// 状態を画面に描く処理（ローカル対戦とオンライン対戦で共通）
import { aimPoint, ballComingTo, chargeOf, opponentAttacking, tossAimTarget, tossPoint } from '../shared/actions.ts';
import { roleOf } from '../shared/court.ts';
import { currentAction, timeToContact } from '../shared/game.ts';
import type { ActionKind, ContactInfo, GameEvent, GameState, Player, TeamId } from '../shared/types.ts';
import { FX_COLORS } from './effects.ts';
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
  // スパイク（空中）・サーブ（トスの後）の狙いのコース。スティックで動く
  r.setShotAim(aimPoint(s, T));

  if (s.phase === 'matchEnd') {
    r.setMarker(null);
    hud.setNameTag(null);
  } else {
    const charge = team.pressTick >= 0 ? chargeOf(team.pressTick, s.tick, actions[T]) : -1;
    const timing = s.phase === 'rally' || s.phase === 'serve' ? timeToContact(s, T) : -1;
    r.setMarker({ player: p.id, name: p.name, charge, timing }, p);
    const sp = r.project(p.x, 0, p.z);
    const role = roleOf(s, p);
    hud.setNameTag(sp.visible ? (role ? `${p.name} ${role}` : p.name) : null, sp.x, sp.y);
  }
  landingFx(r, s);
  r.updateCamera();
  r.render();
  hud.update(s, actions);
  return actions;
}

/** イベントに応じたポップアップ（判定の文字など） */
export function showEvents(r: Renderer, hud: Hud, s: GameState, events: GameEvent[], o: ViewOptions): void {
  for (const e of events) {
    // 打球に合わせてボールを回す（見た目だけ）
    if (e.type === 'contact') {
      r.spinBall(e.info.kind, s.ball.vel, e.info.charge);
      contactFx(r, s, e.info);
    } else if (e.type === 'net') {
      r.spinBall('net', s.ball.vel);
      r.fx.burst(s.ball.pos, 0xffffff, 0.3);
      r.fx.setTrail(false);
    } else if (e.type === 'point' && e.reason === 'in' && s.lastContact?.kind === 'spike' && s.lastContact.team === e.team) {
      r.fx.shake(0.15); // スパイクが決まった
    } else if (e.type === 'block') {
      r.spinBall('block', s.ball.vel);
      r.fx.hit(s.ball.pos, e.touch ? FX_COLORS.touch : FX_COLORS.stuff, e.touch ? 0.5 : 0.9);
      r.fx.setTrail(!e.touch);
      if (!e.touch) r.fx.shake(0.12);
      // ブロックに当たったことを、ボールの位置に出す（ワンタッチ＝ブロック側のボール、跳ね返し＝打った側のボール）
      const sp = r.project(s.ball.pos.x, s.ball.pos.y + 0.6, s.ball.pos.z);
      hud.popText(e.touch ? 'ワンタッチ' : 'ブロック！', e.touch ? 'touch' : 'stuff', sp.x, sp.y);
    }
    if (e.type === 'judge') {
      const p = s.players[e.player];
      const sp = r.project(p.x, p.y + 2.3, p.z);
      // 人の判定は大きく、CPUの判定は表示しない（調整用にデバッグ表示時のみ）
      const note = e.judgment === 'MISS' ? undefined : e.dive ? 'フライング！' : e.underhand ? 'アンダー' : e.direct ? 'ダイレクト' : undefined;
      if (e.team === o.humanTeam || hud.debugOn) hud.popJudgment(e.judgment, sp.x, sp.y, note);
    }
  }
  hud.handleEvents(s, events);
}

/** 打った瞬間のエフェクト：判定の色の光と粒。強く打つほど大きい。スパイク・サーブは軌跡を出す */
function contactFx(r: Renderer, s: GameState, c: ContactInfo): void {
  const color = c.judgment === 'PERFECT' ? FX_COLORS.perfect : c.judgment === 'GOOD' ? FX_COLORS.good : FX_COLORS.bad;
  const fast = (lo: number, hi: number) => Math.min(Math.max((c.speed - lo) / (hi - lo), 0), 1);
  const strength =
    c.kind === 'spike' ? 0.5 + 0.5 * fast(9, 20) : c.kind === 'serve' ? 0.3 + 0.6 * fast(10, 24) : c.kind === 'toss' || c.kind === 'feint' ? 0.2 : 0.3;
  r.fx.hit(s.ball.pos, color, strength);
  r.fx.setTrail(c.kind === 'spike' || c.kind === 'serve');
  if (c.kind === 'spike' && strength > 0.85) r.fx.shake(0.06); // 強打
}

/** 床に落ちた瞬間のエフェクト（落ちたことはイベントが無いので、landTick の変化で見る） */
const lastLand = new WeakMap<Renderer, number>();
function landingFx(r: Renderer, s: GameState): void {
  if (s.landTick < 0 || lastLand.get(r) === s.landTick) return;
  lastLand.set(r, s.landTick);
  const k = s.lastContact?.kind;
  r.fx.impact(s.landX, s.landZ, 0xffffff, k === 'spike' ? 1 : k === 'serve' ? 0.7 : 0.35);
  r.fx.setTrail(false);
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
  const hit = contactPose(s, p);
  if (hit) return hit;
  if (lowStance(s, p)) return 'low';
  return 'idle';
}

/** カット・トスの姿勢を見せる長さ：触る前（ボールが来る少し前から構える）と触った後 */
const CONTACT_POSE_BEFORE = 0.35; // 秒
const CONTACT_POSE_AFTER_TICKS = 18; // 0.3秒

/** カット・レシーブ・返球なら 'pass'、トスなら 'set'。ボールを触る直前と直後だけ */
function contactPose(s: GameState, p: Player): Pose | null {
  const c = s.lastContact;
  if (c && c.player === p.id && s.tick - c.tick < CONTACT_POSE_AFTER_TICKS) {
    if (c.kind === 'receive' || c.kind === 'free') return 'pass';
    if (c.kind === 'toss') return c.underhand ? 'pass' : 'set'; // アンダーのトスはカットと同じ形
  }
  if (s.phase !== 'rally' || s.teams[p.team].controlled !== p.id) return null;
  const action = currentAction(s, p.team);
  if (action !== 'receive' && action !== 'free' && action !== 'toss') return null;
  const t = timeToContact(s, p.team);
  if (t < 0 || t > CONTACT_POSE_BEFORE) return null;
  return action === 'toss' && !tossPoint(s, p.team, p)?.underhand ? 'set' : 'pass';
}

/**
 * 低く構える場面か。
 * ディグ：相手がトスを上げてから、相手のスパイク・フェイント（相手のブロックで跳ね返ったボールも）を自チームが触るまで、全員。
 * ブロックフォロー：自チームがトスを上げてから、スパイクを相手が触るまで、打つ人以外。
 */
function lowStance(s: GameState, p: Player): boolean {
  if (s.phase !== 'rally' || p.y > 0) return false;
  const T = p.team;
  const k = s.lastContactKind;
  const ours = s.lastTouchTeam === T;
  // ディグ
  if (opponentAttacking(s, T)) return true;
  if (!ours && (k === 'spike' || k === 'feint' || k === 'block') && ballComingTo(s, T)) return true;
  // ブロックフォロー
  if (ours && (k === 'toss' || k === 'spike' || k === 'feint') && (k !== 'toss' || s.teams[T].contactsLeft === 1)) {
    const hitter = k === 'toss' ? s.tossTarget : s.teams[T].lastToucher;
    return p.id !== hitter;
  }
  return false;
}
