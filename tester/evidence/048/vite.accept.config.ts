import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';

// 验收车道临时构建配置（只在 /tmp；不改仓库文件）：
//  - root = 仓库 web/（用其 index.html / src / postcss 配置）
//  - alias klinecharts → /tmp/accept/kc-spy.ts（暴露 window.__CHARTS__）
//  - outDir = /tmp/accept/dist
export default defineConfig({
  root: REPO_WEB,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/accept/kc-spy.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: {
    outDir: '/tmp/accept/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
