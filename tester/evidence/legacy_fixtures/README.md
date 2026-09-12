# 归档：临时验收夹具（原 crates/*/tests/zz_tester_*.rs）

这些是历次验收（tester 010/011）使用的**临时夹具**，原文件头自注「跑完即删，不提交」。
2026-09-12 由架构师归档处理：**移出 `crates/*/tests/`**（否则会被 `cargo test --workspace`
编译并执行 → 测试污染，且部分用例依赖探针库装配而在常规环境误判失败），
**保留在此作为验收可复现证据**。

| 文件 | 来源 | 运行前提 |
|---|---|---|
| `zz_tester_010_acceptance.rs` | tester 010（MCP 批验收） | 真实 DB + MCP 装配（含 fee_profiles） |
| `zz_tester_i1_acceptance.rs` | tester I-1 验收 | 真实 DB（symbols 注册表） |
| `zz_tester_010_web.rs` | tester 010（web 通道） | 真实 DB + web 装配 |
| `zz_tester_011_f2_path.rs` | tester 011（F2 路径断言） | 真实 DB + web 装配 |

**复跑方式**（按需，勿常驻）：把目标文件拷回对应的 `crates/<crate>/tests/` 后，
`cargo test -p <crate> --test <file-stem> -- --nocapture`。

**纪律**：不得直接 `git add crates/`（会把这类未跟踪夹具带入暂存区）；提交前核对
`git diff --cached --name-only | grep -c zz_` 应为 0。
