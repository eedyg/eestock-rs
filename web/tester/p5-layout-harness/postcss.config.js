/**
 * P5-A harness 的 PostCSS 配置（Vite 从 `root`（= 本目录）解析）：
 * 真实 Tailwind + autoprefixer ⇒ 工具类语义与生产一致。
 * Tailwind 自身的 `tailwind.config.js` 由 cwd(`web/`) 解析 ⇒ content 覆盖 `web/src/**`（产品源码）。
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
