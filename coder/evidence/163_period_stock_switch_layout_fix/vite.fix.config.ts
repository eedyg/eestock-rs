import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 阶段 2（修复）临时构建/预览：只在 /tmp，不改仓库任何文件；/api /ws 只读代理线上 8081。
const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
export default defineConfig({
  root: REPO_WEB,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/fix2/kc-spy.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: { outDir: '/tmp/fix2/dist', emptyOutDir: true, sourcemap: false },
  preview: {
    port: 18098,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8081', ws: true, changeOrigin: true },
    },
  },
});
