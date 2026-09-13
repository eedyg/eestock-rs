import { defineConfig } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/vite/dist/node/index.js';
import react from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@vitejs/plugin-react/dist/index.js';
import path from 'node:path';

const WEB = '/tmp/fix162/base';
const PROXY = 'http://127.0.0.1:8081';

export default defineConfig({
  root: WEB,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/fix162/spy-klinecharts.mjs' },
      { find: '@', replacement: WEB + '/src' },
    ],
  },
  build: { outDir: '/tmp/fix162/dist-base', emptyOutDir: true },
  preview: {
    port: 18093,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: PROXY, changeOrigin: true },
      '/ws': { target: PROXY, ws: true, changeOrigin: true },
    },
  },
});
