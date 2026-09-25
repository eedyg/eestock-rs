import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertResolvedByIdFresh,
  assertRunMatchesPredicate,
  isResolvedByPredicate,
  resolveRun,
  PREDICATES,
  PAIR_MID_GAP_BARS,
  CENTER_MARGIN_BARS,
  KLINE_HISTORY_MIN_BARS,
  L2_END_FILL_IDX,
  type ResolvedRun,
  type RunFetchPort,
  type RunFill,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

/**
 * ADR-028 §2.10.1 **裁决 3｜规格耐久**——e2e 目标 run 的**谓词解析**（本文件是规格的机器可读形式）。
 *
 * 三条纪律的机器化：
 *  ① 解析必须命中**最新**的谓词匹配者（不是「列表里第一个 D1」、更不是硬编码字面量）；
 *  ② 全不命中 ⇒ **抛错**（禁静默换 run / 禁跳过）；
 *  ③ **反硬编码护栏**：规格使用的 id 必须 == 现场重解析结果（改回字面量 ⇒ 抛错）。
 *
 * 红→绿：本文件先写在实现之前；实现见 `adr028RunResolve.ts`。
 */

interface Fixture {
  runs: RunListItem[];
  totals: Record<string, number>;
  rts: Record<string, RunRoundTrip[]>;
  fills: Record<string, RunFill[]>;
  /** 取数抛错的 run（模拟 failed run 的 404）。 */
  failFetch?: Set<string>;
}

function port(fx: Fixture): RunFetchPort {
  const guard = (id: string): void => {
    if (fx.failFetch?.has(id)) throw new Error(`GET /runs/${id}/bars → 404`);
  };
  return {
    listRuns: async () => fx.runs,
    totalBars: async (id) => {
      guard(id);
      const t = fx.totals[id];
      if (t == null) throw new Error(`unknown run ${id}`);
      return t;
    },
    roundTrips: async (id) => {
      guard(id);
      return fx.rts[id] ?? [];
    },
    fills: async (id, rtSeq) => {
      guard(id);
      return (fx.fills[`${id}#${rtSeq}`] ?? []).slice() as RunFill[];
    },
  };
}

/** 造一个「D1、回合 1 有 16 笔、第 16 笔在末根、第 8 笔在中段」的 run。 */
function d1Run(id: string, createdAt: string, total = 314, endBar = total - 1, midBar = 268): Fixture {
  const fills: RunFill[] = [];
  for (let i = 0; i < 16; i++) {
    const bar = i === L2_END_FILL_IDX ? endBar : i === 7 ? midBar : 261 + i;
    fills.push({ bar_index: bar, ts: 1_700_000_000 + bar * 86_400, side: i % 2 === 0 ? 'Buy' : 'Sell', rt_seq: 1 });
  }
  return {
    runs: [{ id, period: 'D1', status: 'succeeded', created_at: createdAt }],
    totals: { [id]: total },
    rts: { [id]: [{ rt_seq: 1, l2_count: 16, open_bar: 261, close_bar: endBar }] },
    fills: { [`${id}#1`]: fills },
  };
}

function merge(...fxs: Fixture[]): Fixture {
  const out: Fixture = { runs: [], totals: {}, rts: {}, fills: {} };
  const bad = new Set<string>();
  for (const fx of fxs) {
    out.runs.push(...fx.runs);
    Object.assign(out.totals, fx.totals);
    Object.assign(out.rts, fx.rts);
    Object.assign(out.fills, fx.fills);
    for (const id of fx.failFetch ?? []) bad.add(id);
  }
  if (bad.size > 0) out.failFetch = bad;
  return out;
}

