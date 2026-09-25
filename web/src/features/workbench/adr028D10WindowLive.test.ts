import { describe, it, expect } from 'vitest';
import {
  buildCurveX,
  curveFetchWindow,
  clampDisclosure,
  liveConsistency,
  liveWindowFromGeom,
  writeBackWindow,
  makeWindow,
  type KlinePlotGeom,
  type ResultWindowState,
} from './resultWindow';
import { curveXs } from '@/features/backtest/chartUtils';

/**
 * ADR-028 §2.10 **D10**（跳转视口锁定 + 真值写回 + 活体披露）——纯函数层判据。
 *
 * 本文件是**规格的机器可读形式**（先红后绿）：四条判据逐条对应 D10 的决策 1–4，
 * 其中「活体一致性」（决策 3）与「取数窗口 == x 域」（决策 4）是**假绿复现**的判别点：
 * 旧口径（一次性快照 + 声明窗口取数）在本文件里**必红**（见 `假绿复现` 一节）。
 */

const BAR = 86_400;

/** K 线真身几何（可见 bar 序列 + 引擎读回 + 索引区间）。 */
function geom(barTs: number[], opts: { bar_space?: number; from_idx?: number; to_idx?: number } = {}): KlinePlotGeom {
  return {
    bar_ts: barTs,
    bar_space: opts.bar_space ?? 5,
    x_from_px: 12,
    chart_width_px: 606,
    from_idx: opts.from_idx ?? 100,
    to_idx: opts.to_idx ?? 100 + barTs.length - 1,
  };
}

describe('D10-3/A：liveWindowFromGeom —— 活体真身窗口（K 线可见 bar 序列为唯一事实源）', () => {
  it('由真身几何给出 from/to/bars/索引/bar_space；几何缺失 ⇒ null（不猜）', () => {
    const live = liveWindowFromGeom(geom([10, 20, 30, 40]));
    expect(live).toEqual({
      from_ts: 10,
      to_ts: 40,
      bars: 4,
      from_idx: 100,
      to_idx: 103,
      bar_space: 5,
    });
    expect(liveWindowFromGeom(null)).toBeNull();
    expect(liveWindowFromGeom({ bar_ts: [], bar_space: 5, x_from_px: 0, chart_width_px: 0 })).toBeNull();
  });
});

