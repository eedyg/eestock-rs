/**
 * ADR-029 **Step 1.5**（Web 侧）真渲染 E2E：`ramp.RateCap` 的非对称下行速率 / `on_signal_break`、
 * `guard.deadzone_min_notional` + **结果页三层读数（意图 / 输出目标 / 当前持仓）与审计 `exposure` 段**。
 *
 * 契约事实源：
 *  - `design/12-strategy-system/06-plan-exposure-step1_5.md` §2.1（JSON 形态）/§2.5（死区是意图 gap 门）/
 *    §2.6（`intent_pct` + `down_ramp_cap_pct_per_bar` 两观测键）/§3.1（审计 `exposure` 段 17 键）/§5 Lane C
 *  - `design/01-architecture/adr/ADR-029-execution-policy-exposure-ramp-guard.md` §8（D11–D15）
 *
 * 边界（诚实声明，勿当绿读）：**本规格不含任何 skip**。若后端尚未重建（`RateCap` 载荷的新字段被 serde
 * 忽略、`per_bar` 无 `intent_pct`、`/audit` 无 `exposure` 段）⇒ 用例**必须红**，且原始请求/响应已落盘
 * （`OUT` 下的 JSON + 截图）。这正是「阻塞：待后端重建」的证据，**不得**用弱断言/删用例掩盖。
 *
 * testid 口径（R26 唯一性纪律）：配置侧 = `wb-exposure-*`（ConfigPanel）；结果侧 = `wb-result-exposure-*`
 * （`wb-exposure-observed|unrecorded|score-note` 为结果侧**历史命名**，与配置侧互不重名）。
 *
 * 沙箱（不写 web/dist；本规格经 `vite preview` 以生产构建产物真跑，`/api` 代理到真实后端）：
 *   cd web && npx vite build --outDir /tmp/adr029c_web
 *   VITE_PROXY_TARGET=http://127.0.0.1:8081 npx vite preview --outDir /tmp/adr029c_web --port 4173
 *   E2E_BASE_URL=http://127.0.0.1:4173 E2E_EVIDENCE_DIR=<未跟踪目录> \
 *     npx playwright test e2e/adr029-step1_5-exposure.e2e.ts
 *
 * 证据出口：`E2E_EVIDENCE_DIR`（默认 = **未跟踪**目录 `coder/evidence/20260929_adr029_step1_5_laneC/raw/e2e`）
 * —— 禁硬编码到任何**已跟踪**目录（AGENTS.md 2026-09-23 登记：e2e 证据落盘不得污染已跟踪文件）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 默认出口 = 未跟踪目录（`coder/evidence/` 已 .gitignore） */
const OUT = process.env.E2E_EVIDENCE_DIR
  ? resolve(process.env.E2E_EVIDENCE_DIR, 'adr029_step1_5')
  : resolve(REPO, 'coder/evidence/20260929_adr029_step1_5_laneC/raw/e2e');
const TAG = process.env.ADR029_E2E_TAG ?? 's15';

interface Obs {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  runPosts: Array<{ status: number; body: string }>;
}