describe('裁决 3/A：resolveRun —— 只认谓词命中的**最新** run（禁「列表第一个」兜底）', () => {
  it('多个候选命中 ⇒ 取 created_at 最新者；被拒候选留证据（可复核）【串行语义基线：concurrency=1】', async () => {
    const older = d1Run('sr_old', '2026-09-19T15:41:17Z');
    const newer = d1Run('sr_new', '2026-09-20T03:31:22Z');
    const tooShort = d1Run('sr_short', '2026-09-24T17:07:19Z', 260);
    // 更早的候选「第 16 笔不在末根」⇒ 必须被拒（这正是硬编码旧 run 的形态）
    const notAtEnd = d1Run('sr_notend', '2026-09-21T00:00:00Z', 427, 300);
    const r = await resolveRun(port(merge(older, newer, tooShort, notAtEnd)), 'd1', { concurrency: 1, cacheDir: null });
    expect(r.id).toBe('sr_new');
    expect(r.rtSeq).toBe(1);
    expect(r.evidence.detail['endBar']).toBe(newer.totals['sr_new']! - 1);
    expect(r.evidence.rejected.map((x) => x.id)).toEqual(expect.arrayContaining(['sr_short', 'sr_notend']));
    // 已核对候选数（含命中者）：最新优先 + **命中即返回** ⇒ sr_short/sr_notend 被拒后即命中 sr_new
    expect(r.evidence.scanned).toBe(3);
  });

  it('全不命中 ⇒ **抛错**（含谓词原文与逐候选拒绝原因），绝不返回兜底 run', async () => {
    const only = d1Run('sr_only', '2026-09-24T00:00:00Z', 260);
    await expect(resolveRun(port(only), 'd1', { cacheDir: null })).rejects.toThrow(/谓词解析失败（d1）/);
    await expect(resolveRun(port(only), 'd1', { cacheDir: null })).rejects.toThrow(/禁静默换用别的 run/);
    await expect(resolveRun(port(only), 'd1', { cacheDir: null })).rejects.toThrow(PREDICATES.d1.text);
  });

  it('候选取数失败（failed run 的 404）不炸整体：记为拒绝原因并继续扫描', async () => {
    const broken: RunListItem = { id: 'sr_broken', period: 'D1', status: 'succeeded', created_at: '2026-09-25T00:00:00Z' };
    const good = d1Run('sr_good', '2026-09-20T00:00:00Z');
    const fx = merge(good, { runs: [broken], totals: {}, rts: {}, fills: {}, failFetch: new Set(['sr_broken']) });
    const r = await resolveRun(port(fx), 'd1', { cacheDir: null });
    expect(r.id).toBe('sr_good');
    expect(r.evidence.rejected.some((x) => x.id === 'sr_broken' && /404/.test(x.why))).toBe(true);
  });

  it('基础过滤：period / status 不符者不参与（failed run 不得被解析为目标）', async () => {
    const failed: RunListItem = { id: 'sr_failed', period: 'M15', status: 'failed', created_at: '2026-09-25T00:00:00Z' };
    const m15ok: RunListItem = { id: 'sr_m15', period: 'M15', status: 'succeeded', created_at: '2026-09-24T00:00:00Z' };
    const fx: Fixture = {
      runs: [failed, m15ok],
      totals: { sr_m15: 3436 },
      rts: { sr_m15: [{ rt_seq: 1, l2_count: 2 }] },
      fills: { 'sr_m15#1': [{ bar_index: 1, ts: 1, side: 'Buy', rt_seq: 1 }, { bar_index: 2, ts: 2, side: 'Sell', rt_seq: 1 }] },
    };
    const r = await resolveRun(port(fx), 'excl', { cacheDir: null });
    expect(r.id).toBe('sr_m15');
    expect(r.evidence.scanned, 'failed 候选不计入扫描面（基础过滤在前）').toBe(1);
    expect(r.evidence.detail['totalBars']).toBe(3436);
  });
});

