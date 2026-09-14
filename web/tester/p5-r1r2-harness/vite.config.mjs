import { defineConfig } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/vite/dist/node/index.js';
import react from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@vitejs/plugin-react/dist/index.js';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const HERE = WEB + '/tester/p5-r1r2-harness';

export default defineConfig({
  root: HERE,
  base: './',
  plugins: [react()],
  // 样式：`postcss.config.js`（同目录）⇒ 真实 Tailwind + autoprefixer（不手搓工具类子集）
  resolve: { alias: [{ find: /^@\//, replacement: WEB + '/src/' }] },
  build: {
    outDir: process.env.P5_HARNESS_DIST ?? '/tmp/p5-r1r2-dist',
    emptyOutDir: true,
    minify: false,
    target: 'es2020',
  },
});
