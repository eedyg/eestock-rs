# D5-3 独立验收证据包（Tester）

- **本文件路径（自引用）**：`tester/evidence/268_d53/README.md`
- 执行报告：`tester/test/268_d53_independent_acceptance_execution.md`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `d6462da`，工作树含 P1 未提交改动）
- 结论：**PASS**（19/19 向量两侧一致；反向变异必红；四门禁全绿；卫生干净）

## 证据文件

| 文件 | 内容 |
|---|---|
| `01_same_vector_file.txt` | 两侧是否消费**同一**向量文件（唯一文件 / 路径解析 / 同 inode / 同 sha256 / `.json` 不在 tangle watch_list） |
| `02_parity_matrix_both_sides.txt` | 19 条向量**逐条**比对两侧**实际结论**（status / normalized / errorMustContain）+ 两侧原始输出 + 比对脚本 |
| `02b_mock_behaviour_and_default.txt` | mock 去重落库/回显、`["dcap"]×11` 4 周期不误拒、`enabled=false` 默认三处等价 |
| `03_reverse_evidence_mock_mutants.txt` | 反向证据 A/B：/tmp 副本里去掉去重 / pane 计数改回原始长度 ⇒ 门禁**红** |
| `03b_reverse_evidence_weakened_vectors.txt` | 反向证据 C：削弱向量文件 ⇒ **两侧都红**（「改向量转绿」不成立） |
| `04_regression.txt` | vitest 全量 / tsc -b / cargo test -p web / check-tangle |
| `05_hygiene.txt` | 共享库键 psql 0 行 / `git diff --cached` 空 / 未 stash / 进程端口 / mtime 归因 / sha256 还原 |
| `scripts/` | 全部探针与比对脚本（可复现） |

## 复现配方（全部在 /tmp，不改仓库）

```bash
RM=/home/eestock/workspace/git/eestock/eestock-rs
SB=/tmp/d53_sb                       # 沙箱副本（node_modules 用符号链接指回仓库）
rsync -a --exclude target --exclude .git --exclude data --exclude logs \
      --exclude 'web/node_modules' "$RM/" "$SB/"
ln -s "$RM/web/node_modules" "$SB/web/node_modules"

# ① mock 侧独立探针（不经仓库测试文件，直接打 createMockClient().saveMultiPeriodConfig）
cp $RM/tester/evidence/268_d53/scripts/parity_probe.ts $SB/probe/
(cd $SB/web && ./node_modules/.bin/esbuild ../probe/parity_probe.ts --bundle --platform=node \
   --format=esm --target=node20 --alias:@=$SB/web/src --outfile=$SB/probe/probe.mjs)
node $SB/probe/probe.mjs "$RM/design/15-multi-period/contract-vectors.json"

# ② backend 侧独立探针（链接**仓库已编译**的真实 crate，0.3s，无重编译）
python3  # 由 contract-vectors.json 生成 vectors_gen.rs（见 scripts/vectors_gen.sample.rs）
rustc --edition 2021 -C debuginfo=0 \
  --extern web=$RM/target/debug/deps/libweb-161b6ed0ad648e47.rlib \
  -L dependency=$RM/target/debug/deps scripts/harness.rs -o /tmp/harness && /tmp/harness

# ③ 逐条比对（compare.py 参数：向量文件 / 两侧实际输出）
python3 scripts/compare.py

# ④ 反向证据（沙箱内破坏 mock ⇒ 必红）
bash scripts/run_mutants.sh
```

## 只读性声明

变异全部发生在 `/tmp/d53_sb` 副本；仓库 `design/15-multi-period/contract-vectors.json`
（sha256 `8c72c601…`）与 `web/src/api/mock.ts`（sha256 `5562e531…`）在验收前后逐字节一致。
本验收**未**对 8080/8081/8082 发任何请求（0 写请求，亦未读），未重启线上 PID 3112540。
