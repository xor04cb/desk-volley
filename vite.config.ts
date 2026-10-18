import { defineConfig } from 'vitest/config';
import { NET } from './shared/constants.ts';

export default defineConfig({
  root: 'client',
  base: './', // GitHub Pages（/desk-volley/ 配下）でも動くように相対パスで出力する
  server: {
    host: true, // 同じWi-Fiのスマホから開けるようにする
    port: 5173,
    // オンライン対戦：npm run server へつなぐ。スマホも同じURL（5173）のままでよい
    proxy: { [NET.path]: { target: `ws://localhost:${NET.port}`, ws: true } },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
  },
});
