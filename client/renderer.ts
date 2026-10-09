// Three.js による描画。ゲームの状態を受け取って表示するだけで、ロジックは持たない。
import * as THREE from 'three';
import {
  ATTACK_LINE,
  BALL_RADIUS,
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  LANDING_MARK_RADIUS,
  NET_HEIGHT,
  NET_POST_OFFSET,
  PLAYER_HEIGHT,
} from '../shared/constants.ts';
import type { ContactKind } from '../shared/types.ts';
import type { Vec3 } from '../shared/vec.ts';

/** 見た目だけの調整値 */
export const VIEW = {
  ballScale: 1.7, // スマホで見やすいようにボールを大きく描く
  playerScale: 1.0,
  fov: 50,
  camHeight: 14,
  camBack: 17.5, // ネットからの距離
  lookAhead: -1.5, // 高いボール（6m）が奥のコートの上でも上のHUDに隠れにくい向き
  camZ: 4.5, // カメラの前後位置（固定。ボールは追わない）。自チームのサーバーが操作ボタンに隠れず、相手コートの奥まで見える位置
};

const COLORS = {
  desk: 0x6b4a2f,
  court: 0xd9894a,
  free: 0x3a7a8c,
  line: 0xffffff,
  net: 0x111111,
  netTop: 0xf4f4f4,
  post: 0xcccccc,
  // ボールのパネル（3本1組を [外側, 中央] の色で塗る。面の組ごとに入れ替える）。黄と青の定番配色（ロゴは入れない）
  ballPanels: [
    ['#f5c400', '#0b4aa2'],
    ['#0b4aa2', '#f5c400'],
    ['#f5c400', '#0b4aa2'],
  ],
  ballSeam: 'rgba(40, 32, 24, 0.55)',
  landing: 0xff5a2a,
  team: [0x2f6fdb, 0xd94141],
  teamDark: [0x1d3f80, 0x7a2222],
  skin: 0xf2c49b,
  marker: 0x3ddc6a,
  tossAim: 0xffd23a,
  shotAim: 0x4dfcff,
  chargeArcs: [0x3a8bff, 0xff4040, 0xffd23a],
  timing: 0xffffff,
};

const UP = new THREE.Vector3(0, 1, 0);

/** ボールの回転の速さ（rad/s）。見た目だけ */
const BALL_SPIN = {
  spike: 32, // 強い順回転（1秒に約5回転）
  float: 0.8, // 無回転サーブ（ほとんど回らない）
  toss: 1.5, // トスはほぼ無回転
  under: 9, // フェイント・返球の逆回転
  receive: 10, // レシーブ・ブロックの不規則な回転
  decay: 0.25, // 空気で弱まる割合（1秒あたり）
};

/**
 * バレーボール：立方体を球に膨らませ、各面を3本のパネルに分ける（6組×3本＝18枚）。
 * 向かい合う面の組ごとにパネルの向きを直交させ、本物と同じ組み方にする。
 */
function makeVolleyball(radius: number): THREE.Mesh {
  const N = 12; // 1面の分割数
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const geo = new THREE.BufferGeometry();
  // [面の法線, パネルが並ぶ向き(v), もう一方(u)]。v の向きを組ごとに変える
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), 0],
    [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), 0],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), 1],
    [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), 1],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), 2],
    [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), 2],
  ];
  const p = new THREE.Vector3();
  for (const [n, v, u, mat] of faces) {
    const base = pos.length / 3;
    const start = index.length;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const a = -1 + (2 * i) / N;
        const b = -1 + (2 * j) / N;
        p.copy(n).addScaledVector(u, a).addScaledVector(v, b).normalize().multiplyScalar(radius);
        pos.push(p.x, p.y, p.z);
        uv.push(i / N, j / N);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = base + j * (N + 1) + i;
        // 外向きの面になるよう、u×v が法線と同じ向きかで並びを変える
        const ccw = new THREE.Vector3().crossVectors(u, v).dot(n) > 0;
        if (ccw) index.push(k, k + 1, k + N + 2, k, k + N + 2, k + N + 1);
        else index.push(k, k + N + 2, k + 1, k, k + N + 1, k + N + 2);
      }
    }
    geo.addGroup(start, index.length - start, mat);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mats = COLORS.ballPanels.map(([o, c]) => new THREE.MeshStandardMaterial({ map: panelTexture(o, c), roughness: 0.55, metalness: 0 }));
  return new THREE.Mesh(geo, mats);
}