describe('D10-3/B：liveConsistency —— ok 必须包含「当前一致」（≈ 假绿判据）', () => {
  const win = makeWindow('jump', 10, 40, 4, 7, { from_idx: 100, to_idx: 103 });
  /** 申请回执（`WindowApplyResult` 的判定字段）：`requested_*` = **申请初选**、`observed_*` = **生效值**。 */
  const receipt = { ok: true, rev: 7, requested_bar_space: 5, observed_bar_space: 5, error: null };

  it('一致（回执成功 + 当期 rev + bar_space == requested + 可见域 == 窗口域）⇒ ok=true 且无 reason', () => {
    const r = liveConsistency({
      applied: receipt,
      live: liveWindowFromGeom(geom([10, 20, 30, 40])),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('①「先应用后改变」：真身 bar_space 被改写（生效 5 → 真身 6）⇒ ok=false（旧快照语义会绿 = 假绿本体）', () => {
    const r = liveConsistency({
      applied: receipt,
      live: liveWindowFromGeom(geom([10, 20, 30, 40], { bar_space: 6 })),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('|')).toContain('bar-space');
    expect(r.reasons.join('|'), '「被改写」不得读作「校准/夹取」').toContain('被改写');
    expect(r.reasons.join('|')).not.toContain('校准');
    expect(r.reasons.join('|')).not.toContain('夹取');
  });

  it('⑧【§2.10.1 裁决 1】引擎**校准**（申请初选 12 → 生效 11，真身 11）⇒ ok=**true**、reasons 空', () => {
    const r = liveConsistency({
      applied: { ok: true, rev: 7, requested_bar_space: 12, observed_bar_space: 11, error: null },
      live: liveWindowFromGeom(geom([10, 20, 30, 40], { bar_space: 11 })),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r, '「申请未被逐值兑现」（校准）只进 wb-window-clamped，**不得**改判 ok').toEqual({ ok: true, reasons: [] });
  });

  it('⑨【§2.10.1 裁决 1 防退化】生效值 11 → 真身被改写为 12 ⇒ ok=false，且 reason 明示「被改写」', () => {
    const r = liveConsistency({
      applied: { ok: true, rev: 7, requested_bar_space: 11, observed_bar_space: 11, error: null },
      live: liveWindowFromGeom(geom([10, 20, 30, 40], { bar_space: 12 })),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r.ok, '写窗成功 → 其后被改写 ⇒ 必须变红').toBe(false);
    expect(r.reasons.join('|')).toContain('被改写');
    expect(r.reasons.join('|')).not.toContain('校准');
    expect(r.reasons.join('|')).not.toContain('夹取');
  });

  it('②真身可见域偏离窗口域（> ±1 bar）⇒ ok=false', () => {
    const r = liveConsistency({
      applied: receipt,
      live: liveWindowTo(10 + 3 * 60, 40 - 3 * 60),
      window: win,
      expectRev: 7,
      barSeconds: 60,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('|')).toContain('domain');
  });

  it('③±1 bar 量化容差内 ⇒ 仍判一致（真身含部分 bar + 整数 barSpace）', () => {
    const r = liveConsistency({
      applied: receipt,
      live: liveWindowTo(10 + BAR, 40 - BAR),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('④过期回执（rev 不属当前请求）⇒ ok=false（禁过期快照冒充当前）', () => {
    const r = liveConsistency({
      applied: receipt,
      live: liveWindowFromGeom(geom([10, 20, 30, 40])),
      window: { ...win, rev: 8 },
      expectRev: 8,
      barSeconds: BAR,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('|')).toContain('receipt-stale');
  });

  it('⑤写窗失败（回执 ok=false）⇒ ok=false 且带 error', () => {
    const r = liveConsistency({
      applied: { ok: false, rev: 7, requested_bar_space: null, observed_bar_space: null, error: 'setBarSpace 未生效' },
      live: liveWindowFromGeom(geom([10, 20, 30, 40])),
      window: win,
      expectRev: 7,
      barSeconds: BAR,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('|')).toContain('setBarSpace 未生效');
  });

  it('⑥无程序化请求（用户手势源 kline）⇒ 不施「申请对照」判据（只要求真身可读）', () => {
    const r = liveConsistency({
      applied: null,
      live: liveWindowFromGeom(geom([10, 20, 30, 40], { bar_space: 21 })),
      window: makeWindow('kline', 10, 40, 4, 8, { from_idx: 100, to_idx: 103 }),
      expectRev: 8,
      barSeconds: BAR,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('⑦真身不可读（无 onVisibleRangeChange）⇒ ok=false（禁「没读数就算绿」）', () => {
    const r = liveConsistency({ applied: receipt, live: null, window: win, expectRev: 7, barSeconds: BAR });
    expect(r.ok).toBe(false);
    expect(r.reasons.join('|')).toContain('live-unreadable');
  });
});

/** 便捷构造：可见域端点可自由指定的活体窗口。 */
function liveWindowTo(from: number, to: number, bars = 4) {
  return { from_ts: from, to_ts: to, bars, from_idx: 0, to_idx: bars - 1, bar_space: 5 };
}

describe('D10-4：curveFetchWindow —— 曲线取数与 x 域**同源**（主路取真身可见域）', () => {
  it('主路（x 域 = K 线 bar 序列）⇒ 取数窗口 = 真身可见 ts 区间（**不是**声明窗口）', () => {
    expect(
      curveFetchWindow({
        source: 'kline',
        live: liveWindowFromGeom(geom([100, 200, 300])),
        window: { from_ts: 0, to_ts: 10_000 },
      }),
    ).toEqual({ from_ts: 100, to_ts: 300 });
  });

  it('降级（per_bar / ts：无真身几何或真身不可得）⇒ 回退声明窗口', () => {
    const w = { from_ts: 0, to_ts: 10_000 };
    expect(curveFetchWindow({ source: 'ts', live: null, window: w })).toEqual(w);
    expect(curveFetchWindow({ source: 'per_bar', live: null, window: w })).toEqual(w);
    expect(curveFetchWindow({ source: null, live: null, window: null })).toBeNull();
  });

  it('**剔除率 0**：同一构造下（含「先应用后改变」）取数点全部落在 x 域槽位上', () => {
    // M1 口径（barSeconds=60 ⇒ 配对容差 60s）：bar 序列间隔 60s，两窗口相隔 600s（≫ 容差）⇒ 可判别
    const STEP = 60;
    const live1 = geom([10, 10 + STEP, 10 + 2 * STEP, 10 + 3 * STEP, 10 + 4 * STEP], { from_idx: 0, to_idx: 4 });
    const live2 = geom([610, 610 + STEP, 610 + 2 * STEP, 610 + 3 * STEP, 610 + 4 * STEP], { from_idx: 6, to_idx: 10 });
    const staleWindow = { from_ts: 10, to_ts: 10 + 4 * STEP }; // 声明/跳转窗口（已过期）
    const fetch1 = curveFetchWindow({ source: 'kline', live: liveWindowFromGeom(live1), window: staleWindow })!;
    const fetch2 = curveFetchWindow({ source: 'kline', live: liveWindowFromGeom(live2), window: staleWindow })!;
    expect(fetch1).toEqual({ from_ts: 10, to_ts: 10 + 4 * STEP });
    expect(fetch2, '真身已移 ⇒ 取数窗口必须跟随真身').toEqual({ from_ts: 610, to_ts: 610 + 4 * STEP });

    // 后端 per_bar 全序列（取数窗口内返回子集）
    const backendPerBar = [10, 70, 130, 190, 250, 610, 670, 730, 790, 850];
    const inWindow = (w: { from_ts: number; to_ts: number }) => backendPerBar.filter((t) => t >= w.from_ts && t <= w.to_ts);

    // 新口径（同源）：取数窗口 = live2 ⇒ 全部落在 live2 的槽位上 ⇒ 剔除 0
    const xd2 = buildCurveX({ geom: live2, from_ts: staleWindow.from_ts, to_ts: staleWindow.to_ts, barSeconds: STEP }).xDomain;
    const r2 = curveXs(inWindow(fetch2), xd2, 1000, 8);
    expect(r2.unmatched).toBe(0);
    expect(r2.xs.every((x) => x != null)).toBe(true);

    // 旧口径反证（取数窗口 = 声明窗口，与 x 域不同源）：同一 x 域下**出现剔除** ⇒ 判据有鉴别力
    const rOld = curveXs(inWindow(staleWindow), xd2, 1000, 8);
    expect(rOld.unmatched, '旧口径（取数≠x 域）在该构造下必须剔除 > 0').toBeGreaterThan(0);
  });
});

describe('D10-2：writeBackWindow —— 目标不可达被夹取 ⇒ 以实测可达区间写回窗口状态机', () => {
  const jump = (from: number, to: number, span: number, rev = 5): ResultWindowState =>
    makeWindow('jump', from, to, span, rev, { from_idx: 0, to_idx: span - 1 });

  it('跳转被夹取（请求 120 根 ⇒ 真身可达 100 根）：端点/根数/索引全部写回实测值', () => {
    const cur = jump(1000, 1000 + 119 * BAR, 120);
    const next = writeBackWindow({
      cur,
      observed: { from_ts: 2000, to_ts: 2000 + 99 * BAR, from_idx: 300, to_idx: 399 },
      rev: 5,
    });
    expect(next).not.toBeNull();
    expect(next!.source).toBe('jump');
    expect(next!.rev).toBe(5);
    expect(next!.from_ts).toBe(2000);
    expect(next!.to_ts).toBe(2000 + 99 * BAR);
    expect(next!.span_bars).toBe(100);
    expect(next!.from_idx).toBe(300);
    expect(next!.to_idx).toBe(399);
  });

  it('「全览」被物理上限夹取（window = null ⇒ 请求全区间）：以实测可达区间**建立**窗口状态（source=reset）', () => {
    const next = writeBackWindow({
      cur: null,
      observed: { from_ts: 5000, to_ts: 5000 + 619 * BAR, from_idx: 900, to_idx: 1519 },
      rev: 9,
      source: 'reset',
    });
    expect(next).not.toBeNull();
    expect(next!.source).toBe('reset');
    expect(next!.rev).toBe(9);
    expect(next!.from_ts).toBe(5000);
    expect(next!.to_ts).toBe(5000 + 619 * BAR);
    expect(next!.span_bars).toBe(620);
  });

  it('已等价（写回应为幂等 no-op ⇒ 不触发多余 re-render / 取数）', () => {
    const cur = makeWindow('jump', 2000, 2000 + 99 * BAR, 100, 5, { from_idx: 300, to_idx: 399 });
    expect(
      writeBackWindow({
        cur,
        observed: { from_ts: 2000, to_ts: 2000 + 99 * BAR, from_idx: 300, to_idx: 399 },
        rev: 5,
      }),
    ).toBeNull();
  });

  it('无回执（写窗失败 / 未回读）⇒ 不动窗口状态机（不得编造可达区间）', () => {
    expect(writeBackWindow({ cur: jump(1000, 1000 + 119 * BAR, 120), observed: null, rev: 5 })).toBeNull();
  });
});

describe('D10-3/C：wb-window-clamped 按**活体**重算（禁过期快照）', () => {
  const req = { from_ts: 1000, to_ts: 1000 + 119 * BAR, span_bars: 120 };

  it('活体 == 请求 ⇒ 无钳位披露', () => {
    expect(
      clampDisclosure(req, { from_ts: req.from_ts, to_ts: req.to_ts, from_idx: 0, to_idx: 119 }, BAR),
    ).toBeNull();
  });

  it('⑩【§2.10.1 裁决 1】校准（申请初选 12 → 生效 11；ts 区间逐值相同）也必须在 wb-window-clamped 独立披露', () => {
    const same = { from_ts: 1000, to_ts: 1000 + 99 * BAR, span_bars: 100 };
    expect(
      clampDisclosure(same, { from_ts: same.from_ts, to_ts: same.to_ts, from_idx: 0, to_idx: 99 }, BAR),
      '不传 barSpace 侧读数 ⇒ 无从判断是否校准（旧口径）',
    ).toBeNull();
    const note = clampDisclosure(
      same,
      { from_ts: same.from_ts, to_ts: same.to_ts, from_idx: 0, to_idx: 99 },
      BAR,
      { requested: 12, observed: 11 },
    );
    expect(note, '区间逐值相同而 barSpace 被校准 ⇒ 仍须披露（否则「申请未被逐值兑现」静默）').not.toBeNull();
    expect(note!).toContain('12');
    expect(note!).toContain('11');
    expect(note!).toContain('校准');
  });

  it('活体偏离请求（真身可达更窄）⇒ 披露含 requested/observed 两侧读数', () => {
    const note = clampDisclosure(req, { from_ts: req.from_ts, to_ts: req.from_ts + 99 * BAR, from_idx: 0, to_idx: 99 }, BAR);
    expect(note).not.toBeNull();
    expect(note!).toContain('被钳位');
    expect(note!).toContain(`[${req.from_ts}, ${req.to_ts}]`);
    expect(note!).toContain('120 根');
    expect(note!).toContain('100 根');
  });
});
