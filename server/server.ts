// オンライン対戦サーバーの起動。npm run server
// dist（npm run build の出力）があれば画面も配るので、このポートだけで遊べる
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NET } from '../shared/constants.ts';
import { startServer } from './rooms.ts';

const port = Number(process.env.PORT) || NET.port;
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const staticDir = existsSync(dist) ? dist : undefined;

// 確認用の人工的な遅延：FAKE_LAG_MS=150（往復）、FAKE_JITTER_MS=20（片道のゆらぎ）
const fakeLagMs = Number(process.env.FAKE_LAG_MS) || 0;
const fakeJitterMs = Number(process.env.FAKE_JITTER_MS) || 0;

await startServer({ port, staticDir, fakeLagMs, fakeJitterMs });
if (fakeLagMs || fakeJitterMs) console.log(`人工的な遅延：往復 ${fakeLagMs}ms、ゆらぎ 片道0〜${fakeJitterMs}ms`);

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);
console.log(`サーバー起動：ポート ${port}（WebSocket ${NET.path}）`);
if (staticDir) for (const ip of lan) console.log(`  画面：http://${ip}:${port}/`);
else console.log('  dist が無いので画面は配りません。npm run dev の画面からつないでください');