describe('裁决 3/B：center 谓词必须编码「真居中可行」（否则 E3 的判据失去前提）', () => {
  function centerFx(id: string, createdAt: string, total: number, target: number, first: number): Fixture {
    return {
      runs: [{ id, period: 'D1', status: 'succeeded', created_at: createdAt }],
      totals: { [id]: total },
      rts: { [id]: [{ rt_seq: 3, l2_count: 2 }] },
      fills: {
        [`${id}#3`]: [
          { bar_index: first, ts: 1, side: 'Buy', rt_seq: 3 },
          { bar_index: target, ts: 2, side: 'Sell', rt_seq: 3 },
        ],
      },
    };
  }

  it('贴末端（margin < 60）的候选被拒；中段候选被选中', async () => {
    const clamped = centerFx('sr_edge', '2026-09-24T00:00:00Z', 427, 426, 400);
    const centered = centerFx('sr_mid', '2026-09-20T00:00:00Z', 427, 325, 316);
    const r = await resolveRun(port(merge(clamped, centered)), 'center', { cacheDir: null });
    expect(r.id).toBe('sr_mid');
    expect(r.evidence.detail['margin']).toBe(Math.min(325, 427 - 1 - 325));
    expect(r.evidence.rejected[0]?.why).toMatch(new RegExp(`< ${CENTER_MARGIN_BARS}`));
  });

  it('两笔同 bar 的候选被拒（M2 需要「窗口移动」可判别）', async () => {
    const same = centerFx('sr_same', '2026-09-24T00:00:00Z', 427, 325, 325);
    await expect(resolveRun(port(same), 'center', { cacheDir: null })).rejects.toThrow(/同一根 bar/);
  });
});

describe('裁决 3/C：反硬编码护栏（把 run id 改回字面量 ⇒ 必红）', () => {
  const fresh = { id: 'sr_resolved', label: 'd1' } as ResolvedRun;

  it('使用的 id == 现场解析结果 ⇒ 通过', () => {
    expect(isResolvedByPredicate('sr_resolved', fresh)).toBe(true);
    expect(() => assertResolvedByIdFresh('sr_resolved', fresh, 'd1')).not.toThrow();
  });

  it('使用的 id 是**历史硬编码字面量**（≠ 现场解析结果）⇒ 抛错（规格必红）', () => {
    expect(isResolvedByPredicate('sr_1789832477006_000002', fresh)).toBe(false);
    expect(() => assertResolvedByIdFresh('sr_1789832477006_000002', fresh, 'd1')).toThrow(/禁止硬编码 run id/);
    expect(() => assertResolvedByIdFresh('sr_1789832477006_000002', fresh, 'd1')).toThrow(/≠ 谓词\(d1\) 现场解析结果 sr_resolved/);
  });
});

describe('裁决 3/F：`pair` 谓词（features-verify 族的末根双笔 + 中段对照前提）', () => {
  /** 造一个「末根 bar 上恰有 Buy+Sell、且存在距末根 ≥40 根的中段成交」的 D1 run。 */
  function pairRun(id: string, createdAt: string, total = 400, opts: { onLast?: string[]; midGap?: number } = {}): Fixture {
    const onLast = opts.onLast ?? ['Buy', 'Sell'];
    const gap = opts.midGap ?? 100;
    const fills: RunFill[] = [
      { bar_index: total - 1 - gap, ts: 1, side: 'Buy', rt_seq: 1 },
      ...onLast.map((side, k) => ({ bar_index: total - 1, ts: 9 + k, side, rt_seq: 1 })),
    ];
    return {
      runs: [{ id, period: 'D1', status: 'succeeded', created_at: createdAt }],
      totals: { [id]: total },
      rts: { [id]: [{ rt_seq: 1, l2_count: fills.length, open_bar: total - 1 - gap, close_bar: total - 1 }] },
      fills: { [`${id}#1`]: fills },
    };
  }

  it('命中：末根 bar 一 Buy 一 Sell ∧ 存在中段成交（距末根 ≥ PAIR_MID_GAP_BARS）', async () => {
    const r = await resolveRun(port(pairRun('sr_pair', '2026-09-23T00:00:00Z')), 'pair', { cacheDir: null });
    expect(r.id).toBe('sr_pair');
    expect(r.rtSeq).toBe(1);
    expect(r.evidence.detail['lastBar']).toBe(399);
    expect(r.evidence.detail['onLast']).toBe(2);
    expect(r.predicate, '谓词原文必须可复核').toContain('末根 bar');
  });

  it('拒绝：末根 bar 只有单笔（旧硬编码 run 的形态）⇒ 不命中', async () => {
    const only = pairRun('sr_single', '2026-09-23T00:00:00Z', 400, { onLast: ['Sell'] });
    await expect(resolveRun(port(only), 'pair', { cacheDir: null })).rejects.toThrow(/Buy|Sell/);
  });

  it('拒绝：无「距末根 ≥ PAIR_MID_GAP_BARS 根」的中段成交（对照样本缺失）', async () => {
    const tight = pairRun('sr_tight', '2026-09-23T00:00:00Z', 400, { midGap: PAIR_MID_GAP_BARS - 1 });
    await expect(resolveRun(port(tight), 'pair', { cacheDir: null })).rejects.toThrow(/中段成交/);
  });

  it('多个命中 ⇒ 取最新者（同上「最新优先」语义）', async () => {
    const older = pairRun('sr_pair_old', '2026-09-20T00:00:00Z');
    const newer = pairRun('sr_pair_new', '2026-09-23T00:00:00Z');
    const r = await resolveRun(port(merge(older, newer)), 'pair', { cacheDir: null });
    expect(r.id).toBe('sr_pair_new');
  });
});

