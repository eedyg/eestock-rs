/**
 * 红/事实固定（P2-A）：**T8 的「禁止本地聚合」代码级门禁 + 取数 period 非硬编码**。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodNoLocalAggregation.test.ts`
 * 权威依据：`design/15-multi-period/02-spec.md` §5（「**禁止本地聚合**（口径：P4 实测本地 1m 聚合与后端
 * 高周期仅 50/208 桶一致）——每周期必须直接取后端 bar」）、§8（「本地聚合替代高周期 bar」列为**明确不做**）；
 * `03-test-plan.md` T8「禁止本地聚合：断言实现中不存在『用 1m 聚合出的高周期』路径（代码级 + 行为级）」。
 *
 * 说明（诚实标注）：本文件是**代码级事实固定**，在当前工作树（P2 前）即为**绿**——因为工作树里本来就
 * 没有任何 bar 聚合实现；它的价值是**反向证据**：一旦实现引入「本地聚合/降分辨率复用」路径，本文件必红。
 * 行为级（每周期请求命中各自 period）在 `multiPeriodSatellite.test.ts` T8-1/T8-4（当前红）。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../..');

/** 生产源码文件（排除测试与测试基建：`src/test/**`、`*.test.*`）。 */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(p);
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

/** 本地聚合/降分辨率复用的典型命名（口径 §5/§8 明令禁止的实现形态）。 */
const AGGREGATION_HELPER_RE =
  /\b(aggregateBars|resampleBars|rollUpBars|rollupBars|barsToPeriod|toHigherPeriod|aggregateToPeriod|bucketBars|downsampleBars|mergeBarsIntoPeriod|fromOneMinuteBars)\b/;

const FILES = productionSources();

describe('T8 禁止本地聚合（代码级门禁）', () => {
  it('防空扫：扫描范围未塌缩（≥40 个生产源文件）', () => {
    expect(FILES.length, '扫描到的生产源文件数（防空扫）').toBeGreaterThanOrEqual(40);
    expect(FILES.some((f) => f.endsWith(path.join('features', 'dashboard', 'feed.ts')))).toBe(true);
  });

  it('不存在「本地聚合/降分辨率复用」实现（一旦引入必红）', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (AGGREGATION_HELPER_RE.test(line)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1} ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders, '禁止本地聚合（02-spec §5/§8）：高周期 bar 必须直接取后端').toEqual([]);
  });

  it('阳性对照：取数直接携带实例自己的 period（无中间聚合层）', () => {
    const feed = fs.readFileSync(path.join(SRC_ROOT, 'features/dashboard/feed.ts'), 'utf8');
    const occurrences = feed.match(/period:\s*this\.deps\.period/g) ?? [];
    expect(
      occurrences.length,
      'feed.ts 每次取数必须直接携带 `this.deps.period`（初始化 + 分页 + 兜底三条路径）',
    ).toBeGreaterThanOrEqual(3);
  });

  it('取数 period 不得硬编码为具体周期字面量（防止「取 1m 再派生高周期」）', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/getKline\(\s*\{([^}]*)\}/gs)) {
        if (/period:\s*['"]/.test(m[1]!)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${m[0]!.replace(/\s+/g, ' ').slice(0, 140)}`);
        }
      }
    }
    expect(offenders, 'getKline 的 period 必须来自实例/请求上下文，不得硬编码周期字面量').toEqual([]);
  });

  it('多周期容器（若已存在）不得内置周期换算表/聚合路径', () => {
    const mp = FILES.filter((f) => /MultiPeriod|multiPeriod/.test(path.basename(f)));
    expect(mp.length, '多周期生产源文件必须存在（P1 已入库）').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of mp) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/(60_000|60000)\s*[*/]|periodMs\s*[*/]|multiplier/i.test(line)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1} ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders, '多周期容器不得出现周期换算/聚合系数（对齐由 P3 的 ChartSyncGroup 负责）').toEqual([]);
  });
});
