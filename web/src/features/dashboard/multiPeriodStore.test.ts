import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/api/client';

/**
 * 红测试（P1-A）：`multiPeriodStore`（`design/15-multi-period/02-spec.md` §1「multiPeriodStore（新）」
 * 运行态：启用/周期集合/高度/同步统计）的**契约**。
 *
 * 权威依据：`01-adr.md`（ADR-022 口径 5/9/12 + §2.5）、`02-spec.md` §1/§2/§6/§7/§9、`03-test-plan.md` T8bis/T11。
 * 预期 red 理由：**store 模块尚不存在**（解析 `./multiPeriodStore` 失败）。实现方落地后本文件应转绿，
 * 且**不得改动断言口径**（口径由本文件 + `tester/design/263_*` 钉死）。
 *
 * 覆盖：
 * - T11-1 关闭态默认（`enabled=false` ⇒ 单基准 + 默认高度 + `["dcap"]`）；
 * - T8bis **降级可观测字段占位**（只验「存在且可读出」：`syncDegraded` / `lastSpanDiffMinutes`；
 *   UI 角标属 P2/P3，不在本轮）；
 * - T11 关闭态**零副作用**（store 不持有数据流：不订阅 WS、不发起 K 线请求）；
 * - T11 开关往返**零残留**（运行态字段归零；不新增订阅/请求）。
 *
 * 明确不做（本轮范围外）：不做同步算法、不测 UI 角标、不测高度持久化（P5/T9）。
 */

/**
 * 模块说明符。红阶段模块不存在 ⇒ 用**变量 specifier**（类型显式 `string`）动态 import：
 * 字面量会让 tsc/vitest 在**收集期**整体报错，拿不到逐用例 red 证据；显式 `string` 同时避免
 * tsc 静态解析（红阶段 `tsc -b` 不被模块缺失阻塞，与 P0.1-A 同一手法）。
 */
const STORE_SPECIFIER: string = './multiPeriodStore';

/** P1 需要落地的 store 面（实现方按此签名落地；细节见设计报告 §5.1）。 */
interface MultiPeriodState {
  enabled: boolean;
  periods: string[];
  heights: Record<string, number>;
  indicators: string[];
  /** T8bis 占位：同步降级（对齐受限）标志；默认 false（口径 5 的「可观测字段」）。 */
  syncDegraded: boolean;
  /** T8bis 占位：最近一次对齐跨度差（分钟）；无记录 = null。 */
  lastSpanDiffMinutes: number | null;
}

interface MultiPeriodStoreLike {
  state: MultiPeriodState;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MultiPeriodState;
  load(): Promise<void>;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

async function loadStoreClass(): Promise<new (deps: { api: ApiClient }) => MultiPeriodStoreLike> {
  const mod = (await import(/* @vite-ignore */ STORE_SPECIFIER)) as {
    MultiPeriodStore: new (deps: { api: ApiClient }) => MultiPeriodStoreLike;
  };
  return mod.MultiPeriodStore;
}

/** 服务端默认配置（`02-spec.md` §2：关闭 + 单基准 + 基准高度 420 + `["dcap"]`）。 */
const DEFAULT_MP_CONFIG = {
  enabled: false,
  periods: ['1m'],
  heights: { '1m': 420 },
  indicators: ['dcap'],
};

/** 假 ApiClient：只实现本测试消费的接口 + 计数器（K 线/配置读取分别计数）。 */
function fakeApi(cfg: unknown = DEFAULT_MP_CONFIG, opts: { fail?: boolean } = {}) {
  const getKline = vi.fn(async () => []);
  const getMultiPeriodConfig = vi.fn(async () => {
    if (opts.fail) throw new Error('config 读取失败（模拟瞬态）');
    return cfg;
  });
  const api = { getKline, getMultiPeriodConfig } as unknown as ApiClient;
  return { api, getKline, getMultiPeriodConfig };
}

describe('multiPeriodStore（P1 配置面/store 契约；红：store 尚不存在）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T11-1 关闭态默认：enabled=false / 周期=单基准 / 高度与周期同键 / indicators=["dcap"]', async () => {
    const MultiPeriodStore = await loadStoreClass();
    const { api, getKline } = fakeApi();
    const store = new MultiPeriodStore({ api });

    await store.load();

    const s = store.state;
    expect(s.enabled).toBe(false); // 关闭多周期 ⇒ 行为与现状完全一致（口径 5）
    expect(s.periods).toEqual(['1m']); // 关闭 ⇒ 仅基准（单实例、单周期，§7.5）
    expect(s.heights).toEqual({ '1m': 420 }); // 高度键与周期一一对应（§6：默认基准 420）
    expect(s.indicators).toEqual(['dcap']); // 卫星继承的指标集合（§2，首版仅 dcap）
    expect(getKline).not.toHaveBeenCalled(); // 关闭态不取任何 K 线数据
  });