// ═══════════ 裁决 3/G–H：`klineHistory` 谓词 + 显式覆盖（`ADR028_KH_RUN` 类逃生门） ═══════════

/** 造一个 M15 run（`klineHistory` 谓词只核对 period/status/根数，不涉成交）。 */
function m15Run(id: string, createdAt: string, total: number, period = 'M15', status = 'succeeded'): Fixture {
  return {
    runs: [{ id, period, status, created_at: createdAt }],
    totals: { [id]: total },
    rts: { [id]: [] },
    fills: {},
  };
}

/**
 * `klineHistory` 谓词（`adr028-kline-history` 族；ADR-028 §2.10.1 裁决 3 的原文示例就是「M15 且根数 ≥3000」）。
 * 结构性前提 = **单页上限（1000 根）拉不回整段** ⇒ K1（数据域覆盖）与 K3（向前分页）才有前提；
 * 低于阈值的长区间 run 会让两条判据**退化为恒真**（一页就够）⇒ 必须被谓词拒。
 */
describe('裁决 3/G：`klineHistory` 谓词（结果页 K 线历史截断修复的**向前分页前提**）', () => {
  it('命中：M15 ∧ succeeded ∧ per_bar ≥ 阈值（≥3 页 ⇒ 单页 1000 根拉不回，分页判据有前提）', async () => {
    const r = await resolveRun(port(m15Run('sr_kh', '2026-09-24T16:36:01Z', KLINE_HISTORY_MIN_BARS)), 'klineHistory', {
      cacheDir: null,
    });
    expect(r.id).toBe('sr_kh');
    expect(r.totalBars).toBe(KLINE_HISTORY_MIN_BARS);
    expect(r.predicate).toContain('M15');
    expect(String(r.predicate)).toContain(String(KLINE_HISTORY_MIN_BARS));
    expect(r.evidence.detail['rank'], '证据必须带新→旧位次（可复核「为什么是它」）').toBe(1);
  });

  it('拒绝：根数 < 阈值（一页 1000 根够拉 ⇒ K1/K3 的向前分页失去前提）', async () => {
    const short = m15Run('sr_kh_short', '2026-09-24T16:36:01Z', KLINE_HISTORY_MIN_BARS - 1);
    await expect(resolveRun(port(short), 'klineHistory', { cacheDir: null })).rejects.toThrow(/per_bar total=/);
  });

  it('拒绝：非 M15（基础过滤在前 ⇒ M5/D1 候选不参与，禁跨周期取靶）', async () => {
    const m5 = m15Run('sr_kh_m5', '2026-09-25T00:00:00Z', 5000, 'M5');
    await expect(resolveRun(port(m5), 'klineHistory', { cacheDir: null })).rejects.toThrow(/谓词解析失败（klineHistory）/);
  });

  it('多个命中 ⇒ 取 created_at **最新**者（禁「列表第一个」兜底）', async () => {
    const older = m15Run('sr_kh_old', '2026-09-24T10:56:11Z', 3436);
    const newer = m15Run('sr_kh_new', '2026-09-24T16:36:01Z', 3436);
    const r = await resolveRun(port(merge(older, newer)), 'klineHistory', { cacheDir: null });
    expect(r.id).toBe('sr_kh_new');
    expect(r.evidence.detail['rank']).toBe(1);
  });

  it('位次证据以**全量 run 列表**为基准（含非 M15 候选；与复验读数「71/93」同口径）', async () => {
    const fx = merge(
      d1Run('sr_d1_new', '2026-09-25T00:00:00Z'),
      m15Run('sr_kh', '2026-09-24T16:36:01Z', 3436),
      m15Run('sr_kh_short', '2026-09-24T10:00:00Z', 1402),
    );
    const r = await resolveRun(port(fx), 'klineHistory', { cacheDir: null });
    expect(r.id).toBe('sr_kh');
    expect(r.evidence.detail['rank'], '位次 = 在全量新→旧列表中的下标 + 1').toBe(2);
    expect(r.evidence.detail['rankBasis']).toBe(3);
  });

  it('反硬编码：`klineHistory` 族的历史字面量（≠ 现场解析结果）⇒ 护栏抛错（规格必红）', async () => {
    const fresh = (await resolveRun(port(m15Run('sr_kh', '2026-09-24T16:36:01Z', 3436)), 'klineHistory', {
      cacheDir: null,
    })) as ResolvedRun;
    expect(() => assertResolvedByIdFresh('sr_1790247371321_000015', fresh, 'klineHistory')).toThrow(
      /禁止硬编码 run id/,
    );
  });

  it('库指纹变化（新增更新的命中者）⇒ 缓存失效；命中者换成新 run（缓存不得变硬编码）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adr028-kh-cache-'));
    const first = await resolveRun(port(m15Run('sr_kh_old', '2026-09-24T10:56:11Z', 3436)), 'klineHistory', {
      cacheDir: dir,
      sourceKey: 'fixture://kh',
    });
    expect(first.id).toBe('sr_kh_old');
    const fx = merge(m15Run('sr_kh_old', '2026-09-24T10:56:11Z', 3436), m15Run('sr_kh_new', '2026-09-25T01:00:00Z', 3436));
    const r = await resolveRun(port(fx), 'klineHistory', { cacheDir: dir, sourceKey: 'fixture://kh' });
    expect(r.id).toBe('sr_kh_new');
    expect(r.evidence.cache?.status).toBe('miss');
  });
});

