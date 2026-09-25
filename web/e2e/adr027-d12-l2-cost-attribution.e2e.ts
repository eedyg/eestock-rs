/**
 * **ADR-027 D12（L2 成本归属列）真渲染独立复验**（09-plan §4；契约 SSOT = 09-plan §4.2/§4.3）。
 *
 * 三件事只在本文件用**真浏览器 + 活库真实 run**回答（jsdom 组件测试回答不了）：
 *  ① 四个新列/改名列表头**真实存在于真身 DOM**（不是"没看到"）；
 *  ② **多笔买入 + 部分卖出**的真实回合上，`持仓成本` / `本笔卖出盈亏` / `累计已实现盈亏` 的**单元格文本**
 *     等于**独立算得**的期望值（不是复述 UI 自己的说法）；
 *  ③ 恒等式 **I5**（全平回合末笔「累计已实现盈亏」== L1 `pnl`）与 **I6①**（首笔卖出前买入行恒 0）在 UI 侧成立。
 *
 * ## 「第二实现」的证据口径（必读，回应 09-plan §5 的「规格内实现即为第二实现」）
 * 本文件的期望值**不是**把 `roundTripAccum.ts` 抄一遍，而是用**闭式**（closed form）算两处关键单元格——
 * 之所以可能用闭式，是因为谓词刻意只挑**首笔卖出之前全是买入**的回合：
 *  - `{s}` = 第一笔卖出的下标；`s` 之前全为 Buy ⇒
 *    首笔卖出前的**持仓含费单位成本**有闭式：`unitCost = Σ_{j<s}(trade_value_j + commission_j) / Σ_{j<s} qty_j`
 *    （**不依赖任何递推**，也**不含** FIFO 归属：FIFO 在此会给"某一批"的成本 ⇒ 数值必然不同 ⇒ 有鉴别力）；
 *  - 首笔卖出为**部分卖出**（谓词保证 `q_s < Σ_{j<s} qty_j`）⇒
 *    `sell_pnl = (trade_value_s − commission_s − stamp_duty_s) − q_s × unitCost`（闭式）;
 *  - `累计已实现盈亏` 在**首笔卖出行** = 该笔 `sell_pnl`（此前的买入行恒 0，I6①）；
 *  - `累计净现金流`（改名保留的原列）在任意行的值 = 事实字段逐笔累加的闭式
 *    `Σ买 −(tv+comm) + Σ卖 +(tv−comm−stamp)`（**一字不改**的旧算法）。
 * 三个独立权威锚点用于自校验第二实现：① 末行 `累计净现金流` == L1 `pnl`（对账口径）；
 * ② 末行 `累计已实现盈亏` == L1 `pnl`（I5，全平回合的数学必然）；③ 谓词保证末行持仓为 0。
 *
 * ## 判据鉴别力（**若 UI 回退为旧的净现金流口径，哪条断言会红**）
 *  - 旧口径下 `累计已实现盈亏` 列就是 `cum_cashflow`（首笔卖出前是**大额负数净投入**）：
 *    ⇒ `B2` 的「首笔卖出前买入行 == `0.00`」（I6①）**必红**（旧口径给 `-45343.95` 之类）；
 *    ⇒ `B2` 的「新列文本 ≠ 同行旧口径值」（显式对照 `wb-l2-cum-cashflow-*` 单元格）**必红**；
 *    ⇒ `B3` 的 I5（末行 == L1 `pnl`）在旧口径下**仍成立**（净现金流末值本就等于 `pnl`）⇒ **该条单独
 *      不足以判别**，故本文件把 I5 与前面两条**并列**，不单独依赖它（登记在案）。
 *  - 若 `本笔卖出盈亏` 回退为「净收入全额」（即越卖口径造数，2026-09-26 裁定 1 所禁）：
 *    ⇒ 期望值含 `−q_s×unitCost` 被消耗成本项 ⇒ `B2` 单元格逐字符比对**必红**。
 *  - 若列被删/改名回退（「累计盈亏」）：⇒ `B1` 表头存在性 + 文案断言**必红**。
 *  - 末尾**反证**：把 `wb-l2-sellpnl-*` 单元格文本改成 `'—'` 后再读 ⇒ 比对断言对**文本内容**敏感
 *    （证明不是只断言"元素存在"）。
 *
 * ## run/回合靶（**不硬编码**）
 * 就地按结构谓词解析：`period=D1 ∧ status=succeeded ∧ ∃ 回合(Closed ∧ buy_count ≥ 2 ∧ 首笔卖出且为部分卖出
 * ∧ 末笔后持仓 == 0 ∧ 首笔卖出前全为买入)`，`created_at` 倒序取第一个命中者（回合取该 run 内**首个命中**者）。
 * 全不命中 ⇒ 显式抛错（禁静默换 run / 禁跳过）。解析证据（扫描数 + 逐候选拒绝原因 + 逐回合事实）落盘。
 *
 * 证据落盘：`tester/evidence/20260925_d4b_render_verify/raw/`（**未跟踪**；`D4B_OUT` 可覆盖）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.D4B_OUT ?? resolve(REPO, 'tester/evidence/20260925_d4b_render_verify/raw');

function writeJson(name: string, data: unknown): string {
  mkdirSync(OUT, { recursive: true });
  const p = resolve(OUT, `${name}.json`);
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

// ───────────────────────────────────── 事实行 / 取数 ─────────────────────────────────────

interface Fill {
  bar_index: number;
  ts: number;
  side: 'Buy' | 'Sell' | string;
  qty: number;
  price: number;
  trade_value: number;
  commission: number;
  stamp_duty: number;
  rt_seq: number;
}

interface RtRow {
  rt_seq: number;
  status?: string;
  pnl?: number | null;
  l2_count?: number;
  buy_count?: number;
  sell_count?: number;
}

interface RunRow {
  id: string;
  period?: string;
  status?: string;
  symbol?: string;
  created_at?: string;
}

interface L2Target {
  id: string;
  rtSeq: number;
  fills: Fill[];
  rt: RtRow;
  predicate: string;
  scanned: number;
  rejected: Array<{ id: string; why: string }>;
  rtEvidence: Array<Record<string, unknown>>;
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const r = await page.request.get(url);
  expect(r.ok(), `${url} 必须可取（status=${r.status()}）`).toBeTruthy();
  return (await r.json()) as T;
}

/** 逐候选回合的结构核对（返回 `null` = 命中；字符串 = 拒绝原因）。 */
function inspectFills(fills: Fill[]): { s: number; why?: undefined } | { why: string } {
  if (fills.length < 3) return { why: `fills=${fills.length} < 3` };
  const s = fills.findIndex((f) => f.side !== 'Buy');
  if (s < 0) return { why: '无卖出行（不是「多笔买入 + 部分卖出」形态）' };
  if (s < 2) return { why: `首笔卖出下标 s=${s} < 2（首笔卖出前买入不足 2 笔 ⇒ 闭式期望无鉴别力）` };
  const preBuys = fills.slice(0, s);
  if (preBuys.some((f) => f.side !== 'Buy')) return { why: '首笔卖出之前存在非买入行（闭式前提不成立）' };
  const buyQty = preBuys.reduce((a, f) => a + f.qty, 0);
  if (!(fills[s]!.qty < buyQty - 1e-9 * Math.max(1, buyQty))) {
    return { why: `首笔卖出是**全平**（q=${fills[s]!.qty} ≥ 买入合计 ${buyQty}）⇒ 不是部分卖出` };
  }
  // 末笔后持仓 == 0（全平回合 ⇒ I5 适用）
  let q = 0;
  for (const f of fills) q += f.side === 'Buy' ? f.qty : -f.qty;
  if (Math.abs(q) > 1e-6 * Math.max(1, Math.abs(buyQty))) return { why: `末笔后持仓 ${q} ≠ 0（非全平回合 ⇒ I5 不适用）` };
  return { s };
}

