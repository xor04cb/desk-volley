// Three.js による描画。ゲームの状態を受け取って表示するだけで、ロジックは持たない。
import * as THREE from 'three';
import {
  ATTACK_LINE,
  BALL_RADIUS,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  NET_HEIGHT,
  NET_POST_OFFSET,
  PLAYER_HEIGHT,
} from '../shared/constants.ts';
import type { Vec3 } from '../shared/vec.ts';

/** 見た目だけの調整値 */
export const VIEW = {
  ballScale: 1.7, // スマホで見やすいようにボールを大きく描く
  playerScale: 1.0,
  fov: 50,
  camHeight: 14,
  camBack: 17.5, // ネットからの距離
  lookAhead: -3,
  followFactor: 0.3, // ボールの前後をどれだけ追うか
  followSmooth: 3,
  serveCamZ: 6.5, // 自チームのサーブ中のカメラ位置（サーバーが画面下の操作ボタンに隠れないように）
};

const COLORS = {
  desk: 0x6b4a2f,
  court: 0xd9894a,
  free: 0x3a7a8c,
  line: 0xffffff,
  net: 0x111111,
  netTop: 0xf4f4f4,
  post: 0xcccccc,
  ball: 0xffd23a,
  ballStripe: 0x2a5fd6,
  landing: 0xff5a2a,
  team: [0x2f6fdb, 0xd94141],
  teamDark: [0x1d3f80, 0x7a2222],
  skin: 0xf2c49b,
  marker: 0x3ddc6a,
  chargeArcs: [0x3a8bff, 0xff4040, 0xffd23a],
  timing: 0xffffff,
};

export interface PlayerView {
  id: number;
  team: 0 | 1;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  /** 腕を上げる（ジャンプ中など） */
  armsUp: boolean;
}

export interface MarkerView {
  /** 操作中の選手のid（-1=なし） */
  player: number;
  name: string;
  /** 押している間の溜め量（-1=押していない） */
  charge: number;
  /** ボールが打点に来るまでの秒数（-1=表示しない） */
  timing: number;
}

