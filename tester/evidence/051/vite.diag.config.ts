import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';

// 诊断车道临时构建/预览配置（只在 /tmp；不改仓库文件）：
//  - root = 仓库 web/（用其 index.html / src / postcss 配置）
//  - alias klinecharts → /tmp/diag51/kc-spy.ts（暴露 window.__CHARTS__ / __KC_LOG__ / __KC_INITS__）
//  - build.outDir = /tmp/diag51/dist
//  - preview 端口 18085，/api 与 /ws 代理到**线上只读**实例 8081（只发 GET；PUT 由 playwright 在浏览器侧
//    本地兑现，绝不落到后端/DB）
export default defineConfig({
  root: REPO_WEB,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/diag51/kc-spy.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: {
    outDir: '/tmp/diag51/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  preview: {
    port: 18085,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8081', ws: true, changeOrigin: true },
    },
  },
});