  it('load() 镜像服务端配置（不在前端硬编码；读回原样、不改写）', async () => {
    const MultiPeriodStore = await loadStoreClass();
    const serverCfg = {
      enabled: false,
      periods: ['1d', '1w'],
      heights: { '1d': 300, '1w': 180 },
      indicators: ['dcap'],
    };
    const { api, getMultiPeriodConfig } = fakeApi(serverCfg);
    const store = new MultiPeriodStore({ api });

    await store.load();

    expect(getMultiPeriodConfig).toHaveBeenCalledTimes(1);
    expect(store.state.periods).toEqual(['1d', '1w']);
    expect(store.state.heights).toEqual({ '1d': 300, '1w': 180 });
    expect(store.state.enabled).toBe(false);
  });

  it('T8bis 降级可观测字段存在且可读出（syncDegraded / lastSpanDiffMinutes）——不测 UI 角标', async () => {
    const MultiPeriodStore = await loadStoreClass();
    const { api } = fakeApi();
    const store = new MultiPeriodStore({ api });
    await store.load();

    const s = store.state;
    // 「存在」：字段必须出现在快照上（P2/P3 的 UI/日志可直接读出）
    expect(Object.prototype.hasOwnProperty.call(s, 'syncDegraded')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(s, 'lastSpanDiffMinutes')).toBe(true);
    // 「可读出」：类型与关闭态默认值
    expect(typeof s.syncDegraded).toBe('boolean');
    expect(s.syncDegraded).toBe(false); // 关闭态 / 无同步 ⇒ 不得为降级
    expect(s.lastSpanDiffMinutes).toBeNull(); // 无记录 ⇒ null（不得伪造 0）
    // 同一份快照经 getSnapshot 可读出（useSyncExternalStore 绑定口径，与 DashboardStore 并列）
    expect(store.getSnapshot().syncDegraded).toBe(false);
    expect(store.getSnapshot().lastSpanDiffMinutes).toBeNull();
  });

  it('关闭态零副作用：store 不发起 K 线请求、不创建任何订阅；配置读取失败保持默认关闭且不崩', async () => {
    const MultiPeriodStore = await loadStoreClass();
    const failing = fakeApi(DEFAULT_MP_CONFIG, { fail: true });
    const store = new MultiPeriodStore({ api: failing.api });

    // 读取失败：保持默认关闭（不抛穿到页面 ⇒ 不阻塞看板；口径见 ADR-020 读落韧性）
    await store.load().catch(() => undefined);

    expect(store.state.enabled).toBe(false);
    expect(failing.getKline).not.toHaveBeenCalled();

    // 订阅通道：变更必须通知监听者（useSyncExternalStore 契约）
    let notified = 0;
    const unsub = store.subscribe(() => {
      notified += 1;
    });
    store.setEnabled(true);
    expect(notified).toBeGreaterThan(0);
    unsub();
    const after = notified;
    store.setEnabled(false);
    expect(notified).toBe(after); // 退订后不再通知

    // 全程零 K 线请求（store 只持配置态；数据流由容器/feed 另行负责，§5）
    expect(failing.getKline).not.toHaveBeenCalled();
    store.dispose();
  });

  it('T11 开关往返零残留：setEnabled(true) → setEnabled(false) ⇒ 运行态归零、不新增请求', async () => {
    const MultiPeriodStore = await loadStoreClass();
    const { api, getKline, getMultiPeriodConfig } = fakeApi();
    const store = new MultiPeriodStore({ api });
    await store.load();
    const closed = store.getSnapshot();
    const cfgReadsAfterLoad = getMultiPeriodConfig.mock.calls.length;

    store.setEnabled(true);
    expect(store.state.enabled).toBe(true);

    store.setEnabled(false);
    const s = store.state;
    expect(s.enabled).toBe(false);
    // 运行态零残留：降级标志与跨度差必须归零（不得带着上一次的同步状态回关闭态）
    expect(s.syncDegraded).toBe(false);
    expect(s.lastSpanDiffMinutes).toBeNull();
    // 关闭态与初始关闭态**等价**（无多余字段漂移）
    expect(s).toEqual(closed);
    // 开关往返不得触发任何数据/配置副作用
    expect(getKline).not.toHaveBeenCalled();
    expect(getMultiPeriodConfig.mock.calls.length).toBe(cfgReadsAfterLoad);
  });
});