class PlayerMesh {
  group = new THREE.Group();
  body: THREE.Group;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  constructor(team: 0 | 1) {
    const s = VIEW.playerScale;
    const H = PLAYER_HEIGHT * s;
    const mat = new THREE.MeshLambertMaterial({ color: COLORS.team[team] });
    const dark = new THREE.MeshLambertMaterial({ color: COLORS.teamDark[team] });
    const skin = new THREE.MeshLambertMaterial({ color: COLORS.skin });
    this.body = new THREE.Group();
    const legH = H * 0.42;
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17 * s, legH, 0.2 * s), dark);
      leg.position.set(sx * 0.12 * s, legH / 2, 0);
      this.body.add(leg);
    }
    const torsoH = H * 0.36;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, torsoH, 0.3 * s), mat);
    torso.position.y = legH + torsoH / 2;
    this.body.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.3 * s), skin);
    head.position.y = legH + torsoH + 0.17 * s;
    this.body.add(head);
    const armGeo = new THREE.BoxGeometry(0.12 * s, 0.62 * s, 0.14 * s);
    armGeo.translate(0, -0.28 * s, 0); // 肩を回転の中心にする
    this.armL = new THREE.Mesh(armGeo, skin);
    this.armR = new THREE.Mesh(armGeo, skin);
    const shoulderY = legH + torsoH - 0.05;
    this.armL.position.set(-0.32 * s, shoulderY, 0);
    this.armR.position.set(0.32 * s, shoulderY, 0);
    this.body.add(this.armL, this.armR);
    this.group.add(this.body);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.35, 16),
      new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    shadow.name = 'shadow';
    this.group.add(shadow);
  }
}

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private gl: THREE.WebGLRenderer;
  private ball: THREE.Group;
  private ballShadow: THREE.Mesh;
  private landing: THREE.Mesh;
  private arrow: THREE.Mesh;
  private players = new Map<number, PlayerMesh>();
  private marker: { ring: THREE.Mesh; arcs: THREE.Mesh[]; timing: THREE.Mesh; lastCharge: number };
  private camZ = 0;
  /** 視点。0=チーム0の後ろから、1=チーム1の後ろから */
  view: 0 | 1 = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x1b1410);
    this.camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.1, 200);

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2a1a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(4, 12, 6);
    this.scene.add(sun);

    this.buildCourt();

    this.ball = new THREE.Group();
    const r = BALL_RADIUS * VIEW.ballScale;
    const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), new THREE.MeshLambertMaterial({ color: COLORS.ball }));
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.0, r * 0.18, 6, 24),
      new THREE.MeshLambertMaterial({ color: COLORS.ballStripe }),
    );
    stripe.rotation.x = Math.PI / 2.6;
    this.ball.add(ballMesh, stripe);
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.1, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);

    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.5, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.landing, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.landing.rotation.x = -Math.PI / 2;
    this.landing.visible = false;
    this.scene.add(this.landing);

    // 操作選手から落下予測地点へ向かう矢印（平たい三角）
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.35);
    arrowShape.lineTo(-0.22, -0.1);
    arrowShape.lineTo(0.22, -0.1);
    arrowShape.closePath();
    this.arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape),
      new THREE.MeshBasicMaterial({ color: COLORS.landing, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.arrow.visible = false;
    this.scene.add(this.arrow);

    this.marker = this.makeMarker();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private makeMarker() {
    const flat = (geo: THREE.BufferGeometry, color: number, opacity: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    const ring = flat(new THREE.RingGeometry(0.5, 0.6, 32), COLORS.marker, 0.95);
    const arcs = COLORS.chargeArcs.map((c) => flat(new THREE.RingGeometry(0.64, 0.8, 8, 1, 0, 0.01), c, 0.95));
    const timing = flat(new THREE.RingGeometry(0.95, 1.0, 40), COLORS.timing, 0.8);
    return { ring, arcs, timing, lastCharge: -2 };
  }

  private buildCourt(): void {
    const W = COURT_HALF_WIDTH;
    const L = COURT_HALF_LENGTH;
    const flat = (w: number, d: number, color: number, y: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ color }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = y;
      this.scene.add(m);
      return m;
    };
    const desk = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 9, 0.8, L * 2 + 12), new THREE.MeshLambertMaterial({ color: COLORS.desk }));
    desk.position.y = -0.41;
    this.scene.add(desk);
    flat(W * 2 + 5, L * 2 + 7, COLORS.free, 0.0);
    flat(W * 2, L * 2, COLORS.court, 0.005);

    const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.line });
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, z);
      this.scene.add(m);
    };
    const t = 0.06;
    line(-W, 0, t, L * 2 + t);
    line(W, 0, t, L * 2 + t);
    line(0, -L, W * 2 + t, t);
    line(0, L, W * 2 + t, t);
    line(0, 0, W * 2 + t, t);
    line(0, ATTACK_LINE, W * 2, t);
    line(0, -ATTACK_LINE, W * 2, t);

    const netW = (W + NET_POST_OFFSET) * 2;
    const netMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(netW, 1.0),
      new THREE.MeshBasicMaterial({ color: COLORS.net, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    );
    netMesh.position.set(0, NET_HEIGHT - 0.5, 0);
    this.scene.add(netMesh);
    const top = new THREE.Mesh(new THREE.BoxGeometry(netW, 0.07, 0.03), new THREE.MeshLambertMaterial({ color: COLORS.netTop }));
    top.position.set(0, NET_HEIGHT - 0.035, 0);
    this.scene.add(top);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, NET_HEIGHT + 0.2, 10),
        new THREE.MeshLambertMaterial({ color: COLORS.post }),
      );
      post.position.set(s * (W + NET_POST_OFFSET), (NET_HEIGHT + 0.2) / 2, 0);
      this.scene.add(post);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 6), new THREE.MeshBasicMaterial({ color: 0xff3355 }));
      ant.position.set(s * W, NET_HEIGHT - 1 + 0.9, 0);
      this.scene.add(ant);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w > h ? VIEW.fov * 0.75 : VIEW.fov;
    this.camera.updateProjectionMatrix();
  }

  setBall(pos: Vec3, visible = true): void {
    this.ball.visible = visible;
    this.ballShadow.visible = visible;
    this.ball.position.set(pos.x, pos.y, pos.z);
    this.ball.rotation.x += 0.15;
    this.ball.rotation.z += 0.07;
    this.ballShadow.position.set(pos.x, 0.015, pos.z);
    const s = Math.max(0.4, 1 - pos.y * 0.08);
    this.ballShadow.scale.set(s, s, s);
  }

  setPlayers(list: PlayerView[]): void {
    for (const pv of list) {
      let m = this.players.get(pv.id);
      if (!m) {
        m = new PlayerMesh(pv.team);
        this.players.set(pv.id, m);
        this.scene.add(m.group);
      }
      m.group.position.set(pv.x, 0, pv.z);
      m.body.position.y = pv.y;
      m.body.rotation.y = Math.atan2(pv.fx, pv.fz);
      const shadow = m.group.getObjectByName('shadow')!;
      const sc = Math.max(0.5, 1 - pv.y * 0.4);
      shadow.scale.set(sc, sc, sc);
      const a = pv.armsUp ? Math.PI * 0.95 : 0.15;
      m.armL.rotation.x = -a;
      m.armR.rotation.x = -a;
    }
  }

  /** 落下予測地点と、そこへ向かう矢印 */
  setLanding(x: number, z: number, visible: boolean, from?: { x: number; z: number }): void {
    this.landing.visible = visible;
    this.landing.position.set(x, 0.02, z);
    const pulse = 1 + 0.08 * Math.sin(performance.now() / 120);
    this.landing.scale.set(pulse, pulse, pulse);
    if (visible && from) {
      const dx = x - from.x;
      const dz = z - from.z;
      const d = Math.hypot(dx, dz);
      this.arrow.visible = d > 1.0;
      if (this.arrow.visible) {
        // 選手から 0.9m 先に、目標の方向を向けて置く
        this.arrow.position.set(from.x + (dx / d) * 0.95, 0.03, from.z + (dz / d) * 0.95);
        this.arrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-dx, -dz));
      }
    } else this.arrow.visible = false;
  }

  /** 足元のマーカー（操作中の囲み、溜めの弧、タイミングリング） */
  setMarker(mv: MarkerView | null, pos?: { x: number; z: number }): void {
    const mk = this.marker;
    const show = !!mv && mv.player >= 0 && !!pos;
    mk.ring.visible = show;
    mk.timing.visible = false;
    for (const a of mk.arcs) a.visible = false;
    if (!show || !mv || !pos) return;
    mk.ring.position.set(pos.x, 0.025, pos.z);
    if (mv.charge >= 0) {
      if (Math.abs(mv.charge - mk.lastCharge) > 0.005) {
        mk.lastCharge = mv.charge;
        // 3色の弧：0〜1/3 青、1/3〜2/3 赤、2/3〜1 黄
        for (let k = 0; k < 3; k++) {
          const part = Math.min(Math.max(mv.charge * 3 - k, 0), 1);
          mk.arcs[k].geometry.dispose();
          const start = Math.PI / 2 - (k * 2 * Math.PI) / 3;
          mk.arcs[k].geometry = new THREE.RingGeometry(0.64, 0.8, 16, 1, start - part * ((2 * Math.PI) / 3), Math.max(part * ((2 * Math.PI) / 3), 0.0001));
        }
      }
      for (const a of mk.arcs) {
        a.visible = true;
        a.position.set(pos.x, 0.03, pos.z);
      }
    }
    if (mv.timing >= 0 && mv.timing < 1.2) {
      // ボールが打点に来る時刻に、外側のリングが内側の囲みにぴったり重なる
      const r = 0.6 + mv.timing * 2.2;
      mk.timing.visible = true;
      mk.timing.position.set(pos.x, 0.028, pos.z);
      mk.timing.scale.set(r, r, r);
      (mk.timing.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.6 * (1 - mv.timing / 1.2);
    }
  }

  /** ワールド座標 → 画面座標（CSSピクセル） */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight, visible: v.z < 1 };
  }

  /** serving：視点側のチームのサーブ中。サーバーが操作ボタンに隠れないようにカメラを後ろへ引く */
  updateCamera(dt: number, focusZ: number, serving = false): void {
    const k = 1 - Math.exp(-VIEW.followSmooth * dt);
    const dir = this.view === 0 ? 1 : -1;
    const target = serving ? dir * VIEW.serveCamZ : focusZ * VIEW.followFactor;
    this.camZ += (target - this.camZ) * k;
    this.camera.position.set(0, VIEW.camHeight, this.camZ + dir * VIEW.camBack);
    this.camera.lookAt(0, 0, this.camZ + dir * VIEW.lookAhead);
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }
}
