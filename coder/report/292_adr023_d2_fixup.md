# 292 — ADR-023 D2 收尾小修：mock↔契约 parity + §3.2 密度表补 30m 四行

- 本报告文件位置：`coder/report/292_adr023_d2_fixup.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD（未变）：`3094018f352dae25752340d78b5e108c284aeecc`
- 证据（任务指定落盘）：`/tmp/adr023-d2-fixup-20260916-234640/EVIDENCE.md`
- 结论：**VERDICT: PASS**
- **未 stage**：任务明令禁止 `git add`，故本报告不执行 staging（与 Coder 常规流程的差异已由任务指令覆盖）。

## What changed

| 文件 | 改动 | 行 |
|---|---|---|
| `web/src/api/mock.ts` | 新增导出 `MOCK_MULTI_PERIOD_ORDER`（含 `30m`）；`assertMultiPeriodConfig` 改用它 | +7/−1 |
| `web/src/api/multiPeriodMockParity.test.ts` | 新增 3 条 mock↔契约 parity 断言（集合/顺序） | +76/−1 |
| `design/15-multi-period/02-spec.md` | §3.2 密度表新增 30m 四行 + 冻结口径注 | +11/−1 |
| `coder/report/292_adr023_d2_fixup.md` | 本报告（新增，非代码） | 新增 |

净代码/文档改动：3 文件，+95/−3（见 `git diff --stat`）。

## Architecture alignment

- `web/src/api/mock.ts` 属**手写前端契约 mock 层**（`design/06-web/09-frontend.md §1`「手写例外，不 tangle」；`entangled.toml` `watch_list=design/**/*.md` 无 `file=` 指向它）⇒ 直接改手写文件，非 doc-first。
- 未改任何函数签名 / ApiClient 接口 / 事件契约 / 层边界；`MOCK_MULTI_PERIOD_ORDER` 为 mock 内部常量提升为导出，**未**跨层 import（避免 `api→features` 反向依赖）。
- `design/15-multi-period/02-spec.md` 为 design 事实源文档（无 `file=` 产物声明）⇒ 直接改块，无需 tangle。

## Problem solved / feature added

1. **mock 的周期序未含 `30m`**（`assertMultiPeriodConfig` 局部 `order`）⇒ 开 mock（`VITE_API_MOCK=1`）时含 30m 的合法配置被误判 400，与真后端 `validate_multi_period_config` 不一致。属「契约第二份副本」缺陷族。
2. **§3.2 实测密度表缺 30m 四行**，导致 D2 落地后文档与实现（`MEASURED_DENSITY_TABLE` 已含四条目）不一致。

## Implementation approach

- **扫描全量**：mock.ts 仅 1 处「周期集合/排序/候选收窄」逻辑（`assertMultiPeriodConfig`）；`PERIOD_MS` 为必须含全成员的总映射（已含 30m），余为 DetailRange / 固定字面量 / 源角色标签，与周期档位无关。
- **消除第二真相源**：把 order 提升为导出常量 `MOCK_MULTI_PERIOD_ORDER = ['1m','5m','15m','30m','1h','1d','1w']`，validator 直接引用；全集顺序与 `1mo` 排除、`30m` 插位、步骤 2 `{P ≥ base}` 与 `1w` 需基准 ≥ `1d` 语义，与后端逐条对齐。
- **对齐口径**：parity 断言以 `MULTI_PERIOD_PICKER_PERIODS` 为对齐锚（`multiPeriodPicker.test.tsx:152` 已钉死它等于后端 `MULTI_PERIOD_ALLOWED`）；**扩展既有同类 parity 文件**（不另起口径）。
- **文档**：仅新增 4 行 + 注，既有 5 条 D 值行与第 6 行逐字未动；未改 `01-adr.md`；未动 `composed`/`measured` 优先级。

## Test coverage

`web/src/api/multiPeriodMockParity.test.ts` 新增 `describe('mock ↔ 契约：多周期周期集合与顺序 parity')`：
1. `MOCK_MULTI_PERIOD_ORDER` **逐项相等** `MULTI_PERIOD_PICKER_PERIODS`（含 30m、不含 1mo）；
2. **接受集合**逐档反证（8 档经 `saveMultiPeriodConfig`：∈契约⇒200 / `1mo`⇒400）；
3. **顺序语义**逐对反证（8×7 对：`{P ≥ base}` + `1w` 需基准 ≥ `1d`）。
该文件总用例 20→23。未修改任何既有 tester 测试文件（`period30m*.tsx/ts`、Rust `period30m_*` 均未动）。

## Verification

- **V1** `./scripts/check-tangle.sh` ⇒ exit 0。
- **V2** `npx vitest run` ⇒ 88 files / **839 passed**；`npm run build`（=`tsc -b && vite build`，含类型检查）⇒ exit 0；`npx tsc -b --noEmit` ⇒ exit 0。
- **V3** /tmp 副本变异：mock 去 30m ⇒ **3 红**；断言期望改错 ⇒ **1 红**；复位 ⇒ 23 绿（仓库本体零变异）。
- **V4** HEAD 未变、无 staged、本会话净改动 3 文件；`web/dist` 被 gitignore；无仓库残留。

## Residual risks

1. §3.2 表 `@baseBS=8 误差`/`卫星可见 bar @baseBS=50` 两列标 `—`（D2 冻结集未量取，禁名义比反推）；如需补齐须按 P0.3 同估计器另量。
2. `MOCK_MULTI_PERIOD_ORDER` 为新增导出（仅可测试性）；若评审否决该导出，断言 2/3 已可独立变红。
3. 既有 5 条旧密度值（`1m:15m=12.2` 等）按令逐字保留，属 ADR-023 §6.1 第 7 条独立债。
4. `composed`/`measured` 解析优先级未动（F5 待用户裁决）。
