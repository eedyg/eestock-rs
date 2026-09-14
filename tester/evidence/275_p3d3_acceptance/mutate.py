#!/usr/bin/env python3
"""P3-D-3 反向变异：只改 /tmp/p3d3/mut 副本（仓库源码只读），每处变异跑聚焦 vitest 取证红。"""
import os, re, shutil, subprocess, sys, json

REPO = '/home/eestock/workspace/git/eestock/eestock-rs/web'
MUT = '/tmp/p3d3/mut'
SRC = f'{MUT}/src/features/dashboard/chartSyncGroup.ts'
STUB = f'{MUT}/src/test/syncChartStub.ts'
OUT = '/tmp/p3d3/mutations'
os.makedirs(OUT, exist_ok=True)
FILES = ['src/features/dashboard/chartSyncGroup.test.ts', 'src/features/dashboard/chartSyncAlignClosedLoop.test.ts',
         'src/features/dashboard/chartSyncStubFidelity.test.ts']

def restore():
    for f in ['src/features/dashboard/chartSyncGroup.ts', 'src/test/syncChartStub.ts']:
        shutil.copyfile(f'{REPO}/{f}', f'{MUT}/{f}')

def patch(path, old, new, tag=None):
    t = open(path).read()
    assert old in t, f'PATCH-ANCHOR-MISSING {tag}'
    open(path, 'w').write(t.replace(old, new, 1))

def vitest(tag, files=FILES):
    p = subprocess.run(['npx', 'vitest', 'run', '--reporter=basic', *files], cwd=MUT,
                       capture_output=True, text=True, timeout=900)
    txt = p.stdout + p.stderr
    open(f'{OUT}/{tag}_vitest.txt', 'w').write(txt)
    fails = sorted(set(re.findall(r'×\s+(.+?)\s+\d+ms', txt)) | set(re.findall(r'FAIL\s+(\S+)', txt)))
    m = re.search(r'Tests\s+(.+)', txt)
    return {'tag': tag, 'exit': p.returncode, 'summary': m.group(1).strip() if m else 'n/a',
            'failedCases': fails[:20], 'red': p.returncode != 0}

def bundle(tag):
    """把变异后的 chartSyncGroup.ts 打包到独立 harness 目录并跑真渲染。"""
    import subprocess as sp
    d = f'/tmp/p3d3/h_{tag}'
    os.makedirs(d, exist_ok=True)
    sp.run([f'{REPO}/node_modules/.bin/esbuild', SRC, '--format=esm', f'--outfile={d}/chartSyncGroup.mjs', '--log-level=warning'], check=True)
    shutil.copyfile(f'{REPO}/node_modules/klinecharts/dist/umd/klinecharts.min.js', f'{d}/klinecharts.min.js')
    shutil.copyfile('/tmp/p3d3/h1/multiPeriodStore.mjs', f'{d}/multiPeriodStore.mjs')
    shutil.copyfile('/tmp/p3d3/h1/harness.html', f'{d}/harness.html')
    env = dict(os.environ, P3D3_H1=d, P3D3_OUT=f'{OUT}/harness_{tag}')
    p = sp.run(['node', '/tmp/p3d3/run.mjs'], capture_output=True, text=True, timeout=600, env=env)
    txt = p.stdout + p.stderr
    open(f'{OUT}/harness_{tag}_stdout.txt', 'w').write(txt)
    fails = [l for l in txt.splitlines() if l.startswith('FAIL')]
    summ = [l for l in txt.splitlines() if l.startswith('SUMMARY')]
    return {'tag': tag, 'exit': p.returncode, 'failedChecks': fails, 'summary': summ[0] if summ else 'n/a', 'red': p.returncode != 0}

results = []
def run(name, apply_fn, also_harness=False):
    restore()
    apply_fn()
    r = vitest(name)
    print(f"== {name}: vitest exit={r['exit']} {r['summary']} red={r['red']}", flush=True)
    for f in r['failedCases']: print('   RED-CASE:', f, flush=True)
    if also_harness:
        h = bundle(name)
        r['harness'] = h
        print(f"   harness exit={h['exit']} {h['summary']} red={h['red']}", flush=True)
        for f in h['failedChecks']: print('   HARNESS-RED:', f, flush=True)
    results.append(r)

