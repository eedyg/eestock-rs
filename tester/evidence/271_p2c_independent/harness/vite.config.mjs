import { defineConfig } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/vite/dist/node/index.js';
import react from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@vitejs/plugin-react/dist/index.js';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const NM = WEB + '/node_modules';

export default defineConfig({
  root: '/tmp/p2c',
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^klinecharts$/, replacement: '/tmp/p2c/kcspy.ts' },
      { find: /^@\//, replacement: WEB + '/src/' },
      { find: /^react$/, replacement: NM + '/react/index.js' },
      { find: /^react-dom\/client$/, replacement: NM + '/react-dom/client.js' },
      { find: /^react-dom$/, replacement: NM + '/react-dom/index.js' },
      { find: /^react-router-dom$/, replacement: NM + '/react-router-dom/dist/index.js' },
      { find: /^react\/(.*)$/, replacement: NM + '/react/$1' },
    ],
  },
  build: {
    outDir: '/tmp/p2c/dist',
    emptyOutDir: true,
    minify: false,
    target: 'es2020',
  },
});
