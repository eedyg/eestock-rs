/**
 * ADR-029 Step 1（**Web 侧**）真渲染 E2E：`ExecutionPolicy::Exposure`（目标 × ramp × guard）配置面板、
 * 前端 fail-loud 校验、披露（总分 ≠ 仓位 / 目标暴露），以及 **旧配置（LumpSum/Dca）不回归**。
 *
 * 契约事实源：
 *  - `design/01-architecture/adr/ADR-029-execution-policy-exposure-ramp-guard.md`（D3–D5/D7/D8/§4；
 *    **R18** 滞后一 bar 对齐口径、**R26** 唯一 testid + 用例③须真触发 Buy/加仓）
 *  - `design/12-strategy-system/05-plan-exposure-ramp-step1.md`（E11 校验 + §1 JSON 形状）
 *
 * 本规格的**边界**（诚实声明，勿当绿读）：
 *  - Rust 车道**已落地**（本规格在 `E2E_BASE_URL` 指向的后端实例上 4/4 通过）。仅当后端尚无
 *    `Exposure` 变体时，用例 ③ 才会因 serde `400 unknown variant` **自动 skip 并写明原因**（不是“通过”）；
 *    该 skip 只为向前兼容，**不**构成其余断言的放宽。
 *  - 用例 ③ 的窗口/ramp **不是任意选取**：所选策略（catalog 首个 published = 双均线插件）聚合分只在
 *    金叉 bar 取 80（Buy），而后端阈值契约要求 `buy_threshold > 50 ∧ sell_threshold < 50` ⇒ 窗口必须**覆盖一次金叉**，
 *    否则 in-range 只有 {20,50} ⇒ 结构性 0 挂单（**R26 的“空壳通过”根因**）。
 *  - 逐 bar 观测字段（`target_pct/current_pct/deadzone_blocked/clamped_by_guard`）就绪后，结果页渲染计数块
 *    （`wb-exposure-observed`）；未就绪时**显式「未记录」**（`wb-exposure-unrecorded`，禁以 0 冒充）。
 *
 * testid 口径（R26）：配置侧 = `wb-exposure-*`（ConfigPanel），**结果侧 = `wb-result-exposure-*`**（ResultView）——
 *   工作台选中 run 后两侧**同时挂载**，同名 id 会让未限定作用域的 `getByTestId` 在 Playwright strict mode 下双命中。
 *
 * 沙箱（不写 web/dist；用**自有空闲端口**的后端实例直服静态产物：应用面 /api 与 SPA 同源，无需代理）：
 *   cd web && npx vite build --outDir /tmp/adr029b_web
 *   # 复制 /tmp/app_dev_8081.toml 改 listen/mcp_listen/static_dir ⇒ /tmp/adr029b_app.toml
 *   ./target/debug/eestock-app --config /tmp/adr029b_app.toml     # listen 0.0.0.0:8189, static_dir /tmp/adr029b_web
 *   E2E_BASE_URL=http://localhost:8189 npx playwright test e2e/adr029-exposure.e2e.ts
 *   # （备选：vite preview + VITE_PROXY_TARGET 代理到任一后端实例）
 *
 * 证据出口：`E2E_EVIDENCE_DIR`（默认 = **未跟踪**目录 `coder/evidence/20260924_adr029_step1_web/raw/e2e`）
 * —— 禁硬编码到任何**已跟踪**目录（AGENTS.md 2026-09-23 登记：e2e 证据落盘不得污染已跟踪文件）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 默认出口 = 未跟踪目录（`coder/evidence/` 已 .gitignore）。 */
const OUT = process.env.E2E_EVIDENCE_DIR
  ? resolve(process.env.E2E_EVIDENCE_DIR, 'adr029')
  : resolve(REPO, 'coder/evidence/20260924_adr029_step1_web/raw/e2e');
const TAG = process.env.ADR029_E2E_TAG ?? 'base';

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
  writeFileSync(resolve(OUT, `${TAG}_${name}.json`), JSON.stringify({ tag: TAG, name, ...extra, ...obs }, null, 2), 'utf8');
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, `${TAG}_${name}.png`) });
}

/** 打开工作台并等待配置区 + 运行历史就绪。 */
async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  // catalog 就绪（策略下拉有非占位项）——否则 slot 无法添加
  await expect(page.getByTestId('wb-add-strategy').locator('option')).not.toHaveCount(1);
}

