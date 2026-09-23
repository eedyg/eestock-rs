<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **eestock-rs** (1177 symbols, 2133 relationships, 52 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/eestock-rs/context` | Codebase overview, check index freshness |
| `gitnexus://repo/eestock-rs/clusters` | All functional areas |
| `gitnexus://repo/eestock-rs/processes` | All execution flows |
| `gitnexus://repo/eestock-rs/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## 代理产物与提交纪律（本项目强制 · 2026-09-23 用户裁定）

- **禁止**把车道（subagent）产物加入版本控制：`coder/**`、`tester/**`、`.pi-sessions/**`、`.claude/**`
  （证据、报告、备份、探针脚本、会话日志一律不入库）。**只入库**：产品代码、产品测试、`design/**` 文档、`scripts/**`、`migrations/**`。
- 提交前必须用**显式文件清单** stage，**禁止** `git add -A` / `git add .`；
  并自检：`git diff --cached --name-only | grep -E '^(coder|tester)/'` 必须为空，否则 `git restore --staged <path>`。
- 提交前必须跑 `gitnexus detect_changes`（staged）与 `impact`（目标符号）。
  索引若报 `LadybugDB unavailable` / `database file version` 不符 ⇒ 先 `node .gitnexus/run.cjs analyze --index-only` 重建，**不得**跳过门禁提交。
- 真渲染判据必须**真身**取证（本机 chromium 可用），且判据须**有鉴别力**（移除实现即变红），不得只断言元素存在。
- **e2e 证据落盘目录不得硬编码为已跟踪路径**（2026-09-23 登记）：
  既有 `web/e2e/adr028-*.e2e.ts` 等规格把证据 JSON/PNG 的落盘目录硬编码为仓库内**已跟踪**的
  `coder/evidence/20260920_*/raw/`、`tester/evidence/20260920_*/raw/` ⇒ 每跑一次真渲染即覆盖写，
  一次 D6/D7 验收跑出 **67 个**已跟踪文件变脏。新增/修改规格时：证据须落到**未跟踪**目录
  （如当批 `tester/evidence/<date>_<topic>/raw/`），或经 `E2E_EVIDENCE_DIR` 等**可配置出口**注入；
  评审规格时把"证据落盘路径是否污染已跟踪文件"列为检查项。
