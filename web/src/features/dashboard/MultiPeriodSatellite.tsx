import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { Period } from '@/api/types';
import type { WsClient } from '@/ws/WsClient';
import { KlineChart } from './KlineChart';
import { KlineDataFeed, type FeedStatus } from './feed';
import type { IndicatorName } from './Toolbar';
import { dcapWarmupBars, type DcapParams } from '@/features/indicators/dcapIndicator';
import { SATELLITE_MAX_BAR_SPACE } from './chartSyncGroup';

/**
 * 多周期**卫星实例**（`design/15-multi-period/02-spec.md` §3.4/§4.1/§5/§9；实施计划 P2）。
 *
 * 一个卫星 = 一个独立 klinecharts 实例 + **一个独立的 `KlineDataFeed`**（period = 该卫星周期）：
 *  - **隐藏 K 线**：`KlineChart hideCandles` ⇒ `setPaneOptions({id:'candle_pane', state:'minimize', minHeight:0})`
 *    + `setStyles({separator:{size:0}})`（唯一可行手段；`height:0` 被库静默忽略）；指标 pane 填满实例容器；
 *  - **指标继承**：把基准图的勾选集合（`indicators`）原样传给 `KlineChart` ⇒ 每个卫星渲染同一集合
 *    （MA 经 `addOverlayIndicator` 叠加、DCAP 独立副图 pane、参数变更走 `overrideIndicator`）；
 *  - **数据**：直接取后端该周期 bar（**禁止本地聚合**），复用既有 WS 订阅 / 每分钟兜底 / warmup 口径；
 *  - **失败可见**（02-spec §9）：取数初始化失败（`feed.status==='error'`）或图表 `init()` 失败 ⇒ 渲染
 *    `[data-mp-satellite-error="<period>"]` 横幅（**不得静默降级**为空白 pane），并提供重试。
 *
 * 生命周期：`enabled` 关闭 / 周期或标的变化 ⇒ 本组件卸载（或 feed 身份变化）⇒ `feed.dispose()` 释放
 * WS 订阅与兜底定时器、`KlineChart` 卸载 `dispose(chart)` ⇒ **零残留**（无订阅、无实例）。
 */
export interface MultiPeriodSatelliteProps {
  api: ApiClient;
  ws: WsClient;
  /** 当前选中标的（切标的 ⇒ 本卫星按新 code 重建 feed/chart）。 */
  code: string;
  /** 该卫星的周期（= 配置 `periods[i>0]`）。 */
  period: Period;
  /** 实例高度 px（本轮取 `heights[period]`；拖拽持久化属 P5）。 */
  height: number;
  /** 基准图指标勾选集合（继承源；02-spec §4.1）。 */
  indicators: Record<IndicatorName, boolean>;
  maWindows: number[];
  dcapParams: DcapParams;
  /** K 线默认视口根数（GET /api/config/kline；主图/宫格/卫星同口径）。 */
  viewportBars: number;
  /** 实时跟随（P2 只保证各实例各自右端跟随；跨图跨度对齐属 P3）。 */
  followLatest: boolean;
  /** 基准周期与来源（裁决 A 的显式可观测面；`toolbar` ⇒ 未被配置覆盖）。 */
  basePeriod: Period;
  basePeriodSource: 'config' | 'toolbar';
  /** 「对齐受限」降级（T8bis-④；用户裁决方案 1：诚实降级 + UI 标注）。 */
  syncDegraded?: boolean;
  /** 最近一次对齐的跨度差（分钟；降级原因的可读量化）。 */
  syncSpanDiffMinutes?: number | null;
}