async function resolveL2Target(page: Page): Promise<L2Target> {
  const predicate =
    'period=D1 ∧ status=succeeded ∧ ∃ 回合(Closed ∧ fills ≥ 3 ∧ 首笔卖出前全为买入且 ≥ 2 笔 ∧ 首笔卖出为部分卖出 ∧ 末笔后持仓 == 0)';
  const runs = await getJson<RunRow[]>(page, '/api/workbench/runs?limit=500');
  const cands = runs
    .filter((r) => r.period === 'D1' && r.status === 'succeeded')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const rejected: Array<{ id: string; why: string }> = [];
  let scanned = 0;
  for (const c of cands) {
    scanned += 1;
    let rts: RtRow[] = [];
    try {
      rts = (await getJson<{ round_trips?: RtRow[] }>(page, `/api/workbench/runs/${c.id}/round-trips?limit=500`)).round_trips ?? [];
    } catch (e) {
      rejected.push({ id: c.id, why: `/round-trips 取数失败：${(e as Error).message.slice(0, 60)}` });
      continue;
    }
    const rtEvidence: Array<Record<string, unknown>> = [];
    for (const rt of rts) {
      if ((rt.buy_count ?? 0) < 2 || (rt.sell_count ?? 0) < 1) {
        rtEvidence.push({ rt_seq: rt.rt_seq, why: `buy=${rt.buy_count} sell=${rt.sell_count}` });
        continue;
      }
      let fills: Fill[] = [];
      try {
        fills = (
          await getJson<{ fills?: Fill[] }>(page, `/api/workbench/runs/${c.id}/round-trips/${rt.rt_seq}/fills?limit=500`)
        ).fills ?? [];
      } catch (e) {
        rtEvidence.push({ rt_seq: rt.rt_seq, why: `fills 取数失败：${(e as Error).message.slice(0, 60)}` });
        continue;
      }
      const v = inspectFills(fills);
      if ('why' in v) {
        rtEvidence.push({ rt_seq: rt.rt_seq, why: v.why, fills: fills.length });
        continue;
      }
      return { id: c.id, rtSeq: rt.rt_seq, fills, rt, predicate, scanned, rejected: rejected.slice(-25), rtEvidence };
    }
    rejected.push({ id: c.id, why: `无合格回合（逐回合：${JSON.stringify(rtEvidence).slice(0, 220)}）` });
    if (scanned >= 25) break;
  }
  throw new Error(
    `[D4b] L2 靶解析失败：${predicate}；已扫 ${scanned} 个 D1/succeeded 候选，无一命中 ⇒ 显式红。` +
      `拒绝原因：${JSON.stringify(rejected.slice(-25))}`,
  );
}