# ── ①a 去掉 reachability 探针（写入被吞 ⇒ 直接降级，不探测真实上限） ──
probe_block = """        if (actual !== result.barSpace && !f.isBase) {
          // 写入被静默吞掉（P0.3 §2.3）⇒ 探测真实上限，再按真实上限**显式降级**
          const probed = this.probeMaxBarSpace(f, Math.max(1, Math.min(result.barSpace, cap)));
          if (isNum(probed) && probed >= 1 && probed < result.barSpace) {
            this.caps.set(f.id, probed);
            result = alignSatelliteBarSpace({
              baseBarSpace: leaderBarSpace,
              density,
              paneWidthPx: paneWidth,
              maxBarSpace: probed,
            });
            this.writeBarSpace(f, result.barSpace);
            actual = this.barSpaceOf(f);
          }
        }
"""
run('M1a_remove_probe', lambda: patch(SRC, probe_block, '        // MUT①a: 探针被移除（直接降级）\n'))

# ── ①b 不尝试完整对齐即降级（违反 fail-closed） ──
run('M1b_direct_degrade', lambda: patch(SRC,
    """    iterations += 1;

    for (;;) {""",
    """    iterations += 1;
    // MUT①b: 直接降级（未尝试完整对齐 / 闭环被移除）
    return { aligned: false, degraded: true, iterations, ...none, reason: 'unreachable' };

    for (;;) {"""), also_harness=True)

# ── ② 允许基准被改写（基准作为 follower） ──
run('M2_base_as_follower', lambda: patch(SRC,
    'const targets = this.members.filter((m) => m !== leader && !m.isBase);',
    'const targets = this.members.filter((m) => m !== leader); // MUT②'))

# ── ③a 桩的定位语义改回「理想贴右缘」（桩不再忠实真身） ──
run('M3a_exact_stub', lambda: patch(STUB,
    'stub.scrollToDataIndex(nearestIndex(ts) + REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS);',
    'stub.scrollToDataIndex(nearestIndex(ts)); // MUT③a: 理想贴右缘'))

# ── ③b 同 ③a + 生产定位退回 scrollToTimestamp（桩完美 ⇒ jsdom 掩盖真身缺陷） ──
def m3b():
    patch(STUB, 'stub.scrollToDataIndex(nearestIndex(ts) + REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS);',
          'stub.scrollToDataIndex(nearestIndex(ts)); // MUT③a: 理想贴右缘')
    patch(SRC, """    if (typeof chart.scrollToDataIndex === 'function') {
      try {
        chart.scrollToDataIndex(index);
        return true;
      } catch {
        /* 回退到 scrollToTimestamp */
      }
    }""", """    // MUT③b: 索引定位被移除（退回 scrollToTimestamp）""")
run('M3b_exact_stub_plus_timestamp', m3b, also_harness=True)

# ── ④ 去掉 barSpace 微调的有界性（放大迭代/步长上限 + 去掉「无改善即停手」） ──
def m4():
    patch(SRC, 'export const MAX_ALIGN_CORRECTION_ITERATIONS = 3;', 'export const MAX_ALIGN_CORRECTION_ITERATIONS = 50; // MUT④')
    patch(SRC, 'export const MAX_BAR_SPACE_STEP_RATIO = 0.5;', 'export const MAX_BAR_SPACE_STEP_RATIO = 50; // MUT④')
    patch(SRC, """        if (Math.abs(edgeDiffMs) >= bestEdgeResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: 'no-improvement' };
        }
""", '')
    patch(SRC, """        if (Math.abs(spanDiffMs) >= bestSpanResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: 'no-improvement' };
        }
""", '')
run('M4_unbounded', m4, also_harness=True)

restore()
json.dump(results, open(f'{OUT}/mutations_summary.json', 'w'), ensure_ascii=False, indent=1)
print('MUTATIONS-SUMMARY', json.dumps([{k: v for k, v in r.items() if k != 'failedCases'} for r in results], ensure_ascii=False))
