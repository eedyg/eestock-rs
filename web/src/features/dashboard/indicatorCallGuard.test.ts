import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 裸调用门禁（P0.1-A）：源码内**不得**存在“在已有指标的 pane 上以 `isStack=false` 或省略
 * `isStack` 创建指标”的调用。
 *
 * 为什么需要源码级门禁（而不只是行为测试）：该坑零告警（`index.esm.js:15267` 只在“指标未注册”
 * 时 `logWarn`），且 `createIndicator` 照常返回 id（`:15292`）⇒ 运行时“看起来成功”。
 * 唯一能提前拦住任意新增调用点的手段是**静态扫描**（03-test-plan T7 末条 “grep 断言”）。
 *
 * P0.1-D（按 A 方案加强，逐条强于初版）：
 *  ① 扫描面仍是 `web/src/**` **全部**调用点（不缩小）；
 *  ② 调用点**文件白名单** = `{overlayIndicator.ts, KlineChart.tsx}`（两处 MA 都改走唯一入口后，
 *     原地调用点消失 ⇒ 白名单由"样本清单"升级为**强制**约束：新文件里的裸调用一律判红）；
 *  ③ 每个调用点必须**显式** `isStack=true` —— 初版只查 `false` 与"非入口处的省略"，允许传变量
 *     绕过；现改为"非字面 `true` 即判红"（更严）；
 *  ④ 入口模块额外断言：先 `removeIndicator` 再 `createIndicator`（顺序契约）+ `getIndicators` 非空断言；
 *  ⑤ 防空扫：断言扫描到的生产源码文件数 ≥ 30，且白名单文件均**真**扫到调用点。
 *
 * 依据：`design/15-multi-period/02-spec.md` §4.3；`tester/report/165_ma_candle_pane_root_cause.md`。
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // web/src/features/dashboard
const SRC_DIR = resolve(HERE, '../..'); // web/src
/** 唯一允许封装 `createIndicator` 的入口模块（省略 isStack 仅在此文件内被容忍）。 */
const ENTRY_MODULE = join(HERE, 'overlayIndicator.ts');

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