// ───────────────────────────────────── 期望值（**独立闭式**） ─────────────────────────────────────

const fmtMoney2 = (v: number) => v.toFixed(2);
const fmtPrice3 = (v: number) => v.toFixed(3);
/** 与 UI 唯一格式出口同口径（09-plan §4.2：`+123.45 (+2.31%)`），但**数值由本地闭式给出**。 */
const fmtSellPnl = (pnl: number, pct: number | null) =>
  pct == null ? `${pnl >= 0 ? '+' : ''}${fmtMoney2(pnl)}` : `${pnl >= 0 ? '+' : ''}${fmtMoney2(pnl)} (${pct >= 0 ? '+' : ''}${fmtMoney2(pct * 100)}%)`;

interface Expectation {
  s: number;
  unitCost: number;
  sellPnl: number;
  sellPnlPct: number;
  consumed: number;
  cashflowCum: number[]; // 逐笔累计净现金流（闭式，旧口径）
  sellPnlText: string;
  costBeforeText: string;
  cumRealizedAtSText: string;
  cumCashflowAtSText: string;
  cumCashflowBeforeSText: string;
  lastCumRealizedPnl: number;
  lastCumCashflow: number;
}

/** 独立闭式期望（见文件头「第二实现」段；只用到谓词保证的前提）。 */
function expectations(fills: Fill[]): Expectation {
  const s = fills.findIndex((f) => f.side !== 'Buy');
  const pre = fills.slice(0, s);
  const qtyPre = pre.reduce((a, f) => a + f.qty, 0);
  const costPre = pre.reduce((a, f) => a + (f.trade_value + f.commission), 0);
  const unitCost = costPre / qtyPre;
  const sellRow = fills[s]!;
  const netIncome = sellRow.trade_value - sellRow.commission - sellRow.stamp_duty;
  const sellPnl = netIncome - sellRow.qty * unitCost;
  const consumed = sellRow.qty * unitCost;
  const sellPnlPct = consumed > 0 ? sellPnl / consumed : null;
  const cashflowCum: number[] = [];
  let cf = 0;
  for (const f of fills) {
    cf += f.side === 'Buy' ? -(f.trade_value + f.commission) : f.trade_value - f.commission - f.stamp_duty;
    cashflowCum.push(cf);
  }
  return {
    s,
    unitCost,
    sellPnl,
    sellPnlPct: sellPnlPct ?? 0,
    consumed,
    cashflowCum,
    sellPnlText: fmtSellPnl(sellPnl, sellPnlPct),
    costBeforeText: fmtPrice3(unitCost),
    cumRealizedAtSText: fmtMoney2(sellPnl),
    cumCashflowAtSText: fmtMoney2(cashflowCum[s]!),
    cumCashflowBeforeSText: fmtMoney2(cashflowCum[s - 1]!),
    lastCumRealizedPnl: NaN, // 由 I5 处用 L1 pnl 校验
    lastCumCashflow: cashflowCum[cashflowCum.length - 1]!,
  };
}

