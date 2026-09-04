import type { Page } from '@playwright/test';

/**
 * 视觉基线 mask（design/06-web/09-frontend.md「E2E 测试栈」）。
 *
 * 背景：真实浏览器/真实容器下，交易日价格、时间戳、图表内容，以及 WS 推送的
 * 实时告警，都会产生分钟级噪声。基线只锁**稳定结构**——导航、工具栏、页面布局、
 * 配色、data-region 区域框——而对易变**数据区**用 `mask` 屏蔽：
 * Playwright 将匹配元素渲染为单一色块，该色块的位置/尺寸仍参与像素回归（验证
 * 区域坐标），但内容像素不参与。
 *
 * ⚠️ 注意：本基线在数据动态区是**故意剔除**内容的。任何「价格/时间/图内数据
 * 变了」的误报都是设计内豁免；真正该重跑基线的是布局/配色/结构变更。
 */

export type PageKey = 'dashboard' | 'sources' | 'symbols' | 'quality' | 'alerts';

export function mask(page: Page, selectors: string[]) {
  return selectors.map((s) => page.locator(s));
}

/** 各页面动态数据区 mask 选择器清单。
 * `[role=alert]` 为 critical 告警强弹 toast（右上角，临时出现）——一并屏蔽防误报。 */
export const MASKS_BY_PAGE: Record<string, string[]> = {
  // 顶栏：交易时段/采集状态/源健康数/WS 状态均动态
  // 看板：图表整体（价格/坐标/时间戳）+ 标的列表价格涨跌幅
  dashboard: ['[data-region="topbar"]', '[data-testid="kline-chart"]', '[data-region="symbol-list"] .num', '[role="alert"]'],
  // 数据源：计数条/源卡片/缺口卡/告警预览均为实时数据；
  // 告警预览内容会溢出 h-40 区域框，故用 `> *` 屏蔽其全部子元素（防误报）
  sources: ['[data-region="topbar"]', '[data-region="summary-bar"]', '[data-region="source-cards"]', '[data-region="gap-cards"]', '[data-region="alert-preview"]', '[data-region="alert-preview"] > *', '[role="alert"]'],
  // 标的：表格时间/今日已采/最新 bar 时刻等数字列
  symbols: ['[data-region="topbar"]', '[data-region="symbol-table"] .num', '[role="alert"]'],
  // 质量：分歧表数字（价格/偏差/时刻）+ 一致率/同步面板/缺口报告
  quality: ['[data-region="topbar"]', '[data-region="divergence-table"] .num', '[data-region="accuracy-cards"]', '[data-region="sync-panel"]', '[data-region="gap-report"]', '[role="alert"]'],
  // 告警：列表时刻/级别/状态随 WS 推送变化
  alerts: ['[data-region="topbar"]', '[data-region="alert-list"]', '[role="alert"]'],
};

/** 给 toHaveScreenshot 的公共选项（禁用 CSS 动画，屏蔽动态区） */
export function shotOptions(page: Page, pageKey: string) {
  return {
    animations: 'disabled' as const,
    mask: mask(page, MASKS_BY_PAGE[pageKey] ?? []),
  };
}