/** 1面ぶんのテクスチャ：外側・中央・外側の3本のパネルと縫い目 */
function panelTexture(outer: string, center: string): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const bands = [outer, center, outer];
  for (let k = 0; k < 3; k++) {
    g.fillStyle = bands[k];
    g.fillRect(0, (k * S) / 3, S, S / 3 + 1);
  }
  g.strokeStyle = COLORS.ballSeam;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, S / 3);
  g.lineTo(S, S / 3);
  g.moveTo(0, (2 * S) / 3);
  g.lineTo(S, (2 * S) / 3);
  g.stroke();
  g.lineWidth = 4; // 面と面の境目
  g.strokeRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface PlayerView {
  id: number;
  team: 0 | 1;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  pose: Pose;
}

/** 選手の姿勢。idle=通常、low=低い構え（ディグ・ブロックフォロー）、block=ブロック、spikeReady=スパイク・サーブの振りかぶり、spikeSwing=その振り下ろし、dive=フライング */
export type Pose = 'idle' | 'low' | 'block' | 'spikeReady' | 'spikeSwing' | 'dive';

const POSE_EASE = 14; // 姿勢を切り替える速さ（1秒あたり。大きいほど速く切り替わる）

const SWING_TIME = 0.15; // 秒。振り下ろし・飛び込みの速さ

const TURN_RATE = 12; // 向きを変える速さ（1秒あたり。大きいほど速く向く）

/** 前の姿勢から素早くつなぐ姿勢（つなぎ元） */
const BLEND_FROM: Partial<Record<Pose, Pose>> = { spikeSwing: 'spikeReady', dive: 'idle' };

/**
 * 姿勢の値。lx/rx=左右の腕の前後の角度（負で前、π付近で真上、正で後ろ）、
 * lz/rz=腕を横に開く角度（外向きが+）、lean=体の前傾（+で前）、twist=体のひねり（+で右肩を引く）、
 * crouch=しゃがむ量（脚の長さを縮める割合。0=立つ）
 */
