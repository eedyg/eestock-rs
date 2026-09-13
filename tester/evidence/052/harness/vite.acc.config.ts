import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 阶段 3 独立验收：临时构建/临时预览，只在 /tmp，不改仓库任何文件（含线上 web/dist）。
//  - root = 仓库 web/（现工作树，含未提交修复）
//  - alias klinecharts → /tmp/acc3/kc-spy.ts（透传真身 + 暴露 window.__ACC__ + 变异开关）
//  - 预览端口 18093（临时），/api、/ws 代理到线上实例 8081（浏览器侧只发 GET；PUT 由 Playwright 本地兑现）
const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const ROOT = process.env.ACC_ROOT ?? REPO_WEB;
const OUT = process.env.ACC_OUT ?? '/tmp/acc3/dist';
const PORT = Number(process.env.ACC_PORT ?? 18093);

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
