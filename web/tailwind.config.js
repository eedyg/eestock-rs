/** @type {import('tailwindcss').Config} */
// 视觉 token 与 design/06-web/preview/01-dashboard.html 基线一致（见 09-frontend.md §7）
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        panel2: 'var(--panel2)',
        line: 'var(--line)',
        txt: 'var(--txt)',
        dim: 'var(--dim)',
        up: 'var(--up)',
        down: 'var(--down)',
        acc1: 'var(--acc1)',
        acc2: 'var(--acc2)',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
