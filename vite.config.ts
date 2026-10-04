import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'client',
  server: {
    host: true, // 同じWi-Fiのスマホから開けるようにする
    port: 5173,
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