function attachObservers(page: Page): Obs {
  const obs: Obs = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
    runPosts: [],
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') obs.consoleErrors.push(`[error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => obs.pageErrors.push(String(err)));
  page.on('requestfailed', (req) =>
    obs.failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? 'unknown'}`),
  );
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400) obs.httpErrors.push(`${res.status()} ${res.request().method()} ${url}`);
    if (res.request().method() === 'POST' && /\/api\/workbench\/runs(\?|$)/.test(url)) {
      void res
        .text()
        .then((body) => obs.runPosts.push({ status: res.status(), body }))
        .catch(() => obs.runPosts.push({ status: res.status(), body: '<unreadable>' }));
    }
  });
  return obs;
}

function dump(name: string, obs: Obs, extra: Record<string, unknown> = {}): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, `${TAG}_${name}.json`),
    JSON.stringify({ tag: TAG, name, ...extra, ...obs }, null, 2),
    'utf8',
  );
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, `${TAG}_${name}.png`) });
}

async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  await expect(page.getByTestId('wb-add-strategy').locator('option')).not.toHaveCount(1);
}

async function addFirstStrategy(page: Page): Promise<void> {
  const select = page.getByTestId('wb-add-strategy');
  const firstValue = await select.locator('option').nth(1).getAttribute('value');
  expect(firstValue, 'catalog 至少得有 1 个 published 策略').toBeTruthy();
  await select.selectOption(firstValue!);
  await page.getByTestId('wb-add-btn').click();
  await expect(page.getByTestId(`slot-card-${firstValue}`)).toBeVisible();
}

async function setNum(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await expect(el).toHaveValue(value);
}

test.describe('ADR-029 Step 1.5（Web 侧）：新字段配置 / 成本提示 / 披露真渲染', () => {
  test('① 配置面板：RateCap 两新控件 + 成本提示一键预填 + 新字段校验 fail loud（不发请求）', async ({ page }) => {
    const obs = attachObservers(page);
    await openWorkbench(page);
    await addFirstStrategy(page);
    await page.getByTestId('wb-policy-kind').selectOption('Exposure');
    // 默认 = RateCap ⇒ 两新控件可见；`on_signal_break` 默认 `Continue`（用户裁定：新配置显式写入）
    await expect(page.getByTestId('wb-ramp-kind')).toHaveValue('RateCap');
    await expect(page.getByTestId('wb-exposure-down-pct-per-bar')).toBeVisible();
    await expect(page.getByTestId('wb-exposure-on-signal-break')).toHaveValue('Continue');
    await expect(page.getByTestId('wb-exposure-deadzone-min-notional')).toHaveValue('');
    // §2.5 注（量纲披露）：死区是意图 gap 门、不是订单规模下限
    await expect(page.getByTestId('wb-exposure-deadzone-note')).toContainText('意图 gap 门');
    await expect(page.getByTestId('wb-exposure-deadzone-note')).toContainText('不是订单规模下限');
    // `Immediate` 无路径状态可暂停 ⇒ 两 RateCap 专有控件消失（不得留「死开关」）
    await page.getByTestId('wb-ramp-kind').selectOption('Immediate');
    await expect(page.getByTestId('wb-exposure-down-pct-per-bar')).toHaveCount(0);
    await expect(page.getByTestId('wb-exposure-on-signal-break')).toHaveCount(0);
    await page.getByTestId('wb-ramp-kind').selectOption('RateCap');
    await expect(page.getByTestId('wb-exposure-on-signal-break')).toBeVisible();

    // D14 成本提示：默认（死区 0.5% × 10 万 = 500 元 ≥ 20×5 = 100 元）⇒ 不提示
    await expect(page.getByTestId('wb-exposure-cost-hint')).toHaveCount(0);
    await setNum(page, 'wb-initial-capital', '10000'); // 门槛 50 元 < 100 元 ⇒ 提示
    const hint = page.getByTestId('wb-exposure-cost-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('由 min_fee 主导');
    await expect(hint).toContainText('10.0%'); // 单笔佣金占比 = 5 / 50
    await page.getByTestId('wb-exposure-cost-prefill').click();
    await expect(page.getByTestId('wb-exposure-deadzone-min-notional')).toHaveValue('100'); // 20 × min_fee

    // 校验（与后端 fail loud 对齐）：down_pct_per_bar < 0 ⇒ 拦截且零请求；文案须带量纲
    await setNum(page, 'wb-exposure-down-pct-per-bar', '-0.1');
    await page.getByTestId('wb-submit').click();
    await expect(page.getByTestId('wb-form-error')).toContainText('down_pct_per_bar');
    await expect(page.getByTestId('wb-form-error')).toContainText('下行不限速');
    expect(obs.runPosts.length, '前端校验失败时不得发出 POST /runs').toBe(0);
    // deadzone_min_notional < 0 ⇒ 拦截且零请求；文案须带**元**
    await setNum(page, 'wb-exposure-down-pct-per-bar', '0.2');
    await setNum(page, 'wb-exposure-deadzone-min-notional', '-1');
    await page.getByTestId('wb-submit').click();
    await expect(page.getByTestId('wb-form-error')).toContainText('deadzone_min_notional');
    await expect(page.getByTestId('wb-form-error')).toContainText('元');
    expect(obs.runPosts.length).toBe(0);

    await shot(page, '01_panel_new_fields');
    dump('01_panel_new_fields', obs, {
      formError: await page.getByTestId('wb-form-error').innerText(),
      costHint: await hint.innerText(),
    });
  });

  test('② 新字段真提交 ⇒ 后端回读一致 + per_bar 新键 + 审计 exposure 段 + 结果页三层读数上屏', async ({ page }) => {
    test.setTimeout(150_000);
    const obs = attachObservers(page);
    await openWorkbench(page);
    await addFirstStrategy(page);
    // 窗口必须覆盖一次金叉（Buy）：catalog 首个 published（双均线）聚合分只在金叉 bar 取 80，
    // 而阈值契约要求 buy>50 ∧ sell<50 ⇒ 否则 in-range 只有 {20,50}，结构性 0 挂单（R26「空壳通过」根因）。
    await page.getByTestId('wb-date-from').fill('2026-02-05');
    await page.getByTestId('wb-date-to').fill('2026-03-01');
    await page.getByTestId('wb-policy-kind').selectOption('Exposure');
    await page.getByTestId('wb-exposure-target').selectOption('ScoreMapped');
    await page.getByTestId('wb-ramp-kind').selectOption('RateCap');
    // Step 1.5 三字段：非对称下行速率 + 信号中断 Continue + 死区金额门槛（元）
    await setNum(page, 'wb-exposure-down-pct-per-bar', '0.2');
    await page.getByTestId('wb-exposure-on-signal-break').selectOption('Continue');
    await setNum(page, 'wb-exposure-deadzone-min-notional', '100');
    await page.getByTestId('wb-submit').click();

    await expect
      .poll(() => obs.runPosts.length, { timeout: 60_000, message: '必须观察到 POST /api/workbench/runs' })
      .toBeGreaterThan(0);
    const post = obs.runPosts[0]!;
    expect(post.status, `POST /runs 应 201，实得 ${post.status}: ${post.body.slice(0, 300)}`).toBe(201);
    const runId = (JSON.parse(post.body) as { id: string }).id;
    await expect
      .poll(
        async () => ((await (await page.request.get(`/api/workbench/runs/${runId}`)).json()) as { status: string }).status,
        { timeout: 90_000, message: 'run 必须到达 succeeded' },
      )
      .toBe('succeeded');

    // ① 后端回读：三新字段**逐值**落在钉住 config 上（旧后端 serde 忽略未知字段 ⇒ 本断言红 = 待重建证据）
    const runBody = (await (await page.request.get(`/api/workbench/runs/${runId}`)).json()) as {
      config: { policy: { Exposure: { ramp: { RateCap: Record<string, unknown> }; guard: Record<string, unknown> } } };
    };
    const rc = runBody.config.policy.Exposure.ramp.RateCap;
    const guard = runBody.config.policy.Exposure.guard;
    expect.soft(rc.down_pct_per_bar, 'RateCap.down_pct_per_bar 必须逐值回读').toBe(0.2);
    expect.soft(rc.on_signal_break, 'RateCap.on_signal_break 必须逐值回读（Continue）').toBe('Continue');
    expect.soft(rc.pct_per_bar).toBe(0.05);
    expect.soft(guard.deadzone_min_notional, 'guard.deadzone_min_notional 必须逐值回读（元）').toBe(100);

    // ② `per_bar` 真值：新增两观测键（`intent_pct` / `down_ramp_cap_pct_per_bar`）
    const barsBody = (await (
      await page.request.get(`/api/workbench/runs/${runId}/bars?kind=per_bar&offset=0&limit=5000`)
    ).json()) as {
      bars: Array<{
        signal: string;
        warmup?: boolean;
        intent_pct?: number | null;
        target_pct?: number | null;
        current_pct?: number | null;
        down_ramp_cap_pct_per_bar?: number | null;
        orders?: unknown[];
      }>;
    };
    const inRange = barsBody.bars.filter((b) => !b.warmup);
    const withIntent = inRange.filter((b) => typeof b.intent_pct === 'number');
    const withDownCap = inRange.filter((b) => typeof b.down_ramp_cap_pct_per_bar === 'number');
    expect.soft(inRange.length, 'in-range bar 数须 > 0').toBeGreaterThan(0);
    expect
      .soft(withIntent.length, `in-range bar 必须带 intent_pct（实得 ${withIntent.length}/${inRange.length}）`)
      .toBeGreaterThan(0);
    expect
      .soft(withDownCap.length, `in-range bar 必须带 down_ramp_cap_pct_per_bar（实得 ${withDownCap.length}/${inRange.length}）`)
      .toBeGreaterThan(0);
    // 非对称直接可辨：下行预算 0.2 > 上行 0.05（缺省对称时为相等 ⇒ 该断言对「新字段被忽略」敏感）
    expect.soft(withDownCap[0]?.down_ramp_cap_pct_per_bar, '下行预算须 = down_pct_per_bar=0.2').toBe(0.2);
    expect.soft(inRange.some((b) => (b.orders?.length ?? 0) > 0), 'in-range 必须挂单 ≥1 笔（空壳判据）').toBe(true);

    // ③ `/audit` 结构化 `exposure` 段（17 键；追加在 warnings 之后）
    const auditBody = (await (await page.request.get(`/api/workbench/runs/${runId}/audit`)).json()) as {
      warnings: Array<{ code: string }>;
      exposure?: Record<string, number | null> | null;
    };
    const seg = auditBody.exposure ?? null;
    expect.soft(auditBody.exposure !== undefined, '/audit 响应必须含 `exposure` 键（非 Exposure/无观测 ⇒ null）').toBe(true);
    expect.soft(seg, 'Exposure run 的 `exposure` 段不得为 null（有观测）').not.toBeNull();
    if (seg) {
      expect.soft(Object.keys(seg).length, `exposure 段须为 17 键（实得 ${Object.keys(seg).join(',')}）`).toBe(17);
      expect.soft(typeof seg.max_target_gap, 'max_target_gap（执行层）必须可读').toBe('number');
      expect.soft(typeof seg.bars, 'bars 必须可读').toBe('number');
      expect.soft('unmet_intent_bars' in seg, 'unmet_intent_bars 键必须存在（无数据 ⇒ null）').toBe(true);
      expect.soft('cost_amplification' in seg, 'cost_amplification 键必须存在').toBe(true);
      // 阶段 2（本 run 有意图数据 ⇒ 意图层口径**必须有数值**，不得为 null）
      expect
        .soft(typeof seg.max_intent_gap, `max_intent_gap 须为数值（该 run 有 intent_pct 观测），实得 ${seg.max_intent_gap}`)
        .toBe('number');
      expect.soft(seg.max_intent_gap! > 0.05, `max_intent_gap=${seg.max_intent_gap} 须 > 阈值 0.05（Continue 下未走完段）`).toBe(
        true,
      );
      expect.soft(typeof seg.unmet_intent_bars, `unmet_intent_bars 须为数值，实得 ${seg.unmet_intent_bars}`).toBe('number');
      expect.soft(seg.unmet_intent_bars! > 0, `unmet_intent_bars=${seg.unmet_intent_bars} 须 > 0（= 路径未走完的 bar 数）`).toBe(
        true,
      );
      expect.soft(seg.rate_limited_bars! > 0, `rate_limited_bars=${seg.rate_limited_bars} 须 > 0（ramp 生效）`).toBe(true);
      expect.soft(typeof seg.cost_amplification, 'cost_amplification 须为数值（有成交额）').toBe('number');
    }
    // ③′ 新告警码经**既有 `warnings[]`** 到达（"确认能显示"）：意图层未达成必报 EXPOSURE_UNMET_INTENT
    const warnCodes = (auditBody.warnings ?? []).map((w) => w.code);
    expect
      .soft(warnCodes, `新告警码必须经既有 warnings[] 到达：${JSON.stringify(warnCodes)}`)
      .toContain('EXPOSURE_UNMET_INTENT');
    expect.soft(warnCodes.some((c) => c.startsWith('EXPOSURE_')), '至少一条 EXPOSURE_* 告警').toBe(true);

    // ③″ **路径语义端到端可见**（本批核心验收）：Buy 之后信号转 Hold（无新声明），
    //     `on_signal_break=Continue` ⇒ 输出目标**继续**逼近意图（限速逐 bar 推进），而意图在 Hold 带沿用不重算。
    //     变异反证：把该字段改成 `Pause` ⇒ 目标冻结在 Buy bar 的 0.05（同窗口实测），`lastTail.target_pct > buyTarget` 必红。
    const buyIdx = inRange.findIndex((b) => b.signal === 'Buy');
    expect.soft(buyIdx, 'in-range 必须出现 Buy（空壳判据）').toBeGreaterThanOrEqual(0);
    const buyBar = buyIdx >= 0 ? inRange[buyIdx]! : null;
    const tail = buyIdx >= 0 ? inRange.slice(buyIdx + 1).filter((b) => b.signal === 'Hold') : [];
    expect.soft(tail.length, 'Buy 之后必须有 Hold bar（信号中断点，F2 场景）').toBeGreaterThan(0);
    const lastTail = tail.length > 0 ? tail[tail.length - 1]! : null;
    if (buyBar && lastTail) {
      expect.soft(buyBar.intent_pct, 'Buy bar 意图 = ScoreMapped(score=80) ⇒ 35%').toBeCloseTo(0.35, 2);
      expect.soft(buyBar.target_pct, 'Buy bar 输出目标被上行预算压在 5%').toBeCloseTo(0.05, 2);
      expect.soft(buyBar.rate_limited, 'Buy bar 确实被限速（ramp 生效）').toBe(true);
      expect
        .soft(
          lastTail.target_pct! > buyBar.target_pct! + 0.05,
          `Continue ⇒ 中立带继续推进：目标 ${buyBar.target_pct} → ${lastTail.target_pct}（Pause 下会冻在 0.05）`,
        )
        .toBe(true);
      expect
        .soft(
          tail.every((b) => b.intent_pct === buyBar.intent_pct),
          '意图在 Hold 带沿用上一非 Hold bar（不因净值漂移重算）',
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(lastTail.intent_pct! - lastTail.target_pct!) < Math.abs(buyBar.intent_pct! - buyBar.target_pct!) - 0.05,
          `差距在收敛：|intent−target| ${Math.abs(buyBar.intent_pct! - buyBar.target_pct!)} → ${Math.abs(
            lastTail.intent_pct! - lastTail.target_pct!,
          )}`,
        )
        .toBe(true);
    }

    // ④ 结果页披露上屏（三层读数 + 审计段三态之一）
    await page.getByTestId('wb-tab-metrics').click();
    const box = page.getByTestId('wb-result-exposure-disclosure');
    await expect(box, '结果侧披露必须唯一命中（不得与配置侧同名）').toHaveCount(1);
    const readings = page.getByTestId('wb-result-exposure-readings');
    await expect(readings, '三层读数必须上屏（intent/target/current 同时披露）').toHaveCount(1);
    const readingsText = await readings.innerText();
    expect.soft(readingsText).toContain('意图');
    expect.soft(readingsText).toContain('输出目标');
    expect.soft(readingsText).toContain('当前持仓');
    expect.soft(readingsText, 'F1 修复：意图读数不得是「未记录」').not.toContain('未记录（该 run 的 per_bar 无 intent_pct');
    // 审计段：要么渲染结构化读数，要么显式「未记录」（不得两者皆无 = 静默）。
    // **同步纪律（2026-09-29 修）**：`/audit` 是异步取数 ⇒ 首次尝试时只可能命中 `…-audit-loading`。
    // 本断言必须等**落定**再用 **web-first 重试断言**验「恰好一种表达」——判据不变，只消除竞态
    // （阶段 2 首跑实测：一次性 `count()` 在 loading 窗口里采到 0 ⇒ flaky；非放宽）。
    const auditBox = page.getByTestId('wb-result-exposure-audit');
    const auditUnrecorded = page.getByTestId('wb-result-exposure-audit-unrecorded');
    const auditLoading = page.getByTestId('wb-result-exposure-audit-loading');
    await expect.poll(async () => ((await auditLoading.count()) > 0 ? 'loading' : 'settled'), {
      timeout: 30_000,
      message: '审计 exposure 段必须离开 loading 态',
    }).toBe('settled');
    await expect(
      auditBox.or(auditUnrecorded),
      '审计 exposure 段必须恰好有一种表达（读数 / 未记录）',
    ).toHaveCount(1);
    const auditText = (await auditBox.count()) > 0 ? await auditBox.innerText() : null;
    expect.soft(await auditUnrecorded.count(), 'Exposure run 的审计段不得是「未记录」').toBe(0);
    // 审计段必须带**未达成意图**与**成本放大**的真读数（不只要段存在）
    if (auditText) {
      expect.soft(auditText).toContain('unmet_intent_bars');
      expect.soft(auditText).toContain('cost_amplification');
      expect.soft(auditText).toContain('实际佣金率');
      expect.soft(auditText, '费率分母消歧必须写明').toContain('成交额');
    }
    // `on_signal_break=Continue` ⇒ break 注必须写明「继续推进」
    await expect(page.getByTestId('wb-result-exposure-break-note')).toContainText('Continue');
    await expect(page.getByTestId('wb-result-exposure-break-note')).toContainText('继续');
    // 新告警码在 UI 上**通用渲染**可见（交易明细 tab 的审计区按 code 渲染，无需特判）
    await page.getByTestId('wb-tab-trades').click();
    await expect(
      page.getByTestId('wb-audit-warning-EXPOSURE_UNMET_INTENT'),
      'EXPOSURE_UNMET_INTENT 必须经既有 warnings[] 渲染上屏',
    ).toBeVisible();
    await page.getByTestId('wb-tab-metrics').click();

    await shot(page, '02_result_disclosure');
    dump('02_result_disclosure', obs, {
      runId,
      post: post.status,
      rateCap: rc,
      guard,
      readings: readingsText,
      auditText,
      readingsFacts: {
        inRangeBars: inRange.length,
        withIntent: withIntent.length,
        withDownCap: withDownCap.length,
        downCap: withDownCap[0]?.down_ramp_cap_pct_per_bar ?? null,
        intentSample: withIntent.slice(0, 3).map((b) => ({ intent: b.intent_pct, target: b.target_pct, current: b.current_pct })),
        warnings: (auditBody.warnings ?? []).map((w) => w.code),
        exposureKeys: seg ? Object.keys(seg) : null,
        exposure: seg,
      },
      pathTrace: {
        buyBar: buyBar ? { idx: buyIdx, signal: buyBar.signal, intent: buyBar.intent_pct, target: buyBar.target_pct, rateLimited: buyBar.rate_limited } : null,
        tailTargets: tail.map((b) => ({ signal: b.signal, intent: b.intent_pct, target: b.target_pct, current: b.current_pct, rateLimited: b.rate_limited, deadzoneBlocked: b.deadzone_blocked })),
      },
    });
    // 健康（真渲染无异常）：本批新增字段不得引入前端错误
    expect.soft(obs.pageErrors, `页面异常：${obs.pageErrors.join(' | ')}`).toEqual([]);
  });

  /** 面板提交一个 `Exposure + RateCap` run（同窗口/同策略，只改 `on_signal_break`）；返回 runId。 */
  async function panelSubmitExposure(page: Page, obs: Obs, breakMode: 'Pause' | 'Continue'): Promise<string> {
    await openWorkbench(page);
    await addFirstStrategy(page);
    await page.getByTestId('wb-date-from').fill('2026-02-05');
    await page.getByTestId('wb-date-to').fill('2026-03-01');
    await page.getByTestId('wb-policy-kind').selectOption('Exposure');
    await page.getByTestId('wb-exposure-target').selectOption('ScoreMapped');
    await page.getByTestId('wb-ramp-kind').selectOption('RateCap');
    await setNum(page, 'wb-exposure-down-pct-per-bar', '0.2');
    await page.getByTestId('wb-exposure-on-signal-break').selectOption(breakMode);
    await setNum(page, 'wb-exposure-deadzone-min-notional', '100');
    const before = obs.runPosts.length;
    await page.getByTestId('wb-submit').click();
    await expect
      .poll(() => obs.runPosts.length, { timeout: 60_000, message: '必须观察到 POST /api/workbench/runs' })
      .toBeGreaterThan(before);
    const post = obs.runPosts[obs.runPosts.length - 1]!;
    expect(post.status, `POST /runs 应 201，实得 ${post.status}: ${post.body.slice(0, 200)}`).toBe(201);
    const runId = (JSON.parse(post.body) as { id: string }).id;
    await expect
      .poll(
        async () => ((await (await page.request.get(`/api/workbench/runs/${runId}`)).json()) as { status: string }).status,
        { timeout: 90_000, message: 'run 必须到达 succeeded' },
      )
      .toBe('succeeded');
    return runId;
  }

  test('③ 路径语义对照：`on_signal_break=Pause` ⇒ 同窗口下路径**停在中途**（目标冻结 / 意图仍披露 / 告警触发 / UI 披露）', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const obs = attachObservers(page);
    const runId = await panelSubmitExposure(page, obs, 'Pause');

    const barsBody = (await (
      await page.request.get(`/api/workbench/runs/${runId}/bars?kind=per_bar&offset=0&limit=5000`)
    ).json()) as {
      bars: Array<{
        signal: string;
        warmup?: boolean;
        intent_pct?: number | null;
        target_pct?: number | null;
        current_pct?: number | null;
        deadzone_blocked?: boolean;
        rate_limited?: boolean;
        down_ramp_cap_pct_per_bar?: number | null;
      }>;
    };
    const inRange = barsBody.bars.filter((b) => !b.warmup);
    const buyIdx = inRange.findIndex((b) => b.signal === 'Buy');
    expect(buyIdx, 'in-range 必须出现 Buy（窗口须含一次金叉）').toBeGreaterThanOrEqual(0);
    const buyBar = inRange[buyIdx]!;
    const tail = inRange.slice(buyIdx + 1).filter((b) => b.signal === 'Hold');
    expect.soft(tail.length, 'Buy 之后必须有 Hold bar（信号中断点）').toBeGreaterThan(0);
    const tailTargets = tail.map((b) => b.target_pct ?? -1);
    const maxDev = tailTargets.length > 0 ? Math.max(...tailTargets.map((t) => Math.abs(t - (buyBar.target_pct ?? 0)))) : -1;
    // **判断力**：Pause ⇒ 目标冻结在 Buy bar 的目标（实测最大偏差 ≤ 0.01，仅净值/价格漂移）；
    // 变异反证：改成 Continue ⇒ 同窗口实测推进到 ≈0.35 ⇒ 本断言必红。
    expect.soft(tail.length, 'Hold 尾巴非空').toBeGreaterThan(0);
    expect.soft(maxDev, `Pause ⇒ 目标冻结（实测最大偏差 ${maxDev}）`).toBeLessThanOrEqual(0.01);
    expect.soft(Math.max(...tailTargets), `Pause ⇒ Hold 带目标不得推进到意图（实测峰值 ${Math.max(...tailTargets)}）`).toBeLessThan(
      0.1,
    );
    expect.soft(
      tail.every((b) => b.intent_pct === buyBar.intent_pct),
      `意图在 Hold 带仍披露为 ${buyBar.intent_pct}（未达成但可见 = F1 修复）`,
    ).toBe(true);
    expect.soft(Math.abs((buyBar.intent_pct ?? 0) - (buyBar.target_pct ?? 0)), 'Buy bar 起即被限速').toBeGreaterThan(0.2);
    expect.soft((buyBar.down_ramp_cap_pct_per_bar ?? 0), '下行预算 = 0.2').toBe(0.2);
    expect
      .soft(
        tail.some((b) => b.deadzone_blocked === true),
        '目标冻结在死区阈值内 ⇒ 后续 bar 被死区拦下（0 挂单是契约行为）',
      )
      .toBe(true);

    const auditBody = (await (await page.request.get(`/api/workbench/runs/${runId}/audit`)).json()) as {
      warnings: Array<{ code: string }>;
      exposure?: { max_intent_gap: number | null; unmet_intent_bars: number | null; bars: number; orders: number } | null;
    };
    const seg = auditBody.exposure ?? null;
    const warnCodes = (auditBody.warnings ?? []).map((w) => w.code);
    expect.soft(seg, 'Pause run 的 exposure 段不得为 null').not.toBeNull();
    expect
      .soft(seg?.max_intent_gap != null && seg.max_intent_gap > 0.05, `max_intent_gap=${seg?.max_intent_gap} 须 > 0.05`)
      .toBe(true);
    expect
      .soft(seg?.unmet_intent_bars != null && seg.unmet_intent_bars > 0, `unmet_intent_bars=${seg?.unmet_intent_bars} 须 > 0`)
      .toBe(true);
    expect.soft(warnCodes, `Pause 下「停在中途」必须披露：${JSON.stringify(warnCodes)}`).toContain('EXPOSURE_UNMET_INTENT');

    // UI：Pause 语义必须写明（含「停在半途」= 契约行为）；三层读数上屏
    await page.getByTestId('wb-tab-metrics').click();
    await expect(page.getByTestId('wb-result-exposure-break-note')).toContainText('Pause');
    await expect(page.getByTestId('wb-result-exposure-break-note')).toContainText('停在');
    await expect(page.getByTestId('wb-result-exposure-readings')).toContainText('意图');
    await expect(page.getByTestId('wb-result-exposure-readings')).toContainText('输出目标');
    await expect(page.getByTestId('wb-result-exposure-audit')).toContainText('unmet_intent_bars');

    await shot(page, '03_pause_counterpart');
    const pauseReadings = await page.getByTestId('wb-result-exposure-readings').innerText();
    const pauseAuditText = await page.getByTestId('wb-result-exposure-audit').innerText();
    const pauseBreakNote = await page.getByTestId('wb-result-exposure-break-note').innerText();
    dump('03_pause_counterpart', obs, {
      runId,
      maxDevFromBuyTarget: maxDev,
      tailPeakTarget: Math.max(...tailTargets),
      exposure: seg,
      warnings: warnCodes,
      readings: pauseReadings,
      auditText: pauseAuditText,
      breakNote: pauseBreakNote,
      pathTrace: {
        buyBar: { idx: buyIdx, intent: buyBar.intent_pct, target: buyBar.target_pct, rateLimited: buyBar.rate_limited },
        tail: tail.map((b) => ({
          intent: b.intent_pct,
          target: b.target_pct,
          current: b.current_pct,
          deadzoneBlocked: b.deadzone_blocked,
          rateLimited: b.rate_limited,
        })),
      },
    });
    expect.soft(obs.pageErrors, `页面异常：${obs.pageErrors.join(' | ')}`).toEqual([]);
  });
});