// ───────────────────────────────────── 打开 run + 展开 L2 ─────────────────────────────────────

async function openRunAndExpandL2(page: Page, runId: string, rtSeq: number): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  for (let i = 0; i < 30 && (await sel.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await page.getByTestId('wb-tab-trades').click();
  const detail = page.getByTestId(`wb-rt-detail-${rtSeq}`);
  await detail.scrollIntoViewIfNeeded();
  await detail.click();
  await expect(page.getByTestId(`wb-l2-row-${rtSeq}-0`)).toBeVisible();
  await expect(page.getByTestId(`wb-l2-th-cum-cashflow-${rtSeq}`)).toBeVisible();
}

test.describe('ADR-027 D12｜L2 成本归属列（真渲染）', () => {
  test('B1：四个新列/改名列表头真实存在', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveL2Target(page);
    writeJson('b_target', {
      runId: target.id,
      rtSeq: target.rtSeq,
      fills: target.fills.length,
      predicate: target.predicate,
      scanned: target.scanned,
      rejected: target.rejected,
      rt: target.rt,
    });
    await openRunAndExpandL2(page, target.id, target.rtSeq);

    const rt = target.rtSeq;
    const headers: Array<[string, string]> = [
      [`wb-l2-th-cost-${rt}`, '持仓成本'],
      [`wb-l2-th-sellpnl-${rt}`, '本笔卖出盈亏'],
      [`wb-l2-th-cum-realized-pnl-${rt}`, '累计已实现盈亏'],
      [`wb-l2-th-cum-cashflow-${rt}`, '累计净现金流'],
    ];
    const seen: Record<string, string> = {};
    for (const [testid, want] of headers) {
      const el = page.getByTestId(testid);
      await expect(el, `表头 ${testid} 必须存在`).toBeVisible();
      const text = ((await el.textContent()) ?? '').trim();
      seen[testid] = text;
      expect(text, `表头 ${testid} 文案`).toBe(want);
    }
    // 旧列名「累计盈亏」不得再出现为表头（改名生效）
    const theadText = (await page.locator(`[data-testid="wb-l2-row-${rt}-0"]`).evaluate((el) => el.closest('table')?.querySelector('thead')?.textContent ?? '')) as string;
    expect(theadText, '表头不得再出现裸用的「累计盈亏」').not.toContain('累计盈亏');
    writeJson('b1_headers', { runId: target.id, rtSeq: rt, headers: seen, theadText });

    // 反证：把卖出行单元格改成 '—' 后，B2 的文本比对必须变红（证明对**文本内容**敏感）
    const firstSell = target.fills.findIndex((f) => f.side !== 'Buy');
    const cell = page.getByTestId(`wb-l2-sellpnl-${rt}-${firstSell}`);
    const before = ((await cell.textContent()) ?? '').trim();
    await cell.evaluate((el) => {
      el.textContent = '—';
    });
    const after = ((await cell.textContent()) ?? '').trim();
    const exp = expectations(target.fills);
    writeJson('b1_text_sensitivity', {
      cell: `wb-l2-sellpnl-${rt}-${firstSell}`,
      originalText: before,
      afterForcedDash: after,
      independentExpected: exp.sellPnlText,
      textComparisonWouldFail: after !== exp.sellPnlText,
    });
    expect(before, '反证前单元格文本必须 == 独立期望（否则本反证无意义）').toBe(exp.sellPnlText);
    expect(after, '反证后（强制 —）文本必须不再等于独立期望 ⇒ 比对断言有鉴别力').not.toBe(exp.sellPnlText);
  });

  test('B2：部分卖出回合的单元格文本 == 独立闭式期望；新列 ≠ 旧口径', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const target = await resolveL2Target(page);
    await openRunAndExpandL2(page, target.id, target.rtSeq);

    const rt = target.rtSeq;
    const fills = target.fills;
    const exp = expectations(fills);
    const read = async (id: string) => ((await page.getByTestId(id).textContent()) ?? '').trim();

    // ── ① 买出行 `本笔卖出盈亏` = `—` ──
    const buyIdx = Array.from({ length: Math.min(exp.s, 6) }, (_, i) => i);
    const buyCells = await Promise.all(buyIdx.map((i) => read(`wb-l2-sellpnl-${rt}-${i}`)));
    expect(buyCells, `买出行 ${JSON.stringify(buyIdx)} 的「本笔卖出盈亏」必须为 —`).toEqual(buyIdx.map(() => '—'));
    // 全平后（末行）亦无持仓 ⇒ 持仓成本 —
    const lastIdx = fills.length - 1;
    expect(await read(`wb-l2-cost-${rt}-${lastIdx}`), '末笔（全平后）持仓成本必须为 —').toBe('—');

    // ── ② 两处「数值」单元格逐字符比对（独立闭式） ──
    const gotCostBefore = await read(`wb-l2-cost-${rt}-${exp.s - 1}`);
    const gotSellPnl = await read(`wb-l2-sellpnl-${rt}-${exp.s}`);
    const gotCumRealizedAtS = await read(`wb-l2-cum-realized-pnl-${rt}-${exp.s}`);
    const gotCumCashflowAtS = await read(`wb-l2-cum-cashflow-${rt}-${exp.s}`);
    const gotCumRealizedBeforeS = await read(`wb-l2-cum-realized-pnl-${rt}-${exp.s - 1}`);

    const detail = {
      runId: target.id,
      rtSeq: rt,
      fills: fills.length,
      firstSellIndex: exp.s,
      unitCostIndependent: exp.unitCost,
      consumedCost: exp.consumed,
      sellPnlIndependent: exp.sellPnl,
      sellPnlPctIndependent: exp.sellPnlPct,
      cells: {
        costBefore: { testid: `wb-l2-cost-${rt}-${exp.s - 1}`, expected: exp.costBeforeText, got: gotCostBefore },
        sellPnlAtS: { testid: `wb-l2-sellpnl-${rt}-${exp.s}`, expected: exp.sellPnlText, got: gotSellPnl },
        cumRealizedAtS: {
          testid: `wb-l2-cum-realized-pnl-${rt}-${exp.s}`,
          expected: exp.cumRealizedAtSText,
          got: gotCumRealizedAtS,
        },
        cumCashflowAtS: {
          testid: `wb-l2-cum-cashflow-${rt}-${exp.s}`,
          expected: exp.cumCashflowAtSText,
          got: gotCumCashflowAtS,
        },
        cumRealizedBeforeS: {
          testid: `wb-l2-cum-realized-pnl-${rt}-${exp.s - 1}`,
          expected: '0.00',
          got: gotCumRealizedBeforeS,
        },
        cumCashflowBeforeS: {
          testid: `wb-l2-cum-cashflow-${rt}-${exp.s - 1}`,
          expected: exp.cumCashflowBeforeSText,
          got: await read(`wb-l2-cum-cashflow-${rt}-${exp.s - 1}`),
        },
      },
    };
    writeJson('b2_cells', detail);

    expect(
      gotCostBefore,
      `第 ${exp.s - 1} 行（首笔卖出前一笔）「持仓成本」必须 == 独立闭式 Σ(tv+comm)/Σqty = ${exp.unitCost} ⇒ 文本 ${exp.costBeforeText}（实得 ${gotCostBefore}）`,
    ).toBe(exp.costBeforeText);
    expect(
      gotSellPnl,
      `第 ${exp.s} 行「本笔卖出盈亏」必须 == 独立闭式 净收入 − q×unitCost = ${exp.sellPnl} ⇒ 文本 ${exp.sellPnlText}（实得 ${gotSellPnl}）`,
    ).toBe(exp.sellPnlText);
    expect(
      gotCumRealizedAtS,
      `第 ${exp.s} 行「累计已实现盈亏」必须 == 该笔 sell_pnl（此前买入行恒 0）⇒ ${exp.cumRealizedAtSText}（实得 ${gotCumRealizedAtS}）`,
    ).toBe(exp.cumRealizedAtSText);
    expect(
      gotCumCashflowAtS,
      `第 ${exp.s} 行「累计净现金流」必须 == 事实字段闭式累加 ${exp.cumCashflowAtSText}（实得 ${gotCumCashflowAtS}）`,
    ).toBe(exp.cumCashflowAtSText);

    // ── ③ I6①：首笔卖出**之前**所有买入行 `累计已实现盈亏` == 0.00；且买入不改变累计 ──
    const preIdx = Array.from({ length: exp.s }, (_, i) => i);
    const preCells = await Promise.all(preIdx.map((i) => read(`wb-l2-cum-realized-pnl-${rt}-${i}`)));
    expect(
      preCells,
      `I6①：首笔卖出（下标 ${exp.s}）之前的买入行「累计已实现盈亏」必须全为 0.00（旧净现金流口径在此是大额负数 ⇒ 本断言即鉴别力）`,
    ).toEqual(preIdx.map(() => '0.00'));
    // I6②：买入不改变累计 ⇒ 首笔卖出之后的买入行值 == 其前一笔的值
    const afterBuys = fills.map((f, i) => (f.side === 'Buy' && i > exp.s ? i : -1)).filter((i) => i >= 0);
    for (const i of afterBuys.slice(0, 5)) {
      expect(
        await read(`wb-l2-cum-realized-pnl-${rt}-${i}`),
        `I6②：买入不改变累计 ⇒ 第 ${i} 行值必须 == 第 ${i - 1} 行值`,
      ).toBe(await read(`wb-l2-cum-realized-pnl-${rt}-${i - 1}`));
    }
    (detail as Record<string, unknown>)['i6'] = {
      preFirstSellAllZero: preCells,
      afterBuyIndices: afterBuys.slice(0, 5),
    };

    // ── ④ 鉴别力对照：新列 ≠ 旧的净现金流口径（同行显式对照） ──
    const contrast = {
      rowBeforeS: {
        row: exp.s - 1,
        newCumRealized: gotCumRealizedBeforeS,
        oldCashflow: (await read(`wb-l2-cum-cashflow-${rt}-${exp.s - 1}`)),
      },
      rowS: { row: exp.s, newCumRealized: gotCumRealizedAtS, oldCashflow: gotCumCashflowAtS },
      lastRow: {
        row: lastIdx,
        newCumRealized: await read(`wb-l2-cum-realized-pnl-${rt}-${lastIdx}`),
        oldCashflow: await read(`wb-l2-cum-cashflow-${rt}-${lastIdx}`),
      },
    };
    (detail as Record<string, unknown>)['oldVsNewContrast'] = contrast;
    expect(
      contrast.rowBeforeS.newCumRealized,
      `首笔卖出前买入行：新口径（已实现盈亏）必须 ≠ 旧口径（净现金流）—— 若 UI 回退为旧口径，本条必红`,
    ).not.toBe(contrast.rowBeforeS.oldCashflow);
    expect(
      contrast.rowS.newCumRealized,
      `首笔卖出行：新口径必须 ≠ 旧口径 —— 若 UI 回退为旧口径，本条必红（旧值 ${exp.cumCashflowAtSText}）`,
    ).not.toBe(contrast.rowS.oldCashflow);
    expect(
      contrast.rowS.oldCashflow,
      '改名后的「累计净现金流」必须一字不改地保留旧算法（值 = 事实字段闭式累加）',
    ).toBe(exp.cumCashflowAtSText);

    // ── ⑤ 卖出行格式形如 `+x.xx (+y.yy%)` ──
    const sellIdx = fills.map((f, i) => (f.side !== 'Buy' ? i : -1)).filter((i) => i >= 0);
    const sellTexts = await Promise.all(sellIdx.map((i) => read(`wb-l2-sellpnl-${rt}-${i}`)));
    const bad = sellTexts.filter((t) => !/^[+-]\d+\.\d{2} \([+-]\d+\.\d{2}%\)$/.test(t));
    expect(bad, `卖出行文本必须形如 +123.45 (+2.31%)（不符：${JSON.stringify(bad)}）`).toEqual([]);
    (detail as Record<string, unknown>)['sellRowTexts'] = sellIdx.map((i, k) => ({ row: i, text: sellTexts[k] }));

    // ── ⑥ I5：全平回合末行「累计已实现盈亏」== L1 盈亏（容差 = 显示精度 0.005） ──
    const l1Text = await read(`wb-rt-pnl-${rt}`);
    const lastRealizedText = await read(`wb-l2-cum-realized-pnl-${rt}-${lastIdx}`);
    const lastCashflowText = await read(`wb-l2-cum-cashflow-${rt}-${lastIdx}`);
    (detail as Record<string, unknown>)['i5'] = {
      l1PnlText: l1Text,
      l2LastCumRealizedText: lastRealizedText,
      l2LastCumCashflowText: lastCashflowText,
      l1PnlRaw: target.rt.pnl,
      independentGap: Math.abs(exp.lastCumCashflow - (target.rt.pnl ?? NaN)),
    };
    expect(l1Text, 'L1 盈亏必须可读').not.toBe('—');
    expect(
      lastRealizedText,
      `I5：全平回合末行「累计已实现盈亏」文本必须 == L1「盈亏」文本（容差 = 显示精度；L1=${l1Text}，L2末行=${lastRealizedText}）`,
    ).toBe(l1Text);
    expect(
      Number(lastCashflowText),
      `改名后的「累计净现金流」末行必须 == L1 盈亏（显示精度内；L1=${l1Text}）`,
    ).toBeCloseTo(Number(l1Text), 2);
    expect(
      Math.abs(exp.lastCumCashflow - (target.rt.pnl ?? NaN)),
      '第二实现自校验：闭式累计净现金流末值必须 == L1 pnl（相对容差 1e-6）',
    ).toBeLessThan(1e-6 * Math.max(1, Math.abs(target.rt.pnl ?? 1)));

    writeJson('b2_cells', detail);
  });
});
