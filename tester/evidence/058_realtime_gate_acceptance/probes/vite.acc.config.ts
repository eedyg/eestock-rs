import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const ROOT = process.env.ACC_ROOT ?? REPO_WEB;
const OUT = process.env.ACC_OUT ?? '/tmp/acc_rec/dist';
const BASE = process.env.ACC_BASE ?? '/';

export default defineConfig({
  root: ROOT,
  base: BASE,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/acc_rec/kc-spy.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: { outDir: OUT, emptyOutDir: true, sourcemap: false },
});