interface PoseValues {
  lx: number;
  rx: number;
  lz: number;
  rz: number;
  lean: number;
  twist: number;
  crouch: number;
}
const PI = Math.PI;
const POSES: Record<Pose, PoseValues> = {
  idle: { lx: -0.15, rx: -0.15, lz: 0, rz: 0, lean: 0, twist: 0, crouch: 0 },
  // 腰を落とし、両腕を前下に出して少し開く（ディグ・ブロックフォロー）
  low: { lx: -0.75, rx: -0.75, lz: 0.28, rz: 0.28, lean: 0.38, twist: 0, crouch: 0.38 },
  // 両腕をまっすぐ上に伸ばして少し開く
  block: { lx: -PI * 0.98, rx: -PI * 0.98, lz: 0.16, rz: 0.16, lean: 0.05, twist: 0, crouch: 0 },
  // 左腕でボールを指し、右腕は真横から頭の後ろへ引き上げる（後ろからのカメラでも分かるように横に張る）。体は反る
  spikeReady: { lx: -PI * 0.8, rx: -PI * 0.25, lz: 0.05, rz: 2.6, lean: -0.2, twist: 0.25, crouch: 0 },
  // 右腕を体の左下まで振り切り、体を前に倒す
  spikeSwing: { lx: -0.1, rx: -0.5, lz: 0.2, rz: -0.9, lean: 0.3, twist: -0.25, crouch: 0 },
  // 前へ飛び込んで床に体を伸ばし、両腕をボールの方へ伸ばす
  dive: { lx: -PI * 0.9, rx: -PI * 0.9, lz: 0.08, rz: 0.08, lean: 1.4, twist: 0, crouch: 0 },
};
const POSE_KEYS = Object.keys(POSES.idle) as (keyof PoseValues)[];

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
  /** 脚（しゃがむと縮む）と、脚より上（しゃがむと下がる） */
  legs: THREE.Mesh[] = [];
  upper = new THREE.Group();
  legH: number;
  pose: Pose = 'idle';
  poseStart = 0;
  /** 今表示している姿勢（目標の姿勢へなめらかに近づける） */
  cur: PoseValues = { ...POSES.idle };
  lastTime = performance.now() / 1000;
  /** 向きを一度でも決めたか（最初はなめらかにせずそのまま向ける） */
  faced = false;
  constructor(team: 0 | 1) {
    const s = VIEW.playerScale;
    const H = PLAYER_HEIGHT * s;
    const mat = new THREE.MeshLambertMaterial({ color: COLORS.team[team] });
    const dark = new THREE.MeshLambertMaterial({ color: COLORS.teamDark[team] });
    const skin = new THREE.MeshLambertMaterial({ color: COLORS.skin });
    this.body = new THREE.Group();
    this.body.rotation.order = 'YXZ'; // 向きを変えてから前後に傾ける
    const legH = H * 0.42;
    this.legH = legH;
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17 * s, legH, 0.2 * s), dark);
      leg.position.set(sx * 0.12 * s, legH / 2, 0);
      this.body.add(leg);
      this.legs.push(leg);
    }
    const torsoH = H * 0.36;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5 * s, torsoH, 0.3 * s), mat);
    torso.position.y = legH + torsoH / 2;
    this.upper.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.3 * s), skin);
    head.position.y = legH + torsoH + 0.17 * s;
    this.upper.add(head);
    const armGeo = new THREE.BoxGeometry(0.12 * s, 0.62 * s, 0.14 * s);
    armGeo.translate(0, -0.28 * s, 0); // 肩を回転の中心にする
    this.armL = new THREE.Mesh(armGeo, skin);
    this.armR = new THREE.Mesh(armGeo, skin);
    const shoulderY = legH + torsoH - 0.05;
    this.armL.position.set(-0.32 * s, shoulderY, 0);
    this.armR.position.set(0.32 * s, shoulderY, 0);
    this.upper.add(this.armL, this.armR);
    this.body.add(this.upper);
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
  private ball: THREE.Mesh;
  /** ボールの角速度（rad/s、ワールド座標の軸） */
  private ballSpin = new THREE.Vector3();
  private lastBallTime = performance.now();
  private ballShadow: THREE.Mesh;
  private landing: THREE.Mesh;
  private arrow: THREE.Mesh;
  private players = new Map<number, PlayerMesh>();
  private marker: { ring: THREE.Mesh; arcs: THREE.Mesh[]; timing: THREE.Mesh; lastCharge: number };
  private tossAim: THREE.Mesh;
  private shotAim: THREE.Group;
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

    const r = BALL_RADIUS * VIEW.ballScale;
    this.ball = makeVolleyball(r);
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.1, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);

    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(LANDING_MARK_RADIUS - 0.2, LANDING_MARK_RADIUS, 32),
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

    // トスを上げる相手の足元の印（押している間だけ）
    this.tossAim = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.62, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.tossAim, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.tossAim.rotation.x = -Math.PI / 2;
    this.tossAim.visible = false;
    this.scene.add(this.tossAim);

    // スパイク・サーブの狙いの印（輪＋十字）
    this.shotAim = new THREE.Group();
    const aimMat = new THREE.MeshBasicMaterial({ color: COLORS.shotAim, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.82, 32), aimMat);
    const barH = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.16), aimMat);
    const barV = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 2.0), aimMat);
    for (const m of [ring, barH, barV]) this.shotAim.add(m);
    this.shotAim.rotation.x = -Math.PI / 2;
    this.shotAim.visible = false;
    this.scene.add(this.shotAim);

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

  /**
   * 打球の種類に合わせてボールの回転を決める（見た目だけ。物理には影響しない）。
   * vel は打った直後の速度。
   */
  spinBall(kind: ContactKind | 'block' | 'net', vel: Vec3, charge = 0): void {
    const dir = new THREE.Vector3(vel.x, 0, vel.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    // 順回転（ボールの上側が進む向きへ回る）の軸
    const top = new THREE.Vector3().crossVectors(UP, dir);
    const randomAxis = () => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    switch (kind) {
      case 'spike':
        this.ballSpin.copy(top).multiplyScalar(BALL_SPIN.spike * (0.7 + 0.3 * charge));
        break;
      case 'serve':
        // 溜めが少ないと無回転（揺れる程度）、溜めるほどドライブ回転
        if (charge < 0.5) this.ballSpin.copy(randomAxis()).multiplyScalar(BALL_SPIN.float);
        else this.ballSpin.copy(top).multiplyScalar(BALL_SPIN.spike * charge);
        break;
      case 'toss':
        this.ballSpin.copy(randomAxis()).multiplyScalar(BALL_SPIN.toss);
        break;
      case 'feint':
      case 'free':
        this.ballSpin.copy(top).multiplyScalar(-BALL_SPIN.under); // 逆回転
        break;
      case 'net':
        this.ballSpin.multiplyScalar(0.3);
        break;
      default:
        // レシーブ・ブロック：腕に当たって不規則に回る
        this.ballSpin.copy(randomAxis()).multiplyScalar(BALL_SPIN.receive * (0.6 + 0.8 * Math.random()));
    }
  }

  setBall(pos: Vec3, visible = true, vel?: Vec3): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastBallTime) / 1000, 0.05);
    this.lastBallTime = now;
    this.ball.visible = visible;
    this.ballShadow.visible = visible;
    this.ball.position.set(pos.x, pos.y, pos.z);
    const drawR = BALL_RADIUS * VIEW.ballScale;
    if (vel && pos.y <= BALL_RADIUS + 0.03) {
      // 床の上：転がる回転
      this.ballSpin.crossVectors(UP, new THREE.Vector3(vel.x, 0, vel.z)).multiplyScalar(1 / drawR);
    }
    this.ballSpin.multiplyScalar(Math.exp(-BALL_SPIN.decay * dt)); // 空気で少しずつ弱まる
    const w = this.ballSpin.length();
    if (w > 1e-4 && dt > 0) {
      this.ball.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(this.ballSpin.clone().divideScalar(w), w * dt));
    }
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
      const shadow = m.group.getObjectByName('shadow')!;
      const sc = Math.max(0.5, 1 - pv.y * 0.4);
      shadow.scale.set(sc, sc, sc);
      const now = performance.now() / 1000;
      // 向きは一瞬で変えず、なめらかに回す（初回はそのまま）
      const yaw = Math.atan2(pv.fx, pv.fz);
      if (!m.faced) {
        m.body.rotation.y = yaw;
        m.faced = true;
      } else {
        const turn = Math.atan2(Math.sin(yaw - m.body.rotation.y), Math.cos(yaw - m.body.rotation.y));
        m.body.rotation.y += turn * (1 - Math.exp(-TURN_RATE * Math.min(now - m.lastTime, 0.1)));
      }
      if (pv.pose !== m.pose) {
        m.pose = pv.pose;
        m.poseStart = now;
      }
      const from = BLEND_FROM[pv.pose];
      const target = POSES[pv.pose];
      const frameDt = Math.min(now - m.lastTime, 0.1);
      m.lastTime = now;
      if (from) {
        // 振りかぶり→振り下ろし、立った姿勢→飛び込みは決まった時間で素早くつなぐ
        const k = Math.min((now - m.poseStart) / SWING_TIME, 1);
        const a = POSES[from];
        const e = 1 - (1 - k) * (1 - k);
        for (const key of POSE_KEYS) m.cur[key] = a[key] + (target[key] - a[key]) * e;
      } else {
        // それ以外（構える・立つなど）はなめらかに近づける
        const k = 1 - Math.exp(-POSE_EASE * frameDt);
        for (const key of POSE_KEYS) m.cur[key] += (target[key] - m.cur[key]) * k;
      }
      const ps = m.cur;
      m.armL.rotation.set(ps.lx, 0, -ps.lz);
      m.armR.rotation.set(ps.rx, 0, ps.rz);
      m.body.rotation.x = ps.lean;
      m.body.rotation.y += ps.twist;
      // しゃがむ：脚を縮め、上半身をその分下げる
      for (const leg of m.legs) {
        leg.scale.y = 1 - ps.crouch;
        leg.position.y = (m.legH * (1 - ps.crouch)) / 2;
      }
      m.upper.position.y = -m.legH * ps.crouch;
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

  /** スパイク・サーブの狙いの印（相手コート上の十字）。null で消す */
  setShotAim(pos: { x: number; z: number } | null): void {
    this.shotAim.visible = !!pos;
    if (!pos) return;
    this.shotAim.position.set(pos.x, 0.026, pos.z);
  }

  /** トスを上げる相手の印。null で消す */
  setTossAim(pos: { x: number; z: number } | null): void {
    this.tossAim.visible = !!pos;
    if (!pos) return;
    const pulse = 1 + 0.1 * Math.sin(performance.now() / 90);
    this.tossAim.position.set(pos.x, 0.024, pos.z);
    this.tossAim.scale.set(pulse, pulse, pulse);
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

  /** カメラは固定（ボールを追うと見づらいため） */
  updateCamera(): void {
    const dir = this.view === 0 ? 1 : -1;
    this.camera.position.set(0, VIEW.camHeight, dir * (VIEW.camZ + VIEW.camBack));
    this.camera.lookAt(0, 0, dir * (VIEW.camZ + VIEW.lookAhead));
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }
}