/** 添加 catalog 中的第一个已发布策略为 slot（选中 → 点添加）。 */
async function addFirstStrategy(page: Page): Promise<void> {
  const select = page.getByTestId('wb-add-strategy');
  const firstValue = await select.locator('option').nth(1).getAttribute('value');
  expect(firstValue, 'catalog 至少得有 1 个 published 策略').toBeTruthy();
  await select.selectOption(firstValue!);
  await page.getByTestId('wb-add-btn').click();
  await expect(page.getByTestId(`slot-card-${firstValue}`)).toBeVisible();
}

/** 数值输入（清空后键入；`input[type=number]` 需 fill 而非 type 追加）。 */
async function setNum(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await expect(el).toHaveValue(value);
}

const EXPOSURE_FIELDS = [
  // 配置侧（ConfigPanel）字段：仅未选中 run（无结果页）时断言 ⇒ 保持原名（R26）
  'wb-exposure-target',
  'wb-exposure-fixed-pct',
  'wb-ramp-kind',
  'wb-ramp-pct-per-bar',
  'wb-guard-max-pct',
  'wb-guard-min-pct',
  'wb-guard-deadzone-pct',
  'wb-exposure-disclosure',
];

test.describe('ADR-029 Step 1（Web 侧）：Exposure 配置 / 校验 / 披露', () => {
  test('① 旧配置不回归：LumpSum 真提交成功（无 form/submit 错误，run 上屏）', async ({ page }) => {
    const obs = attachObservers(page);
    await openWorkbench(page);
    await addFirstStrategy(page);
    // 保守起见缩到 ~1 个月的 D1（避免触发 resource_guard 二次确认路径，本用例不测它）
    await page.getByTestId('wb-date-from').fill('2026-03-01');
    await page.getByTestId('wb-date-to').fill('2026-04-01');
    await expect(page.getByTestId('wb-policy-kind')).toHaveValue('LumpSum');
    await page.getByTestId('wb-submit').click();

    // 成功路径：run 上屏（store 提交成功后 refreshRuns + selectRun ⇒ 结果头出现）
    await expect(page.getByTestId('wb-run-title')).toBeVisible({ timeout: 60_000 });
    expect(await page.getByTestId('wb-form-error').count(), '不得出现表单校验错误').toBe(0);
    expect(await page.getByTestId('wb-submit-error').count(), '不得出现提交错误').toBe(0);
    await shot(page, '01_lumpsum_regression');
    dump('01_lumpsum_regression', obs, {
      runTitle: await page.getByTestId('wb-run-title').innerText(),
      runPosts: obs.runPosts.map((p) => p.status),
    });
    expect(obs.runPosts.some((p) => p.status === 201 || p.status === 200), 'POST /api/workbench/runs 必须成功').toBe(true);
  });

  test('② Exposure 面板：模式可选 / 字段齐备 / 披露可见 / 前端 fail loud（非法配置不发请求）', async ({ page }) => {
    const obs = attachObservers(page);
    await openWorkbench(page);
    await addFirstStrategy(page);
    await page.getByTestId('wb-policy-kind').selectOption('Exposure');

    // 字段齐备（R2：Fixed 分支**不得**有 sell；ScoreMapped 才有）
    for (const id of EXPOSURE_FIELDS) {
      await expect(page.getByTestId(id), `${id} 必须可见`).toBeVisible();
    }
    await expect(page.getByTestId('wb-exposure-sell')).toHaveCount(0);
    // 披露（D7/R1/R5/R6）：总分 ≠ 仓位 + 量纲 + 两支卖出语义
    const disclosure = page.getByTestId('wb-exposure-disclosure');
    await expect(disclosure).toContainText('总分曲线是诊断量');
    await expect(disclosure).toContainText('不等于仓位');
    await expect(disclosure).toContainText('策略无权覆盖');
    await expect(page.getByTestId('wb-exposure-dim-note')).toContainText('暴露比例差');
    await expect(page.getByTestId('wb-exposure-dim-note')).toContainText('每 bar 允许变动金额 / 净值');
    // E15/E16：非零 min_pct 只约束持有态、不阻塞清仓（防「设了下限就不会空仓」误读）
    await expect(page.getByTestId('wb-exposure-guard-note')).toContainText('仅约束持有态');
    await expect(page.getByTestId('wb-exposure-guard-note')).toContainText('不阻塞清仓');

    // 切 ScoreMapped ⇒ sell 出现 + 两支语义各一句话
    await page.getByTestId('wb-exposure-target').selectOption('ScoreMapped');
    await expect(page.getByTestId('wb-exposure-sell')).toBeVisible();
    await expect(disclosure).toContainText('Flat = 直接清仓');
    await page.getByTestId('wb-exposure-sell').selectOption('Scaled');
    await expect(disclosure).toContainText('Scaled = 对称降档');
    await shot(page, '02_exposure_panel');

    // E11 fail loud：at_full_pct < at_threshold_pct ⇒ 前端拦截，**零请求**
    await setNum(page, 'wb-exposure-at-threshold-pct', '0.5');
    await setNum(page, 'wb-exposure-at-full-pct', '0.3');
    await page.getByTestId('wb-submit').click();
    await expect(page.getByTestId('wb-form-error')).toContainText('at_full_pct');
    expect(obs.runPosts.length, '前端校验失败时不得发出 POST /runs').toBe(0);

    // E11 fail loud：pct_per_bar = 0 ⇒ 拦截（量纲文案）
    await setNum(page, 'wb-exposure-at-full-pct', '0.5');
    await setNum(page, 'wb-ramp-pct-per-bar', '0');
    await page.getByTestId('wb-submit').click();
    await expect(page.getByTestId('wb-form-error')).toContainText('pct_per_bar');
    expect(obs.runPosts.length).toBe(0);

    // E11 fail loud：max_pct > 1 ⇒ 拦截
    await setNum(page, 'wb-ramp-pct-per-bar', '0.05');
    await setNum(page, 'wb-guard-max-pct', '1.2');
    await page.getByTestId('wb-submit').click();
    await expect(page.getByTestId('wb-form-error')).toContainText('min_pct ≤ max_pct ≤ 1');
    expect(obs.runPosts.length).toBe(0);

    dump('02_exposure_panel', obs, { runPosts: obs.runPosts, formError: await page.getByTestId('wb-form-error').innerText() });
  });

  test('③ Exposure 真提交并真触发交易（唯一 testid + 非零目标暴露 + ≥1 笔成交 + 无 EXPOSURE_INTENT_GAP）', async ({ page }) => {
    test.setTimeout(120_000);
    const obs = attachObservers(page);
    await openWorkbench(page);
    await addFirstStrategy(page);
    // 窗口选择（BLOCKED-1/R26 修复点 ②：原窗口是**空壳**）：
    //   catalog 首个 published（双均线插件）聚合分只在金叉 bar 取 80（Buy）；原窗口 2026-03-01..04-01
    //   in-range 分数仅 {20,50}，而后端阈值契约要求 **buy_threshold > 50 且 sell_threshold < 50**
    //   （中立 50 强制 Hold）⇒ 该窗口下**永远不可能出现 Buy**：即使定位符修好，旧用例也只证「面板不崩」
    //   （实测 0 挂单 / 0 成交 / target 全 0 / deployed_pct 0）。
    //   本窗口含 2026-02-08 的金叉（聚合分 80 ⇒ Buy）+ 2026-02-05 的 20（Sell；无持仓 ⇒ 零订单）。
    await page.getByTestId('wb-date-from').fill('2026-02-05');
    await page.getByTestId('wb-date-to').fill('2026-03-01');
    await page.getByTestId('wb-policy-kind').selectOption('Exposure');
    await page.getByTestId('wb-exposure-target').selectOption('ScoreMapped');
    // Immediate：当 bar 目标即全额 ⇒ 建仓在单 bar 内完成。建仓跃迁 0.35 ≫ gap 阈值 0.05，
    // 必须由 E16/R10「建仓首根排除」（= 现实现口径）或 R18「滞后一 bar 对齐」吸收，否则审计必报
    // EXPOSURE_INTENT_GAP（本配置的「无 gap」断言因而对**滞后口径**有鉴别力）。
    await page.getByTestId('wb-ramp-kind').selectOption('Immediate');
    await page.getByTestId('wb-submit').click();

    // 等首个 POST /runs 响应（成功 ⇒ run 上屏；失败 ⇒ 错误条）
    await expect
      .poll(() => obs.runPosts.length, { timeout: 60_000, message: '必须观察到 POST /api/workbench/runs' })
      .toBeGreaterThan(0);
    const post = obs.runPosts[0]!;
    await shot(page, '03_exposure_submit');

    if (post.status >= 400 && /unknown variant|Exposure/i.test(post.body)) {
      dump('03_exposure_submit_pending_rust', obs, {
        post,
        verdict: 'SKIP：后端尚未支持 ExecutionPolicy::Exposure（Rust 车道未落地）',
      });
      test.skip(true, `后端 ExecutionPolicy 尚无 Exposure 变体（待 Rust 车道落地后复跑）：${post.status} ${post.body.slice(0, 300)}`);
      return;
    }

    // ① 提交成功（R26：必须是 201，不只「<400」）
    expect(post.status, `POST /runs 应成功，实得 ${post.status}: ${post.body.slice(0, 300)}`).toBe(201);
    const runId = (JSON.parse(post.body) as { id: string }).id;
    await expect(page.getByTestId('wb-run-title')).toBeVisible({ timeout: 60_000 });
    expect(await page.getByTestId('wb-submit-error').count()).toBe(0);
    // 后续逐 bar/成交/审计读数必须来自**终态** run（提交是异步的）
    await expect
      .poll(
        async () => ((await (await page.request.get(`/api/workbench/runs/${runId}`)).json()) as { status: string }).status,
        { timeout: 90_000, message: 'run 必须到达 succeeded' },
      )
      .toBe('succeeded');

    // ② 结果页**结果侧**披露（BLOCKED-1 修复点 ①：唯一 testid）
    await page.getByTestId('wb-tab-metrics').click();
    const box = page.getByTestId('wb-result-exposure-disclosure');
    await expect(box, '结果侧披露必须唯一命中（不得与配置侧同名）').toHaveCount(1);
    await expect(box).toBeVisible();
    await expect(page.getByTestId('wb-result-exposure-target')).toHaveCount(1);
    await expect(page.getByTestId('wb-result-exposure-target')).toContainText('ScoreMapped');
    await expect(page.getByTestId('wb-exposure-score-note')).toContainText('不等于仓位');
    // 配置侧原 id 仍唯一存在（两侧同时挂载 ⇒ 改名后必须互不重叠；若共用 id，这里会变成 2）
    expect(await page.getByTestId('wb-exposure-disclosure').count(), '配置侧披露须仍在且唯一').toBe(1);
    expect(await page.getByTestId('wb-exposure-target').count(), '配置侧 target 须仍在且唯一').toBe(1);

    // ③ 逐 bar 观测（真渲染读数）：必须就绪且目标暴露**非零**（空壳判据）
    const observedBlock = page.getByTestId('wb-exposure-observed');
    const unrecordedBlock = page.getByTestId('wb-exposure-unrecorded');
    expect((await observedBlock.count()) + (await unrecordedBlock.count()), '观测块或「未记录」块必须恰好存在 1 个').toBe(1);
    await expect(observedBlock, '观测字段应就绪（Rust 车道已落地）⇒ 不得是「未记录」').toHaveCount(1);
    const observedText = await observedBlock.innerText();
    const targetM = /目标 ([\d.]+)%/.exec(observedText);
    expect(targetM, `观测块文案须含目标暴露读数：${observedText}`).not.toBeNull();
    expect(Number(targetM![1]), `目标暴露须非零（空壳判据）：${observedText}`).toBeGreaterThan(0);
    // 资金投入率（既有事实，结果页 metrics tab）
    const deployedText = await page.getByTestId('wb-metrics-deployed').innerText();
    const deployedM = /=\s*([\d.]+)%/.exec(deployedText);
    expect(deployedM, `资金投入率文案须含读数：${deployedText}`).not.toBeNull();
    expect(Number(deployedM![1]), `deployed_pct 须 > 0：${deployedText}`).toBeGreaterThan(0);

    // ④ 事实源读数（同一实例的 /bars、/fills、/audit；不依赖 UI 渲染细节）
    const barsUrl = `/api/workbench/runs/${runId}/bars?from=2026-02-05T00:00:00Z&to=2026-03-01T00:00:00Z`;
    const barsBody = (await (await page.request.get(barsUrl)).json()) as {
      bars: Array<{ signal: string; aggregate: number; target_pct?: number; current_pct?: number; orders?: unknown[] }>;
    };
    const inRange = barsBody.bars;
    const buyBars = inRange.filter((b) => b.signal === 'Buy').length;
    const ordersTotal = inRange.reduce((n, b) => n + (b.orders?.length ?? 0), 0);
    const maxTargetPct = Math.max(...inRange.map((b) => b.target_pct ?? 0));
    const fillsBody = (await (await page.request.get(`/api/workbench/runs/${runId}/fills?limit=100`)).json()) as {
      fills: unknown[];
    };
    const auditBody = (await (await page.request.get(`/api/workbench/runs/${runId}/audit`)).json()) as {
      deployed_pct: number;
      warnings: Array<{ code: string }>;
    };
    const warnCodes = (auditBody.warnings ?? []).map((w) => w.code);
    expect(buyBars, 'in-range 必须出现 Buy（空壳判据）').toBeGreaterThanOrEqual(1);
    expect(ordersTotal, 'in-range 必须挂单 ≥1 笔').toBeGreaterThanOrEqual(1);
    expect(maxTargetPct, 'per_bar 目标暴露必须非零（空壳判据）').toBeGreaterThan(0);
    expect(fillsBody.fills.length, '必须 ≥1 笔成交').toBeGreaterThanOrEqual(1);
    expect(auditBody.deployed_pct, 'deployed_pct 必须 > 0').toBeGreaterThan(0);
    // ⑤ 审计告警：**不得**出现 EXPOSURE_INTENT_GAP（D7/E16；建仓首根跃迁须被吸收）
    expect(warnCodes, `审计告警码：${JSON.stringify(warnCodes)}`).not.toContain('EXPOSURE_INTENT_GAP');
    // UI 侧同一事实（交易明细 tab 的审计区按 code 通用渲染）
    await page.getByTestId('wb-tab-trades').click();
    await expect(page.getByTestId('wb-audit-summary')).toBeVisible();
    expect(await page.getByTestId('wb-audit-warning-EXPOSURE_INTENT_GAP').count(), 'UI 不得渲染 EXPOSURE_INTENT_GAP').toBe(0);

    await shot(page, '03_exposure_result_disclosure');
    dump('03_exposure_result_disclosure', obs, {
      runId,
      post: post.status,
      target: await page.getByTestId('wb-result-exposure-target').innerText(),
      observed: observedText,
      unrecorded: (await unrecordedBlock.count()) > 0 ? await unrecordedBlock.innerText() : null,
      deployedText,
      readings: {
        inRangeBars: inRange.length,
        buyBars,
        ordersTotal,
        maxTargetPct,
        fills: fillsBody.fills.length,
        deployedPct: auditBody.deployed_pct,
        warnings: warnCodes,
      },
    });
  });

  test('④ 披露真渲染（不依赖新提交）：结果页总分诊断注 = 「总分不等于仓位」', async ({ page }) => {
    // 变异反证（判别力）：删掉结果页的总分诊断注 ⇒ 本用例必须变红（失败信息 = 未找到任何带诊断注的 run）。
    test.setTimeout(120_000);
    const obs = attachObservers(page);
    await page.goto('/backtest-workbench');
    await expect(page.getByTestId('wb-run-list')).toBeVisible();
    // 先**快照**行 id（点击后 DOM 会重渲染，避免 nth(i) 重新求值时命中脱落元素）
    const all = await page
      .locator('[data-testid^="wb-run-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    const rowIds = all.filter(Boolean).slice(0, 4);
    expect(rowIds.length, '运行历史里至少得有 1 条 run').toBeGreaterThan(0);

    let usedRunId: string | null = null;
    let noteText: string | null = null;
    for (const rowTestId of rowIds) {
      if (usedRunId !== null) break;
      const id = rowTestId.replace('wb-run-row-', '');
      const row = page.getByTestId(rowTestId);
      if ((await row.count()) !== 1) continue;
      const rowText = await row.innerText();
      if (!rowText.includes('完成')) continue; // STATUS_LABEL.succeeded = 「完成」
      await page.getByTestId(`wb-run-select-${id}`).click();
      await expect(page.getByTestId('wb-result')).toBeVisible();
      // 结果就绪（总分曲线卡）后，常驻诊断注必须在；未就绪/不可得 ⇒ 试下一条候选
      const note = page.getByTestId('wb-score-diagnostic-note');
      try {
        await expect(note).toHaveCount(1, { timeout: 8_000 });
        await expect(note).toContainText('总分不等于仓位');
        usedRunId = id;
        noteText = await note.innerText();
      } catch {
        /* 该 run 结果不可得（旧/无数据）⇒ 下一个候选 */
      }
    }
    expect(usedRunId, '历史中必须存在至少 1 条可打开结果页的已完成 run（且总分诊断注可见）').not.toBeNull();
    await shot(page, '04_score_diagnostic_note');
    dump('04_score_diagnostic_note', obs, { runId: usedRunId, note: noteText });
  });
});
