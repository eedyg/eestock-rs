import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const R = '/home/eestock/workspace/git/eestock/eestock-rs';
export default defineConfig({
  root: '/tmp/acc4x/harness',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: R + '/web/src/' },
      { find: /^klinecharts$/, replacement: '/tmp/acc_rec/kc-spy.ts' },
    ],
  },
  build: { outDir: '/tmp/acc4x/dist', emptyOutDir: true },
});
