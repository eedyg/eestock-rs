/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 后端应用面（Phase A）地址；端口定稿前可用 env 覆盖
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080';

// 代理表同时用于 dev（vite）与 preview（生产构建产物）
const proxy = {
  '/api': { target: proxyTarget, changeOrigin: true },
  '/ws': { target: proxyTarget, changeOrigin: true, ws: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy,
  },
  // preview：以**生产构建产物**（无 StrictMode 双次 effect）做真渲染 E2E，
  // 代理与 dev 同源（ADR-028 P5c：真渲染下跳转成功性证据链）。
  preview: {
    port: 4173,
    proxy,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