export function MultiPeriodSatellite(props: MultiPeriodSatelliteProps) {
  const { api, ws, code, period, height, basePeriod, basePeriodSource, indicators, dcapParams } = props;

  /** 该实例的取数 warmup（02-spec §5：仅当该实例显示 dcap ⇒ `n_l+m−1`）。 */
  const warmupBars = indicators.dcap ? dcapWarmupBars(dcapParams) : 0;

  // 每实例一个 feed（键 = (code, period)）：切标的/切周期 ⇒ feed 身份变化 ⇒ 旧 feed 释放（useEffect 清理）。
  // `warmupBars` **故意不入 deps**：dcap 参数保存走 `feed.setWarmupBars` 热更新（KlineChart 的 warmupBars prop），
  // 否则会重建 feed ⇒ 图表 remount（02-spec §6「配置保存不得重建 pane」）。
  const feed = useMemo(
    () =>
      new KlineDataFeed({
        api,
        ws,
        code,
        period,
        viewportBars: props.viewportBars,
        warmupBars,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- warmup 故意不入 deps（热更新路径，见上）
    [api, ws, code, period, props.viewportBars],
  );
  useEffect(() => () => feed.dispose(), [feed]);

  const [status, setStatus] = useState<FeedStatus>(feed.status);
  const [initError, setInitError] = useState(false);
  /** 重试：重挂载本实例的 chart（同一 feed，已在重试中/已就绪），不新建 feed、不改 pane 布局。 */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setStatus(feed.status);
    setInitError(false); // 换 feed（切标的/切周期）⇒ 上一次失败复位
    return feed.onChange(() => setStatus(feed.status));
  }, [feed]);

  const failed = initError || status === 'error';

  return (
    <div
      data-mp-satellite={period}
      data-mp-base-period={basePeriod}
      data-mp-base-period-source={basePeriodSource}
      style={{ height: `${height}px` }}
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-line bg-panel"
    >
      <div className="flex items-center gap-2 px-2 pt-0.5 text-[10px] text-dim">
        <span className="num">指标 {period}</span>
        {basePeriodSource === 'config' && (
          <span
            data-mp-base-override
            className="rounded border border-acc1/40 px-1 text-[9px] text-sky-300"
            title={`基准（K 线）周期由多周期配置覆盖为 ${basePeriod}（工具栏周期未生效）`}
          >
            基准 {basePeriod}
          </span>
        )}
      </div>
      {/* T8bis-④/⑤「对齐受限」角标（诚实降级：绝不静默虚假对齐）。
          hover/点击给原因（title）+ 跨度差可读（data-mp-span-diff-min）——两者缺一即视为静默。 */}
      {props.syncDegraded && (
        <div
          data-mp-sync-degraded={period}
          data-mp-span-diff-min={String(props.syncSpanDiffMinutes ?? 0)}
          role="status"
          className="absolute right-1 top-4 z-20 cursor-help rounded border border-acc1/50 bg-panel/95 px-1 text-[9px] text-amber-300 shadow"
          title={`对齐受限：本 pane（${period}）无法在容纳 ≥2 根 bar 的同时与基准图（${basePeriod}）时间跨度一致（当前跨度差 ${props.syncSpanDiffMinutes ?? '未知'} 分钟）。原因：基准图缩放过大 ⇒ 请缩小基准图，或改选周期。`}
        >
          <span>对齐受限</span>
        </div>
      )}
      {failed && (
        <div
          data-mp-satellite-error={period}
          role="alert"
          className="absolute inset-x-0 top-4 z-20 flex items-center gap-2 bg-down/15 px-2 py-0.5 text-[10px] text-down"
        >
          <span>卫星指标 {period} 加载失败（未静默降级）</span>
          <button
            type="button"
            className="rounded border border-down/50 px-1 hover:border-down"
            onClick={() => {
              setAttempt((n) => n + 1);
              void feed.retry();
            }}
          >
            重试
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <KlineChart
          key={attempt}
          feed={feed}
          code={code}
          period={period}
          followLatest={props.followLatest}
          indicators={indicators}
          // 跨图同步（P3）未落地：卫星自身的手动缩放不写回全局「跟随」态。
          onManualZoom={() => {}}
          maWindows={props.maWindows}
          dcapParams={dcapParams}
          warmupBars={warmupBars}
          hideCandles
          /* 口径 9：卫星 `barSpaceLimit` 必须在 init 放宽（无运行时 setter）；默认 50 会**静默吞掉**
             大倍率（P0.3 §2.3）。基准实例**不传**该 prop ⇒ 保持 ADR-020 的 {1,50}（放宽不泄漏）。 */
          barSpaceLimit={{ min: 1, max: SATELLITE_MAX_BAR_SPACE }}
          onInitError={() => setInitError(true)}
        />
      </div>
    </div>
  );
}
