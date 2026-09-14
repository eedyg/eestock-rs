import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const ROOT = process.env.ACC_ROOT ?? REPO_WEB;
const OUT = process.env.ACC_OUT ?? '/tmp/acc3/dist-a';
const PORT = Number(process.env.ACC_PORT ?? 18091);
export default defineConfig({
  root: ROOT,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/acc3/kc-spy.ts' },
      { find: '@', replacement: path.resolve(ROOT, 'src') },
    ],
  },
  build: { outDir: OUT, emptyOutDir: true, sourcemap: false },
  preview: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8081', ws: true, changeOrigin: true },
    },
  },
});
