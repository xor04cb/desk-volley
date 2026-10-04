// Three.js による描画。ゲームの状態を受け取って表示するだけで、ロジックは持たない。
import * as THREE from 'three';
import {
  ATTACK_LINE,
  BALL_RADIUS,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  NET_HEIGHT,
  NET_POST_OFFSET,
} from '../shared/constants.ts';
import type { Vec3 } from '../shared/vec.ts';

/** 見た目だけの調整値 */
export const VIEW = {
  ballScale: 1.7, // スマホで見やすいようにボールを大きく描く
  fov: 50,
  camHeight: 12.5,
  camBack: 16.5, // 手前エンドラインからの距離
  lookAhead: -2.5,
  followFactor: 0.28, // ボールの前後をどれだけ追うか
  followSmooth: 4, // 追従のなめらかさ
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
};

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private gl: THREE.WebGLRenderer;
  private ball: THREE.Group;
  private ballShadow: THREE.Mesh;
  private landing: THREE.Mesh;
  private camZ = 0;
  /** 視点。0=チーム0の後ろから、1=チーム1の後ろから、'top'=真上（同一端末2人用） */
  view: 0 | 1 | 'top' = 0;

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
    const ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 14),
      new THREE.MeshLambertMaterial({ color: COLORS.ball }),
    );
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
      new THREE.RingGeometry(0.35, 0.55, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.landing, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.landing.rotation.x = -Math.PI / 2;
    this.landing.visible = false;
    this.scene.add(this.landing);

    this.resize();
    window.addEventListener('resize', () => this.resize());
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
    // 机（天板と脚の代わりに厚み）
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(W * 2 + 9, 0.8, L * 2 + 12),
      new THREE.MeshLambertMaterial({ color: COLORS.desk }),
    );
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

    // ネット
    const netW = (W + NET_POST_OFFSET) * 2;
    const netMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(netW, 1.0),
      new THREE.MeshBasicMaterial({ color: COLORS.net, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
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
      // アンテナ（サイドライン上）
      const ant = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 1.8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3355 }),
      );
      ant.position.set(s * W, NET_HEIGHT - 1 + 0.9, 0);
      this.scene.add(ant);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 横長画面では縦の視野を少し狭めて大きく見せる
    this.camera.fov = w > h ? VIEW.fov * 0.8 : VIEW.fov;
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

  setLanding(x: number, z: number, visible: boolean): void {
    this.landing.visible = visible;
    this.landing.position.set(x, 0.02, z);
  }

  /** カメラを更新する。focusZ はボールの奥行き */
  updateCamera(dt: number, focusZ: number): void {
    const k = 1 - Math.exp(-VIEW.followSmooth * dt);
    if (this.view === 'top') {
      this.camera.position.set(0, 27, 0.01);
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(0, 0, 0);
      return;
    }
    const dir = this.view === 0 ? 1 : -1;
    const target = focusZ * VIEW.followFactor;
    this.camZ += (target - this.camZ) * k;
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(0, VIEW.camHeight, this.camZ + dir * VIEW.camBack);
    this.camera.lookAt(0, 0, this.camZ + dir * VIEW.lookAhead);
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }
}
