// 見た目だけのエフェクト（打った瞬間の光と破片、速い球の軌跡、床の衝撃、画面の揺れ）。ゲームのロジックには影響しない
import * as THREE from 'three';
import { BALL_RADIUS } from '../shared/constants.ts';
import type { Vec3 } from '../shared/vec.ts';

/** 調整値 */
export const FX = {
  burstCount: 22, // 打った瞬間に飛び散る粒の数（強さ1のとき）
  burstSpeed: 5.5, // 粒の速さ(m/s)（強さ1のとき）
  burstLife: 0.45, // 粒が消えるまでの秒数
  flashLife: 0.16, // 光が消えるまでの秒数
  ringLife: 0.55, // 床の輪が広がって消えるまでの秒数
  trailLength: 14, // 軌跡に残す点の数
  trailMinSpeed: 12, // これより速い球だけ軌跡を出す(m/s)
  shakeDecay: 9, // 揺れが収まる速さ
  maxActive: 40, // 同時に出すエフェクトの上限（スマホで重くならないように）
};

export const FX_COLORS = {
  perfect: 0xffe14d,
  good: 0xffffff,
  bad: 0xff9b4a,
  touch: 0x7fd8ff,
  stuff: 0xff5a5a,
  dust: 0xf3d2a8,
};

interface Live {
  obj: THREE.Object3D;
  age: number;
  life: number;
  update(k: number, dt: number): void;
  dispose(): void;
}

export class Effects {
  private live: Live[] = [];
  private trail: THREE.Mesh[] = [];
  private trailPos: THREE.Vector3[] = [];
  private trailOn = false;
  private shakeAmp = 0;
  private dotGeo = new THREE.CircleGeometry(1, 12);
  private flashGeo = new THREE.SphereGeometry(1, 12, 8);
  private last = performance.now();

  constructor(private scene: THREE.Scene) {
    // 軌跡は小さな円を並べて、古いほど小さく薄くする
    for (let i = 0; i < FX.trailLength; i++) {
      const m = new THREE.Mesh(
        this.dotGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.visible = false;
      scene.add(m);
      this.trail.push(m);
    }
  }

  /** 打った瞬間：光と、飛び散る粒。strength は 0〜1 くらい */
  hit(pos: Vec3, color: number, strength: number): void {
    this.flash(pos, color, 0.45 + 0.55 * strength);
    this.burst(pos, color, strength);
  }

  /** 光（すぐ大きくなって消える球） */
  flash(pos: Vec3, color: number, size: number): void {
    if (this.live.length >= FX.maxActive) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(this.flashGeo, mat);
    m.position.set(pos.x, pos.y, pos.z);
    this.add(m, FX.flashLife, (k) => {
      m.scale.setScalar(size * (0.4 + 0.8 * k));
      mat.opacity = 0.9 * (1 - k);
    }, () => mat.dispose());
  }

  /** 飛び散る粒 */
  burst(pos: Vec3, color: number, strength: number, up = 0.4): void {
    if (this.live.length >= FX.maxActive) return;
    const n = Math.max(6, Math.round(FX.burstCount * strength));
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    const v: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      p.set([pos.x, pos.y, pos.z], i * 3);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5 + up, Math.random() - 0.5).normalize();
      v.push(d.multiplyScalar(FX.burstSpeed * (0.4 + 0.6 * Math.random()) * (0.5 + 0.5 * strength)));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.2, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    this.add(pts, FX.burstLife, (k, dt) => {
      const a = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < n; i++) {
        v[i].y -= 9 * dt;
        a.setXYZ(i, a.getX(i) + v[i].x * dt, Math.max(0.02, a.getY(i) + v[i].y * dt), a.getZ(i) + v[i].z * dt);
      }
      a.needsUpdate = true;
      mat.opacity = 1 - k;
    }, () => {
      geo.dispose();
      mat.dispose();
    });
  }

  /** 床の衝撃：広がる輪と砂ぼこり。strength は 0〜1 くらい */
  impact(x: number, z: number, color: number, strength: number): void {
    if (this.live.length >= FX.maxActive) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03, z);
    const size = 0.5 + 1.3 * strength;
    this.add(ring, FX.ringLife, (k) => {
      ring.scale.setScalar(size * (0.3 + 0.7 * Math.sqrt(k)));
      mat.opacity = 0.8 * (1 - k);
    }, () => {
      ring.geometry.dispose();
      mat.dispose();
    });
    this.burst({ x, y: BALL_RADIUS, z }, FX_COLORS.dust, 0.3 + 0.5 * strength, 1.2);
  }

  /** 画面を少し揺らす（amp は揺れ幅 m） */
  shake(amp: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  }

  /** 速い球の軌跡を出し始める・止める */
  setTrail(on: boolean): void {
    this.trailOn = on;
    if (!on) this.trailPos.length = 0;
  }

  /** ボールの位置を軌跡に足す（毎フレーム） */
  trackBall(pos: Vec3, speed: number): void {
    if (!this.trailOn || speed < FX.trailMinSpeed) {
      this.trailPos.length = 0;
      return;
    }
    this.trailPos.unshift(new THREE.Vector3(pos.x, pos.y, pos.z));
    if (this.trailPos.length > FX.trailLength) this.trailPos.length = FX.trailLength;
  }

  /** 毎フレーム呼ぶ。camera はカメラ（軌跡の円をカメラに向ける・揺らす） */
  update(camera: THREE.Camera): void {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.age += dt;
      const k = Math.min(e.age / e.life, 1);
      e.update(k, dt);
      if (k >= 1) {
        this.scene.remove(e.obj);
        e.dispose();
        this.live.splice(i, 1);
      }
    }
    const r = BALL_RADIUS * 1.7;
    for (let i = 0; i < this.trail.length; i++) {
      const m = this.trail[i];
      const p = this.trailPos[i + 1]; // 0番はボールそのものの位置なので、その後ろから
      m.visible = !!p;
      if (!p) continue;
      const k = 1 - i / FX.trailLength;
      m.position.copy(p);
      m.quaternion.copy(camera.quaternion);
      m.scale.setScalar(r * (0.35 + 0.65 * k));
      (m.material as THREE.MeshBasicMaterial).opacity = 0.45 * k;
    }
    if (this.shakeAmp > 0.002) {
      camera.position.x += (Math.random() - 0.5) * 2 * this.shakeAmp;
      camera.position.y += (Math.random() - 0.5) * 2 * this.shakeAmp;
      this.shakeAmp *= Math.exp(-FX.shakeDecay * dt);
    } else this.shakeAmp = 0;
  }

  private add(obj: THREE.Object3D, life: number, update: (k: number, dt: number) => void, dispose: () => void): void {
    this.scene.add(obj);
    this.live.push({ obj, age: 0, life, update, dispose });
    update(0, 0);
  }
}
