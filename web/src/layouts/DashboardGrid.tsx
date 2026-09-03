// ~/~ begin <<design/06-web/01-dashboard.md#web/src/layouts/DashboardGrid.tsx>>[init]
// 由 design/06-web/01-dashboard.md L3 代码块 tangle 生成，禁止手改
// 骨架职责：DOM 结构 + data-region 锚点 + 布局尺寸类；视觉样式在组件内手写
export function DashboardGrid() {
  return (
    <div data-region="dashboard" className="flex min-w-[1280px] flex-1">
      <aside data-region="symbol-list" className="w-60 border-r" />
      <main data-region="main-area" className="flex flex-1 flex-col">
        <div data-region="toolbar" className="h-9 border-b" />
        {/* 单图模式 */}
        <div data-region="main-chart" className="flex-1" />
        <div data-region="sub-chart" className="h-1/5" />
        {/* 宫格模式（toolbar 切换时替代 main-chart+sub-chart）
        <div data-region="grid-view" className="grid flex-1 grid-cols-2 grid-rows-2" />
        */}
      </main>
    </div>
  );
}
// ~/~ end
