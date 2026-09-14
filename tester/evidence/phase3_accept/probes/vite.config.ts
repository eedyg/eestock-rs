import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO_WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
export default defineConfig({
  root: '/tmp/acc3/harness',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/acc3/kc-spy.ts' },
      { find: '@', replacement: path.resolve(REPO_WEB, 'src') },
    ],
  },
  build: { outDir: '/tmp/acc3/dist-h', emptyOutDir: true, sourcemap: false },
  server: { port: 18095, strictPort: true, host: '127.0.0.1' },
  preview: { port: 18095, strictPort: true, host: '127.0.0.1' },
});
