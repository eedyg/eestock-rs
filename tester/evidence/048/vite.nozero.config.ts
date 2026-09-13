import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';

// 反向证据构建（问题②）：DCAP figures 去掉 zero（/tmp 副本），其余同验收构建。
export default defineConfig({
  root: REPO_WEB,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/accept/kc-spy.ts' },
      { find: /^@\/features\/indicators\/dcapIndicator$/, replacement: '/tmp/accept/dcapIndicator-nozero.ts' },
      { find: /^\.\/dcapIndicator$/, replacement: '/tmp/accept/dcapIndicator-nozero.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: { outDir: '/tmp/accept/dist-nozero', emptyOutDir: true, sourcemap: false },
});