/**
 * **显式覆盖**（`ADR028_KH_RUN` 类 env 旋钮）**仍须校验谓词**：
 * 覆盖路径允许「不是最新命中者」（逃生门），但**不允许**指向不满足谓词 / 不在库中的 run ——
 * 否则「换个 run 就绿」会变成静默换 run（裁决 3 明禁）。
 */
describe('裁决 3/H：`assertRunMatchesPredicate` —— 显式覆盖仍须**满足谓词**（不满足 ⇒ 显式红）', () => {
  function khFixture(): Fixture {
    return merge(
      m15Run('sr_kh_new', '2026-09-24T16:36:01Z', 3436),
      m15Run('sr_kh_old', '2026-09-24T10:56:11Z', 3436),
      m15Run('sr_kh_short', '2026-09-24T09:00:00Z', 1402),
    );
  }

  it('覆盖 run **满足谓词**（非最新者亦可）⇒ 返回该 run 的解析结果（标注 explicitOverride）', async () => {
    const fx = khFixture();
    const r = await assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_kh_old');
    expect(r.id).toBe('sr_kh_old');
    expect(r.label).toBe('klineHistory');
    expect(r.totalBars).toBe(3436);
    expect(r.evidence.detail['explicitOverride']).toBe(true);
    expect(r.evidence.detail['rank'], '覆盖 run 的位次同样可复核').toBe(2);
    expect(r.evidence.cache?.status, '覆盖路径不得读写落盘缓存（否则逃逸谓词）').toBe('disabled');
  });

  it('覆盖 run **不在库中** ⇒ 抛错（禁静默换 run / 禁跳过）', async () => {
    const fx = khFixture();
    await expect(assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_ghost')).rejects.toThrow(/不在库中/);
  });

  it('覆盖 run 存在但**不满足谓词**（M15 ✗ 根数不足）⇒ 抛错（携拒绝原因）', async () => {
    const fx = khFixture();
    await expect(assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_kh_short')).rejects.toThrow(
      new RegExp(`per_bar total=1402 < ${KLINE_HISTORY_MIN_BARS}`),
    );
  });

  it('覆盖 run 周期不符（M5）⇒ 抛错（禁跨周期换靶）', async () => {
    const fx = merge(khFixture(), m15Run('sr_kh_m5', '2026-09-25T00:00:00Z', 5000, 'M5'));
    await expect(assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_kh_m5')).rejects.toThrow(/period=M5/);
  });

  it('覆盖 run 状态不符（failed）⇒ 抛错（failed run 不得作为靶）', async () => {
    const fx = merge(khFixture(), m15Run('sr_kh_failed', '2026-09-25T00:00:00Z', 3436, 'M15', 'failed'));
    await expect(assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_kh_failed')).rejects.toThrow(/status=failed/);
  });

  it('覆盖 run 取数失败（404）⇒ 抛错（不得容忍为「通过」）', async () => {
    const fx = khFixture();
    fx.failFetch = new Set(['sr_kh_old']);
    await expect(assertRunMatchesPredicate(port(fx), 'klineHistory', 'sr_kh_old')).rejects.toThrow(/取数失败/);
  });
});

// ═════════════════════════ 仪表：在飞请求计数 / 取数次数 ═════════════════════════

/** 包装 {@link RunFetchPort}：记录**在飞请求数**（并发判据）与各端点调用次数（缓存判据）。 */
function tracked(base: RunFetchPort, delayMs = 0): { port: RunFetchPort; stats: () => { maxInFlight: number; calls: Record<string, number> } } {
  const calls: Record<string, number> = { listRuns: 0, totalBars: 0, roundTrips: 0, fills: 0 };
  let inFlight = 0;
  let maxInFlight = 0;
  const wrap = async <T,>(kind: string, fn: () => Promise<T>): Promise<T> => {
    calls[kind] = (calls[kind] ?? 0) + 1;
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return await fn();
    } finally {
      inFlight -= 1;
    }
  };
  return {
    port: {
      listRuns: () => wrap('listRuns', () => base.listRuns()),
      totalBars: (id) => wrap('totalBars', () => base.totalBars(id)),
      roundTrips: (id) => wrap('roundTrips', () => base.roundTrips(id)),
      fills: (id, rt) => wrap('fills', () => base.fills(id, rt)),
    },
    stats: () => ({ maxInFlight, calls: { ...calls } }),
  };
}

/** N 个 D1 候选：created_at 递减（`sr_c0` 最新），仅 `hitIndex` 那个满足谓词。 */
function manyCandidates(n: number, hitIndex: number): Fixture {
  const fxs: Fixture[] = [];
  for (let i = 0; i < n; i++) {
    const day = String(10 + (n - i)).padStart(2, '0'); // i 越小 ⇒ created_at 越新
    if (i === hitIndex) fxs.push(d1Run(`sr_c${i}`, `2026-09-${day}T00:00:00Z`));
    else fxs.push(d1Run(`sr_c${i}`, `2026-09-${day}T00:00:00Z`, 314, 200, 268)); // endBar ≠ total−1 ⇒ 被拒
  }
  return merge(...fxs);
}

describe('裁决 3/D：**有界并发**（修复 `d1` 解析 48.8s 吃穿 60s 预算的假红；§7.2 修法 ②）', () => {
  it('在飞请求 ≤ concurrency（默认 8），且命中 run 与**串行完全相同**', async () => {
    const fx = manyCandidates(20, 19); // 只有**最旧**的候选命中 ⇒ 必须扫完全部候选才命中
    const serial = tracked(port(fx), 3);
    const parallel = tracked(port(fx), 3);
    const rs = await resolveRun(serial.port, 'd1', { concurrency: 1, cacheDir: null });
    const rp = await resolveRun(parallel.port, 'd1', { concurrency: 8, cacheDir: null });
    expect(rp.id, '并发与非并发的**命中 run 必须相同**').toBe(rs.id);
    expect(rp.id).toBe('sr_c19');
    expect(rp.totalBars).toBe(rs.totalBars);
    expect(rp.rtSeq).toBe(rs.rtSeq);
    expect(serial.stats().maxInFlight, '串行：在飞请求必须恒 = 1').toBe(1);
    expect(parallel.stats().maxInFlight, '并发：必须真的并发（> 1）').toBeGreaterThan(1);
    expect(parallel.stats().maxInFlight, '并发度必须受 ≤ 8 约束（有界）').toBeLessThanOrEqual(8);
    expect(rp.evidence.concurrency, '证据必须记下并发度（可复核）').toBe(8);
    expect(rs.evidence.concurrency).toBe(1);
    // 并发下的扫描面 = 命中候选及其「同批」候选（不等于「全量」，但也可能多于串行）
    expect(rp.evidence.scanned).toBeLessThanOrEqual(20);
    expect(rs.evidence.scanned, '串行语义：命中即停').toBe(20);
  });

  it('批内多个命中 ⇒ 取**列表中更靠前者**（= 最新优先语义在并发下不变）', async () => {
    // c3 与 c7 都命中（c3 更新）；8 路并发会把两者放进**同一批** ⇒ 必须取 c3
    const fx = merge(
      ...Array.from({ length: 10 }, (_, i) =>
        i === 3 || i === 7 ? d1Run(`sr_c${i}`, `2026-09-${String(20 - i).padStart(2, '0')}T00:00:00Z`) : d1Run(`sr_c${i}`, `2026-09-${String(20 - i).padStart(2, '0')}T00:00:00Z`, 314, 200, 268),
      ),
    );
    const r = await resolveRun(port(fx), 'd1', { cacheDir: null });
    expect(r.id, '同批多命中 ⇒ 取列表更靠前者（否则并发会改变解析结果）').toBe('sr_c3');
  });

  it('并发下「拒绝原因」仍按候选顺序排列（证据可复核，不随完成顺序乱序）', async () => {
    const fx = manyCandidates(9, 8);
    const r = await resolveRun(tracked(port(fx), 2).port, 'd1', { concurrency: 4, cacheDir: null });
    expect(r.id).toBe('sr_c8');
    expect(r.evidence.rejected.map((x) => x.id)).toEqual(['sr_c0', 'sr_c1', 'sr_c2', 'sr_c3', 'sr_c4', 'sr_c5', 'sr_c6', 'sr_c7']);
  });
});

describe('裁决 3/E：解析结果**落盘缓存**（§7.2 修法 ③；命中仍须校验 run 存在）', () => {
  function cacheDir(): string {
    return mkdtempSync(join(tmpdir(), 'adr028-resolve-cache-'));
  }

  it('首次 = miss（写盘）；二次 = hit（不再全量重扫）；两次结果逐字段一致', async () => {
    const dir = cacheDir();
    const fx = manyCandidates(20, 19);
    const t1 = tracked(port(fx));
    const first = await resolveRun(t1.port, 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(first.evidence.cache?.status).toBe('miss');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length, '必须落盘 1 个缓存条目').toBe(1);
    const t2 = tracked(port(fx));
    const second = await resolveRun(t2.port, 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(second.evidence.cache?.status).toBe('hit');
    expect(second.evidence.cache?.validated, '命中仍须校验（run 存在 + 仍满足谓词）').toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.predicate).toBe(first.predicate);
    expect(second.totalBars).toBe(first.totalBars);
    expect(second.rtSeq).toBe(first.rtSeq);
    expect(t1.stats().calls.totalBars, '首次：每个候选 1 次 per_bar 取数').toBe(20);
    expect(t2.stats().calls.totalBars, '缓存命中：只校验命中者（≪ 全量）').toBeLessThanOrEqual(1);
    expect(t2.stats().calls.totalBars).toBeLessThan(t1.stats().calls.totalBars);
    expect(second.evidence.detail['endBar']).toBe(first.evidence.detail['endBar']);
  });

  it('缓存命中**仍须校验 run 存在**：条目指向的 run 不在库里 ⇒ 失效 + 重解析（禁静默使用旧 id）', async () => {
    const dir = cacheDir();
    const fx = manyCandidates(20, 19);
    await resolveRun(port(fx), 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    // 篡改缓存条目：把 id 改成库里**不存在**的 run（模拟库变更/缓存腐坏 —— 谓词命中谓词键不变）
    const file = join(dir, readdirSync(dir).filter((f) => f.endsWith('.json'))[0]!);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { resolved: { id: string } };
    raw.resolved.id = 'sr_ghost';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    const t = tracked(port(fx));
    const r = await resolveRun(t.port, 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(r.id, '不得返回缓存里的幽灵 run').toBe('sr_c19');
    expect(r.evidence.cache?.status, '必须记为失效（可复核），不得静默').toBe('invalidated');
    expect(String(r.evidence.cache?.reason ?? '')).toMatch(/不存在|不在/);
    expect(t.stats().calls.totalBars, '失效后必须**真的重解析**（回到全量扫描）').toBe(20);
  });

  it('缓存命中仍须校验「仍满足谓词」：条目指向的 run 已不再命中 ⇒ 失效 + 重解析到当前命中者', async () => {
    const dir = cacheDir();
    const fx = manyCandidates(20, 19);
    await resolveRun(port(fx), 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    const file = join(dir, readdirSync(dir).filter((f) => f.endsWith('.json'))[0]!);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { resolved: { id: string } };
    // 库里把该 run 改成「不满足谓词」（第 16 笔不在末根），但**列表与指纹不变**（同一 id/created_at）
    raw.resolved.id = 'sr_c18';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    const r = await resolveRun(port(fx), 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(r.id).toBe('sr_c19');
    expect(r.evidence.cache?.status).toBe('invalidated');
    expect(String(r.evidence.cache?.reason ?? '')).toMatch(/谓词|l2_count|末根/);
  });

  it('库指纹变化（出现**更新的命中者**）⇒ 失效并解析到最新命中者（不得用旧缓存）', async () => {
    const dir = cacheDir();
    const older = manyCandidates(20, 19);
    const first = await resolveRun(port(older), 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(first.id).toBe('sr_c19');
    // 新增一个**更新**的命中 run（列表指纹随之变化）
    const newer = merge(older, d1Run('sr_newest', '2026-09-30T00:00:00Z'));
    const r = await resolveRun(port(newer), 'd1', { cacheDir: dir, sourceKey: 'fixture://a' });
    expect(r.id, '出现更新的命中者时必须重新解析（缓存不得变硬编码）').toBe('sr_newest');
    expect(r.evidence.cache?.status).toBe('miss');
  });

  it('`sourceKey` 不同（不同后端）⇒ 不得复用缓存', async () => {
    const dir = cacheDir();
    const fx = manyCandidates(20, 19);
    await resolveRun(port(fx), 'd1', { cacheDir: dir, sourceKey: 'http://localhost:4173' });
    const r = await resolveRun(port(fx), 'd1', { cacheDir: dir, sourceKey: 'http://localhost:8081' });
    expect(r.evidence.cache?.status).toBe('miss');
  });

  it('`cacheDir: null` ⇒ 完全关闭缓存（不落盘、状态 = disabled）', async () => {
    const fx = manyCandidates(4, 3);
    const r = await resolveRun(port(fx), 'd1', { cacheDir: null });
    expect(r.id).toBe('sr_c3');
    expect(r.evidence.cache?.status).toBe('disabled');
  });
});