/** 去掉注释但**保持字节偏移不变**（非换行字符替换为空格）⇒ 行号可直接由索引推得。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      const stop = end === -1 ? src.length : end;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 `(` 起做括号配平，返回匹配的 `)` 索引（无则 -1）。字符串/模板串内忽略。 */
function matchParen(code: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 顶级逗号切分实参（忽略字符串与嵌套括号/花括号/方括号内的逗号）。 */
function splitTopLevelArgs(text: string): string[] {
  const args: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      cur += ch;
      if (ch === '\\') {
        cur += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  args.push(cur);
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

interface IndicatorCallSite {
  /** 相对 `web/src` 的路径。 */
  file: string;
  line: number;
  /** 第二个实参原文；省略时为 `undefined`。 */
  isStackArg: string | undefined;
}

/** 收集 `X.createIndicator(...)` 调用点（要求成员访问，避免把方法**定义**当成调用）。 */
function collectCreateIndicatorCalls(file: string, src: string): IndicatorCallSite[] {
  const code = stripComments(src);
  const sites: IndicatorCallSite[] = [];
  const re = /\.\s*createIndicator\s*\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const openIndex = m.index + m[0].length - 1;
    const closeIndex = matchParen(code, openIndex);
    if (closeIndex === -1) continue;
    const args = splitTopLevelArgs(code.slice(openIndex + 1, closeIndex));
    sites.push({
      file,
      line: code.slice(0, openIndex).split('\n').length,
      isStackArg: args[1],
    });
  }
  return sites;
}

/** 生产源码清单：`web/src/**` 去掉测试用例与测试基建目录。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('__')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  walk(SRC_DIR);
  return out;
}

const SCANNED_FILES: string[] = sourceFiles();
const ALL_CALLS: IndicatorCallSite[] = SCANNED_FILES.flatMap((full) =>
  collectCreateIndicatorCalls(relative(SRC_DIR, full), readFileSync(full, 'utf8')),
);

/**
 * 允许出现 `createIndicator` 调用点的文件白名单（P0.1-D 按**入口化**收敛）。
 *
 * 为什么从 `{KlineChart.tsx, GridCell.tsx}` 改成 `{overlayIndicator.ts, KlineChart.tsx}`：
 * 两处 MA 都已改走唯一入口 ⇒ 原地调用点消失；白名单成为**强制**约束（新增叠加指标一律走入口，
 * 否则本门禁判红），而不是原先那份「只要这两个文件还有调用点就算扫到」的样本清单。
 */
const EXPECTED_CALL_FILES = [
  'features/dashboard/overlayIndicator.ts',
  'features/dashboard/KlineChart.tsx',
] as const;

/** 已扫描的生产源码文件数下限（防空扫：目录改名/过滤规则写错时立刻判红，而不是"零违规"通过）。 */
const MIN_SCANNED_FILES = 30;

const describeCall = (site: IndicatorCallSite): string =>
  `${site.file}:${site.line}  isStack=${site.isStackArg ?? '（省略）'}`;

// ---------------------------------------------------------------------------
// 门禁
// ---------------------------------------------------------------------------

describe('指标调用门禁：禁止在已有 pane 上以 isStack=false 创建指标（G2 静默消失防护）', () => {
  it('扫描器自身有效性：白名单文件均扫到调用点，且扫描范围未塌缩（防空扫通过）', () => {
    expect(
      SCANNED_FILES.length,
      '扫描到的生产源码文件数异常偏少 ⇒ 扫描器过滤规则疑似写错（防空扫）',
    ).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    const files = new Set(ALL_CALLS.map((site) => site.file));
    for (const expected of EXPECTED_CALL_FILES) {
      expect(files.has(expected), `${expected} 的 createIndicator 调用点未被扫到（扫描器失效）`).toBe(true);
    }
    expect(ALL_CALLS.length).toBeGreaterThanOrEqual(2);
  });

  it('调用点只能出现在白名单文件（新增叠加指标必须走入口 overlayIndicator.ts）', () => {
    const files = [...new Set(ALL_CALLS.map((site) => site.file))].sort();
    const unexpected = files.filter(
      (file) => !(EXPECTED_CALL_FILES as readonly string[]).includes(file),
    );
    expect(
      unexpected,
      '白名单外的 createIndicator 调用点：叠加指标一律走 addOverlayIndicator（唯一入口）',
    ).toEqual([]);
  });

  it('每个 createIndicator 调用点都必须**显式** isStack=true（false / 省略 / 变量一律判红）', () => {
    const violations = ALL_CALLS.filter((site) => site.isStackArg !== 'true');
    expect(
      violations.map(describeCall),
      '只有显式 true 才是「追加」；false 与省略都会整 pane 替换（index.esm.js:14162-14165），' +
        '传变量则无法静态判定 ⇒ 一律禁止',
    ).toEqual([]);
  });

  it('入口模块 overlayIndicator.ts：显式 isStack=true 追加 + 先 remove 后 create + getIndicators 非空断言', () => {
    const src = readFileSync(ENTRY_MODULE, 'utf8');
    const calls = collectCreateIndicatorCalls('features/dashboard/overlayIndicator.ts', src);
    expect(calls.length, '入口模块必须真的调用 createIndicator').toBeGreaterThan(0);
    for (const site of calls) {
      expect(site.isStackArg, `${describeCall(site)} —— 入口必须以 true 追加`).toBe('true');
    }
    // 入口必须带「非空断言」，否则"静默不生效"无法被发现（02-spec §4.3）
    expect(src).toMatch(/getIndicators\s*\(/);
    // 顺序契约：remove 必须先于 create（去注释后按字节偏移比较，注释里的同一关键词不参与）
    const code = stripComments(src);
    const removeAt = code.indexOf('removeIndicator');
    const createAt = code.indexOf('createIndicator');
    expect(removeAt, '入口必须显式移除旧同名实例').toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(removeAt);
  });
});
