# 资源纪律与进程卫生（tester 终验波 · 2026-09-20 12:19–12:31 CST）

> 本文件路径：`tester/evidence/20260920_result_resize_verify/raw/resource_discipline.md`

| 项 | 事实 |
|---|---|
| 单车道 | 未 spawn 任何子代理；全程唯一活跃车道（tester 本人） |
| vitest | **逐文件单跑** + `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048` + `timeout 300` |
| playwright | **只跑相关规格**（tester 自建终验规格 1 个 + 冻结规格 4 个）；每次 `timeout 600/900/1200`；`--workers=1 --retries=0`；**未起 `vite preview` 跑线上真身**（8081 主机进程直接复用） |
| 变异反证构建 | `vite build --outDir dist-mut / dist-restore`（**不覆盖 `web/dist`**；构建 2.0–2.3s）；临时 `vite preview --outDir dist-mut --port 4175/4176` 仅用于变异构建，跑完立即 kill |
| grep/find | 均带 `--exclude-dir` 或限定路径（`target`/`node_modules`/`.git` 未扫描） |

## free -h（每步）

| 时刻 | 步骤 | free | available |
|---|---|---|---|
| 12:19 | 起测（探针/规格编写前） | 9.7Gi | 28Gi |
| 12:23 | 5 个新单测文件逐文件单跑前 | 9.0Gi | 28Gi |
| 12:23–12:27 | 四冻结规格复跑期间 | 9.9Gi | 28Gi |
| 12:27–12:29 | M1/M2 变异构建 + preview + 规格 | 10Gi | 28Gi |
| 12:30 | 终验收尾 | 10Gi | 28Gi |

无异常增长，无 OOM（峰值观测 free ≥ 9.0Gi / available ≥ 28Gi）。

## 收尾残留检查（12:30）

| 检查 | 命令 | 结果 |
|---|---|---|
| `vite preview` 残留 | `ps -eo pid,comm,args \| grep -i "[v]ite"` | **0**（无输出） |
| playwright 浏览器残留 | `ps -eo pid,args \| grep "[m]s-playwright\|[c]hrome-headless-shell\|[h]eadless_shell"` | **0**（无输出） |
| 临时构建目录 | `ls -d web/dist*` | 仅 `web/dist`（`dist-mut` / `dist-restore` 已删除） |
| core dump | `find web crates -name "core*" -newermt "-3 hours"` | **0** |
| 崩溃 | 5 个规格 + 1 个自建规格运行 | **无 crash / 无 core / 无 OOM**（失败仅断言级） |
| 8081 真身 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/` | **200** |

## 副作用与还原

1. **跑冻结规格会覆盖它们自己的历史证据**（tracked 文件）：本次共改动 **66 个** tracked 证据文件
   （`coder/evidence/20260920_adr027_p9c_final/raw/*`、`tester/evidence/20260920_adr027_axis_verify/raw/*`、
   `tester/evidence/20260920_adr028_features_verify/raw/*`）⇒ 已用 `git checkout --` **逐路径还原**，
   收尾 `git status --porcelain` 与波前快照**逐行一致**（差异 0 行）。
2. **`tester/evidence/20260920_result_resize_probe/raw/` 为未入库（untracked）目录**：复跑冻结探针
   `adr028-resize-probe.e2e.ts` 会**覆盖**该目录 30 个 json/png（`p1..p4*`、`state_*.png`，差异仅运行相关值）。
   该目录**无 git 基线可还原** ⇒ 如实披露（本波读数即为“本机本次”复跑产物，见 `report.md` §6）。
3. 我的失败运行为 playwright 默认产物（`web/e2e/artifacts/test-results/`）；末次成功运行已清空，
   收尾仅剩 `.last-run.json`；失败文本已另存 `raw/frozen_features_verify.txt`。
