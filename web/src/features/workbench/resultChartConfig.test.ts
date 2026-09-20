import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import {
  RESULT_CHART_CONFIG_KEY,
  clampCardHeight,
  defaultResultChartConfig,
  loadResultChartConfig,
  parseResultChartConfig,
  saveResultChartConfig,
  type ResultChartConfig,
} from './resultChartConfig';

/**
 * ADR-028 §2.4c 第 5 项「配置隔离（硬约束）」+ 第 6 项「持久化」：
 *  - 结果页的**指标选择**与**卡片高度**必须存于**结果页独立 key**；
 *  - **不得**读写看板的指标/布局配置；看板也**不得**静默覆盖结果页；
 *  - 默认 = `DASHBOARD_DEFAULTS.indicators`（vol 开）。
 *
 * 通道选择说明（本波实测）：服务端 `app_config` 只有**专用键**端点（`/api/config/ma|dcap|kline|
 * multi_period|sources|collector|mcp`），**无通用 KV 通道**（`crates/web/src/lib.rs:67-77`），
 * 且本波禁止改 Rust ⇒ 用 `localStorage`（**仅本机浏览器有效**，报告已披露）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));

describe('R0 独立 key（硬约束）：结果页配置只能落在自己的 key 上', () => {
  beforeEach(() => localStorage.clear());

  it('key 常量存在且与看板命名空间分离', () => {
    expect(RESULT_CHART_CONFIG_KEY).toBe('eestock.wb.result.chartConfig.v1');
    expect(RESULT_CHART_CONFIG_KEY).not.toMatch(/dashboard/i);
  });

  it('保存后 localStorage 只多出结果页这一个 key（不写看板配置）', () => {
    const cfg: ResultChartConfig = { ...defaultResultChartConfig(), cardHeights: { ...defaultResultChartConfig().cardHeights, kline: 400 } };
    saveResultChartConfig(cfg);
    expect(Object.keys(localStorage)).toEqual([RESULT_CHART_CONFIG_KEY]);
    // 看板命名空间不得出现任何键
    expect(Object.keys(localStorage).filter((k) => /dashboard/i.test(k))).toEqual([]);
  });

  it('只有看板的键存在时，结果页读到的仍是默认值（不读看板配置）', () => {
    localStorage.setItem('eestock.dashboard.layout.v1', JSON.stringify({ indicators: { vol: false } }));
    const cfg = loadResultChartConfig();
    expect(cfg.indicators.vol).toBe(DASHBOARD_DEFAULTS.indicators.vol);
    expect(cfg.cardHeights.kline).toBeNull();
  });

  it('源码层面：不得引用任何看板存储键（只有导入 DASHBOARD_DEFAULTS 取默认值）', () => {
    const src = readFileSync(resolve(HERE, 'resultChartConfig.ts'), 'utf8');
    expect(/localStorage\.(getItem|setItem|removeItem)\(\s*['"`]/.test(src), '禁止硬编码其它 key').toBe(false);
    expect(src).not.toMatch(/dashboard[._-]?(layout|config|state)/i);
  });
});

describe('R1 默认值 = DASHBOARD_DEFAULTS.indicators（vol 开）', () => {
  it('指标默认与看板默认同构（深拷贝，不共享引用）', () => {
    const a = defaultResultChartConfig();
    const b = defaultResultChartConfig();
    expect(a.indicators).toEqual({ ...DASHBOARD_DEFAULTS.indicators });
    expect(a.indicators.vol).toBe(true);
    a.indicators.vol = false;
    expect(b.indicators.vol, '默认值必须深拷贝，禁止污染 DASHBOARD_DEFAULTS').toBe(true);
    expect(DASHBOARD_DEFAULTS.indicators.vol, 'DASHBOARD_DEFAULTS 不得被结果页改写').toBe(true);
  });

  it('五张可缩放卡片默认高度 = null（= 保持既有默认渲染，逐像素不变）', () => {
    const cfg = defaultResultChartConfig();
    expect(cfg.cardHeights).toEqual({ kline: null, aggregate: null, slot: null, equity: null, position: null });
  });
});

describe('R2 解析/净化：坏数据不得污染（禁静默把坏值当 0 高）', () => {
  it('非 JSON / 非对象 / 坏字段 ⇒ 回默认', () => {
    expect(parseResultChartConfig('{oops')).toEqual(defaultResultChartConfig());
    expect(parseResultChartConfig('null')).toEqual(defaultResultChartConfig());
    expect(parseResultChartConfig('[]')).toEqual(defaultResultChartConfig());
  });

  it('未知指标键被忽略；已知键缺失 ⇒ 用默认值', () => {
    const cfg = parseResultChartConfig(JSON.stringify({ indicators: { vol: false, evil: true, macd: 'yes' } }));
    expect(cfg.indicators.vol).toBe(false);
    expect(cfg.indicators.macd).toBe(DASHBOARD_DEFAULTS.indicators.macd);
    expect(cfg.indicators).not.toHaveProperty('evil');
    expect(Object.keys(cfg.indicators).sort()).toEqual(Object.keys(DASHBOARD_DEFAULTS.indicators).sort());
  });

  it('高度：非整数/非有限/越界 ⇒ 夹紧或回 null；未知卡片 id 丢弃', () => {
    expect(clampCardHeight(200)).toBe(200);
    expect(clampCardHeight(200.6)).toBe(201);
    expect(clampCardHeight(1)).toBe(120);
    expect(clampCardHeight(99999)).toBe(1200);
    expect(clampCardHeight(Number.NaN)).toBeNull();
    expect(clampCardHeight('300' as unknown)).toBeNull();
    const cfg = parseResultChartConfig(JSON.stringify({ cardHeights: { kline: 400, aggregate: -5, evil: 300 } }));
    expect(cfg.cardHeights.kline).toBe(400);
    expect(cfg.cardHeights.aggregate).toBe(120);
    expect(cfg.cardHeights).not.toHaveProperty('evil');
  });
});

describe('R3 往返：保存后可读回（刷新保持的数据面）', () => {
  beforeEach(() => localStorage.clear());

  it('save → load 逐字段一致', () => {
    const cfg: ResultChartConfig = defaultResultChartConfig();
    cfg.indicators.macd = true;
    cfg.indicators.vol = false;
    cfg.cardHeights = { ...cfg.cardHeights, kline: 380, equity: 300 };
    saveResultChartConfig(cfg);
    expect(loadResultChartConfig()).toEqual(cfg);
  });

  it('storage 不可用（null）⇒ 回默认，不抛', () => {
    expect(loadResultChartConfig(null)).toEqual(defaultResultChartConfig());
  });
});
