# 011 验收测试设计 —— F1/F2/F4 增量验收（窄范围，仅验证不改实现）

> 本文件位置（self-reference）：`eestock-rs/tester/design/011_f1f2f4_acceptance_design.md`
> 范围：验证 coder/report/145 所述 F1/F2/F4 改动；不改实现。产出 `tester/report/011_f1f2f4_acceptance.md`。

## 策略

| 层 | 手段 | 目的 |
|---|---|---|
| 事实源↔生成物 | 独立在 `/tmp` 用 `entangled tangle` 从 `design/` 全量重生成，`cmp` 到工作区 `crates/mcp/src/tools.rs` | 证明 byte-for-byte 镜像（不依赖 worker 自述） |
| F1 行为 | 复用 mcp 单测（mock 端口）`get_kline_same_day_date_bounds_legal` / `_validation_is_32602` / `_date_bounds_and_range_filter` / `_rfc3339_bounds` / `_range_over_limit` / `_without_bounds` | 覆盖 6 项行为矩阵 |
| F1 方向性 | 代码审读：比较后移 + date-to 展开使 t 单调不减 → 只可能放宽 | 证明无输入由合法变非法 |
| F2 路径区分 | 新增夹具 `crates/web/tests/zz_tester_011_f2_path.rs`：W1 → 白名单文案含 `period`；H1（无 H1 数据）→ 数据路径文案不含 `period` | 动态区分白名单分支 vs 数据路径碰巧 400 |
| F4 | 注释 vs `bar_map::parse_period` 实际接受集 | 一致性核对 |
| 回归 | `cargo test -p mcp -p web -p application`；`cargo check --workspace --all-targets`（touch 强制重编重放告警） | 全绿 / 0 warning |
| F3 | `git archive HEAD` 纯净快照复现 tangle 退出码/写文件/`check-tangle.sh`/`--force` | 仅确认定性 |
| 生产 | :8081/:8082 探测、PID、二进制 mtime vs 源码 mtime | 状态判断 |

## 夹具（新增）

- `crates/web/tests/zz_tester_011_f2_path.rs::f2_period_paths_are_distinguishable`
  - Given 已注册 symbol + 6 根 M1 bar + 已发布版本
  - When submit `period=W1` Then 400 且 `error` 文案 == 白名单文案（含 `period`）
  - When submit `period=H1`（无 H1 数据）Then 400 且 `error` 文案不含 `period`（数据路径）
  - 该成对断言即「能区分两条路径」的证据。

## 边界/异常

F1：同日 date、RFC3339 f==t、反向 date、RFC3339 from 晚于 date-to 展开日界、混合形式、无界回归。
F2：非法格式 vs 白名单外周期 vs 数据路径空区间。

## 覆盖目标

F1 六个行为矩阵项全覆盖；F2 两路径各 1 例；F4 静态核对；回归沿用既有 272 用例。
