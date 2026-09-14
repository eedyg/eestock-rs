#!/usr/bin/env bash
# D5-3 反向证据：在 /tmp 沙箱副本（非仓库）里破坏 mock 的口径，验证 parity 门禁必须变红
SB=/tmp/d53_sb; RM=/home/eestock/workspace/git/eestock/eestock-rs
cd $SB && cp $SB/mock.ts.orig web/src/api/mock.ts   # 基线
run_vitest() { (cd $SB/web && ./node_modules/.bin/vitest run src/api/multiPeriodMockParity.test.ts --reporter=verbose 2>&1); }
build_probe() { (cd $SB/web && ./node_modules/.bin/esbuild ../probe/parity_probe.ts --bundle --platform=node --format=esm --target=node20 --alias:@=$SB/web/src --outfile=$SB/probe/probe_mut.mjs >/dev/null 2>&1); }
echo "########## 基线：仓库原样 mock（沙箱副本） ##########"
echo "\$ vitest run src/api/multiPeriodMockParity.test.ts"; run_vitest | grep -E "^\s+×|Tests |Test Files" | tail -4
build_probe; echo "\$ node probe_mut.mjs contract-vectors.json"; (cd $SB && node probe/probe_mut.mjs design/15-multi-period/contract-vectors.json | tail -1)

for M in A B; do
  cd $SB && cp $SB/mock.ts.orig web/src/api/mock.ts
  if [ $M = A ]; then
    python3 - <<'PY'
p='/tmp/d53_sb/web/src/api/mock.ts'; s=open(p).read()
o="  return { enabled: cfg.enabled, periods: [...cfg.periods], heights: { ...cfg.heights }, indicators: normalizedIndicators };"
n="  return { enabled: cfg.enabled, periods: [...cfg.periods], heights: { ...cfg.heights }, indicators: [...cfg.indicators] };"
assert s.count(o)==1; open(p,'w').write(s.replace(o,n))
PY
    echo; echo "########## 变异 A：去掉「去重落库/回显」（仅计数仍去重） ##########"
    echo "--- patch ---"; cd $SB && diff -u mock.ts.orig web/src/api/mock.ts | sed -n '1,20p'
    echo "--- mock.ts 与仓库 diff（应非空）---"; diff -q $SB/web/src/api/mock.ts $RM/web/src/api/mock.ts || true
  else
    python3 - <<'PY'
p='/tmp/d53_sb/web/src/api/mock.ts'; s=open(p).read()
o="  const panes = 1 + Math.max(0, cfg.periods.length - 1) * normalizedIndicators.length;"
n="  const panes = 1 + Math.max(0, cfg.periods.length - 1) * cfg.indicators.length;"
assert s.count(o)==1; open(p,'w').write(s.replace(o,n))
PY
    echo; echo "########## 变异 B：pane 计数改回原始数组长度 ##########"
    echo "--- patch ---"; cd $SB && diff -u mock.ts.orig web/src/api/mock.ts | sed -n '1,20p'
  fi
  echo "--- \$ vitest run src/api/multiPeriodMockParity.test.ts（必须变红）---"
  run_vitest | grep -E "^\s+×|Tests |Test Files" | tail -6
  build_probe
  echo "--- \$ node probe_mut.mjs（独立探针：mock 实际结论 vs 向量期望，必须出现 MISMATCH）---"
  (cd $SB && node probe/probe_mut.mjs design/15-multi-period/contract-vectors.json | grep -E '"mock":(400|200).*(false)|PROBE_SUMMARY')
done
cd $SB && cp $SB/mock.ts.orig web/src/api/mock.ts
echo; echo "########## 沙箱还原校验 ##########"
diff -q $SB/web/src/api/mock.ts $RM/web/src/api/mock.ts && echo "OK: 沙箱 mock.ts == 仓库 mock.ts（仓库文件全程未被修改）"
