# 现状基线取证（DOM 结构指纹 + 记账）@ HEAD d6462da

- **方法**：临时 vitest 采集用例（`web/src/features/dashboard/__scratch_capture.test.tsx`，jsdom + klinecharts 桩，
  单图模式 / 默认周期 15m / 默认 MA 开）渲染 `DashboardPage`，打印
  ① `[data-region="main-chart"]` 子树**结构指纹**（标签层级 + `data-*`/`type`/`aria-pressed`，忽略 class/id/style）；
  ② 记账（`klinecharts.init` / `dispose` 次数、`getKline` 周期、WS 订阅 topic、main-chart 节点数、整页节点数）。
- **该临时文件用后即删**（不在交付物中）；原始输出见本目录 `baseline_capture_d6462da.txt`。
- **指纹复算**：交付测试 `web/src/features/dashboard/multiPeriodClosedEquivalence.test.tsx` 内置同一 canonicalizer
  与冻结常量；其自检（临时去掉模块加载后）必须通过 ⇒ 见 `frozen_fp_selfcheck.txt`。
- **基线值**：
  - 指纹（3 行）：`0:div[data-region=main-chart]` / `1:div[data-region=sub-chart]` / `1:div[data-testid=kline-chart]`
  - 记账：`init=1`、`dispose=0`、`getKline=[15m]`（1 次）、WS topics = `quote` + `bar:518880:15m`、
    main-chart 元素数 = 2、整页元素数 = 61。
