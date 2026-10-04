// CPU同士の試合をヘッドレスで回して統計を出す（調整用）
import { createGame, step } from '../shared/game.ts';
import type { GameState } from '../shared/types.ts';

export function simulate(seed: number, rules = {}, maxTicks = 60 * 60 * 60) {
  const s: GameState = createGame({ seed, humans: [false, false], rules });
  const stats = { contacts: {} as Record<string, number>, judges: {} as Record<string, number>, points: {} as Record<string, number>, blocks: 0, nets: 0, rallies: 0, maxRally: 0 };
  let rally = 0;
  while (s.phase !== 'matchEnd' && s.tick < maxTicks) {
    step(s);
    for (const e of s.events) {
      if (e.type === 'contact') { stats.contacts[e.info.kind] = (stats.contacts[e.info.kind] ?? 0) + 1; rally++; }
      if (e.type === 'judge') stats.judges[e.judgment] = (stats.judges[e.judgment] ?? 0) + 1;
      if (e.type === 'point') { stats.points[e.reason] = (stats.points[e.reason] ?? 0) + 1; stats.rallies++; stats.maxRally = Math.max(stats.maxRally, rally); rally = 0; }
      if (e.type === 'block') stats.blocks++;
      if (e.type === 'net') stats.nets++;
    }
  }
  return { s, stats };
}

if (process.argv[1]?.endsWith('sim.ts')) {
  const { s, stats } = simulate(Number(process.argv[2] ?? 1));
  console.log('phase', s.phase, 'tick', s.tick, 'min', (s.tick / 3600).toFixed(1), 'sets', s.setScores, 'score', s.teams.map((t) => t.score));
  console.log(JSON.stringify(stats, null, 1));
}
