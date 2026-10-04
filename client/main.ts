// フェーズ1：コート・ネット・ボールの表示と放物線物理のデモ
import { DT, NET_HEIGHT } from '../shared/constants.ts';
import { launch, makeBall, predict, solveByApex, stepBall, type BallEvent } from '../shared/physics.ts';
import { makeRng, randRange } from '../shared/prng.ts';
import { v3 } from '../shared/vec.ts';
import { Renderer } from './renderer.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const r = new Renderer(canvas);
const ball = makeBall();
const rng = makeRng(Date.now());
ball.pos = v3(0, 1, 6);

const log = document.createElement('div');
log.style.cssText = 'position:absolute;top:10px;left:10px;font-size:13px;background:rgba(0,0,0,.45);padding:6px 8px;border-radius:8px;white-space:pre';
ui.appendChild(log);
const bar = document.createElement('div');
bar.style.cssText = 'position:absolute;bottom:20px;left:0;right:0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap';
ui.appendChild(bar);

let lastEvent = '';
function shoot(kind: 'over' | 'net' | 'random') {
  const from = v3(randRange(rng, -3, 3), 1.0, randRange(rng, 5, 8));
  let vel;
  if (kind === 'over') vel = solveByApex(from, randRange(rng, -4, 4), randRange(rng, -8, -2), randRange(rng, 4, 7));
  else if (kind === 'net') vel = solveByApex(from, randRange(rng, -3, 3), -4, NET_HEIGHT - 0.6, NET_HEIGHT - 0.6);
  else vel = solveByApex(from, randRange(rng, -6, 6), randRange(rng, -10, 4), randRange(rng, 2, 8));
  launch(ball, from, vel);
  lastEvent = '';
}
for (const [label, kind] of [['越える', 'over'], ['ネットに当てる', 'net'], ['ランダム', 'random']] as const) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  b.onclick = () => shoot(kind);
  bar.appendChild(b);
}

const events: BallEvent[] = [];
function tick() {
  events.length = 0;
  stepBall(ball, events);
  for (const e of events) {
    if (e.type === 'net') lastEvent = 'ネットに当たった';
    if (e.type === 'cross') lastEvent = `ネットを越えた${e.outside ? '（アンテナの外）' : ''}`;
    if (e.type === 'land') lastEvent += ` → 接地 (${e.x.toFixed(2)}, ${e.z.toFixed(2)})`;
  }
}
// デバッグ用：コンソールから任意tick進める
(window as unknown as { __dv: object }).__dv = { step: (n: number) => { for (let i = 0; i < n; i++) tick(); }, shoot, ball };
let acc = 0;
let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  acc += dt;
  while (acc >= DT) {
    tick();
    acc -= DT;
  }
  const p = ball.mode === 'flying' && !ball.grounded ? predict(ball) : null;
  r.setLanding(p?.landX ?? 0, p?.landZ ?? 0, !!p && p.landTicks > 0);
  r.setBall(ball.pos);
  r.updateCamera(dt, ball.pos.z);
  r.render();
  log.textContent =
    `状態: ${ball.mode}\n位置: (${ball.pos.x.toFixed(2)}, ${ball.pos.y.toFixed(2)}, ${ball.pos.z.toFixed(2)})\n` +
    `速度: (${ball.vel.x.toFixed(2)}, ${ball.vel.y.toFixed(2)}, ${ball.vel.z.toFixed(2)})\n${lastEvent}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
