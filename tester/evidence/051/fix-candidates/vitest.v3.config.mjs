import react from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@vitejs/plugin-react/dist/index.js';
const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const D = WEB + '/src/features/dashboard';
const SB = WEB + '/node_modules/.diag51';
export default {
  root: WEB, plugins: [react()],
  resolve: { alias: [
    { find: /^\.\/KlineChart$/, replacement: SB + '/KlineChart.fixed3' },
    { find: /^\.\/feed$/, replacement: D + '/feed' },
    { find: /^\.\/barSpaceFit$/, replacement: D + '/barSpaceFit' },
    { find: /^\.\/chartCommon$/, replacement: D + '/chartCommon' },
    { find: /^\.\/klineDataLoader$/, replacement: D + '/klineDataLoader' },
    { find: '@', replacement: WEB + '/src' },
  ] },
  test: { environment: 'jsdom', globals: true, setupFiles: [WEB + '/src/test/setup.ts'], css: false,
    include: [SB + '/green3.test.tsx', D + '/KlineChart.test.tsx', D + '/dcapWiringP3.test.tsx', D + '/DashboardPage.test.tsx'],
    exclude: [] },
};
