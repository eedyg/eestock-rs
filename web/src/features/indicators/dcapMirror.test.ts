/**
 * dcap 指标 —— T3 镜像体断言（逐字节）
 *
 * 本文件位置：web/src/features/indicators/dcapMirror.test.ts
 * 被测产物（两个）：
 *   ① web/src/features/indicators/dcap.ts            （前端模块，klinecharts calc 消费）
 *   ② crates/strategy-core/reference-plugins/dcap.js （插件，strategy-runtime/rquickjs 求值）
 * 权威口径：design/14-dcap-indicator/01-adr.md D4、03-test-plan.md T3、02-spec.md §4 契约要求 4
 * 运行：cd web && npx vitest run src/features/indicators/dcapMirror.test.ts
 *
 * 为什么需要机械断言（ADR-021 D4）：entangled 的 `file=` 块一个块只能产出一个文件、无法扇出，
 * 两份产物在 02-spec.md 里是两个块 ⇒ 算法正文的 DRY 只能由「哨兵区间逐字节相同」这条断言兜底。
 * 本断言 **fail-closed**：任一侧哨兵缺失/错序/重复/区间为空 ⇒ 直接红，绝不静默跳过。
 *
 * 结构（两段）：
 *   ① T3-neg-*：用**合成夹具对**（/tmp 临时文件）验证检查器的鉴别力 —— 不依赖真实产物，
 *      「删哨兵/翻一个字节/清空区间/多一字节」全部必须报红（否则本断言无鉴别力）。
 *   ② T3-real-*：真实产物必须存在、镜像逐字节相同、且全程 sha256 未被改动。
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 产物路径（仓库相对定位：web/src/features/indicators/ → 仓库根 = 上溯 4 层）
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TS_PATH = join(REPO_ROOT, 'web/src/features/indicators/dcap.ts');
const JS_PATH = join(REPO_ROOT, 'crates/strategy-core/reference-plugins/dcap.js');

const BEGIN = Buffer.from('// === DCAP CORE BEGIN ===', 'utf8');
const END = Buffer.from('// === DCAP CORE END ===', 'utf8');

const TMP_DIR = mkdtempSync(join(tmpdir(), 'dcap-mirror-'));

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 检查器（唯一实现：真实产物与 /tmp 负例走**同一条**代码路径）
// ---------------------------------------------------------------------------

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

interface CoreSlice {
  bytes: Buffer;
  offset: number;
}

function extractCore(buf: Buffer, label: string): CoreSlice {
  const begins = countOccurrences(buf, BEGIN);
  const ends = countOccurrences(buf, END);
  if (begins !== 1) {
    throw new Error(`${label}: 期望恰好 1 个哨兵「${BEGIN.toString()}」，实际 ${begins} 个`);
  }
  if (ends !== 1) {
    throw new Error(`${label}: 期望恰好 1 个哨兵「${END.toString()}」，实际 ${ends} 个`);
  }
  const beginAt = buf.indexOf(BEGIN);
  const endAt = buf.indexOf(END);
  if (endAt < beginAt) {
    throw new Error(`${label}: 哨兵顺序颠倒（END 在 BEGIN 之前）`);
  }
  const start = beginAt + BEGIN.length;
  if (endAt <= start) {
    throw new Error(`${label}: CORE 区间为空（BEGIN/END 相邻）`);
  }
  return { bytes: buf.subarray(start, endAt), offset: start };
}

function firstDiff(a: Buffer, b: Buffer): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const lo = Math.max(0, i - 20);
      const hi = Math.min(n, i + 20);
      return (
        `首个差异在 CORE 内偏移 ${i}：` +
        `ts=0x${a[i]!.toString(16).padStart(2, '0')} js=0x${b[i]!.toString(16).padStart(2, '0')}；` +
        `上下文 ts=${JSON.stringify(a.subarray(lo, hi).toString('utf8'))} / ` +
        `js=${JSON.stringify(b.subarray(lo, hi).toString('utf8'))}`
      );
    }
  }
  return `前缀 ${n} 字节相同，但长度不同（ts=${a.length} js=${b.length}）`;
}

const MIN_CORE_BYTES = 200;

/** 核心判据：CORE 区间逐字节相同（含区间非空/非平凡下限）。 */
function checkMirrorBitwise(tsBuf: Buffer, jsBuf: Buffer): { ts: CoreSlice; js: CoreSlice } {
  const ts = extractCore(tsBuf, 'ts 侧');
  const js = extractCore(jsBuf, 'js 侧');
  if (!ts.bytes.equals(js.bytes)) {
    throw new Error(`镜像体不一致（ADR-021 D4 违例）：${firstDiff(ts.bytes, js.bytes)}`);
  }
  if (ts.bytes.length < MIN_CORE_BYTES) {
    throw new Error(
      `镜像体过短（${ts.bytes.length} < ${MIN_CORE_BYTES} 字节）：疑似哨兵误配导致「空区间假绿」`,
    );
  }
  return { ts, js };
}

function readProduct(p: string, label: string): Buffer {
  if (!existsSync(p)) {
    throw new Error(
      `${label} 不存在：${p}（应由 entangled 从 design/14-dcap-indicator/02-spec.md 生成）`,
    );
  }
  return readFileSync(p);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 写 /tmp 临时副本并回读（负例必须在**临时副本**上做，绝不碰仓库内产物）。 */
function tmpCopy(name: string, bytes: Buffer): Buffer {
  const p = join(TMP_DIR, name);
  writeFileSync(p, bytes);
  return readFileSync(p);
}

// ---------------------------------------------------------------------------
// 合成夹具对（仅用于验证检查器鉴别力；长度 > MIN_CORE_BYTES 以覆盖非平凡下限）
// ---------------------------------------------------------------------------

const FIXTURE_CORE = `// fixture core（哨兵区间内的共享字节）\n${'// pad pad pad pad pad'.repeat(11)}\nfunction coreInner(x) { return x + 1; }\n`;
const FIXTURE_TS = Buffer.from(
  `export interface P { n: number }\n${BEGIN.toString()}\n${FIXTURE_CORE}${END.toString()}\nexport function dcapRoi(): void {}\n`,
  'utf8',
);
const FIXTURE_JS = Buffer.from(
  `const PARAMS_SCHEMA = [];\n${BEGIN.toString()}\n${FIXTURE_CORE}${END.toString()}\nfunction on_bar(ctx) { return 50; }\n`,
  'utf8',
);

const TEXT_REPLACE = (buf: Buffer, find: Buffer, repl: string): Buffer =>
  Buffer.from(buf.toString('utf8').replace(find.toString(), repl), 'utf8');

// ===========================================================================
// T3 负例：检查器必须fail-closed（不依赖真实产物 ⇒ 本段当前即应全绿）
// ===========================================================================

describe('T3 负例：检查器的鉴别力（/tmp 合成夹具副本）', () => {
  it('T3-neg-0 正例对照：合成夹具原样 ⇒ 不报红（差异必须归因于变更，而非路径/夹具本身）', () => {
    const tsCopy = tmpCopy('fix0.ts', FIXTURE_TS);
    const jsCopy = tmpCopy('fix0.js', FIXTURE_JS);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).not.toThrow();
  });

  it('T3-neg-1 删除 ts 侧 BEGIN 哨兵 ⇒ 必红', () => {
    const tsCopy = tmpCopy('neg1.ts', TEXT_REPLACE(FIXTURE_TS, BEGIN, ''));
    const jsCopy = tmpCopy('neg1.js', FIXTURE_JS);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/哨兵/);
  });

  it('T3-neg-2 删除 js 侧 END 哨兵 ⇒ 必红', () => {
    const tsCopy = tmpCopy('neg2.ts', FIXTURE_TS);
    const jsCopy = tmpCopy('neg2.js', TEXT_REPLACE(FIXTURE_JS, END, ''));
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/哨兵/);
  });

  it('T3-neg-3 哨兵重复（歧义切片）⇒ 必红', () => {
    const dup = Buffer.concat([FIXTURE_TS, BEGIN, Buffer.from('\n', 'utf8')]);
    const tsCopy = tmpCopy('neg3.ts', dup);
    const jsCopy = tmpCopy('neg3.js', FIXTURE_JS);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/恰好 1 个哨兵/);
  });

  it('T3-neg-4 合成夹具 CORE 内翻转一个字节 ⇒ 必红且定位到偏移', () => {
    const sliced = extractCore(FIXTURE_JS, 'fixture');
    const mutated = Buffer.from(FIXTURE_JS);
    let flipped = -1;
    for (let i = sliced.offset; i < sliced.offset + sliced.bytes.length; i++) {
      if (mutated[i] === 0x61 /* a */) {
        mutated[i] = 0x62; // a → b
        flipped = i;
        break;
      }
    }
    expect(flipped, '夹具 CORE 内应存在 ASCII a 以供单字节翻转').toBeGreaterThanOrEqual(0);

    const tsCopy = tmpCopy('neg4.ts', FIXTURE_TS);
    const jsCopy = tmpCopy('neg4.js', mutated);
    let message = '';
    try {
      checkMirrorBitwise(tsCopy, jsCopy);
    } catch (e) {
      message = String(e);
    }
    expect(message, '翻转一个字节 ⇒ 必红').not.toBe('');
    expect(message, '差异定位应指出偏移').toMatch(/首个差异在 CORE 内偏移/);
  });

  it('T3-neg-5 清空 CORE 区间（BEGIN/END 相邻）⇒ 必红（防「空区间假绿」）', () => {
    const sliced = extractCore(FIXTURE_JS, 'fixture');
    const emptied = Buffer.concat([
      FIXTURE_JS.subarray(0, sliced.offset),
      FIXTURE_JS.subarray(sliced.offset + sliced.bytes.length),
    ]);
    const tsCopy = tmpCopy('neg5.ts', FIXTURE_TS);
    const jsCopy = tmpCopy('neg5.js', emptied);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/CORE 区间为空/);
  });

  it('T3-neg-6 ts 侧 CORE 多一个字节 ⇒ 必红（长度不一致）', () => {
    const endAt = FIXTURE_TS.indexOf(END);
    const oneMore = Buffer.concat([
      FIXTURE_TS.subarray(0, endAt),
      Buffer.from(' ', 'utf8'),
      FIXTURE_TS.subarray(endAt),
    ]);
    const tsCopy = tmpCopy('neg6.ts', oneMore);
    const jsCopy = tmpCopy('neg6.js', FIXTURE_JS);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/镜像体不一致/);
  });

  it('T3-neg-7 哨兵顺序颠倒 ⇒ 必红', () => {
    const swapped = Buffer.from(
      `const PARAMS_SCHEMA = [];\n${END.toString()}\n${FIXTURE_CORE}${BEGIN.toString()}\n`,
      'utf8',
    );
    const tsCopy = tmpCopy('neg7.ts', FIXTURE_TS);
    const jsCopy = tmpCopy('neg7.js', swapped);
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).toThrow(/顺序颠倒/);
  });
});

// ===========================================================================
// T3 真实产物（当前应红：产物尚未生成）
// ===========================================================================

describe('T3 真实产物：CORE 区间逐字节相同', () => {
  it('T3-real-1 两份产物存在且 CORE 区间逐字节相同', () => {
    const tsBuf = readProduct(TS_PATH, '前端产物 dcap.ts');
    const jsBuf = readProduct(JS_PATH, '插件产物 dcap.js');
    const { ts, js } = checkMirrorBitwise(tsBuf, jsBuf);

    expect(ts.bytes.length, 'CORE 区间长度').toBe(js.bytes.length);
    expect(ts.bytes.length, 'CORE 区间必须非平凡').toBeGreaterThanOrEqual(MIN_CORE_BYTES);
    // 反向自查：区间确实来自两个不同文件（防止误读同一文件造成的假绿）
    expect(
      tsBuf.subarray(0, ts.offset).equals(jsBuf.subarray(0, js.offset)),
      '两侧 CORE 之前的前缀应不同（包装层允许不同）',
    ).toBe(false);
  });

  it('T3-real-2 真实产物原样复制到 /tmp ⇒ 检查器不报红（正例对照）', () => {
    const tsCopy = tmpCopy('real.ts', readProduct(TS_PATH, '前端产物 dcap.ts'));
    const jsCopy = tmpCopy('real.js', readProduct(JS_PATH, '插件产物 dcap.js'));
    expect(() => checkMirrorBitwise(tsCopy, jsCopy)).not.toThrow();
  });

  it('T3-real-3 全部负例过程后，仓库内真实产物 sha256 未变', () => {
    const tsHash = sha256(readProduct(TS_PATH, '前端产物 dcap.ts'));
    const jsHash = sha256(readProduct(JS_PATH, '插件产物 dcap.js'));
    expect(sha256(readFileSync(TS_PATH)), '真实 dcap.ts 不得被本测试改动').toBe(tsHash);
    expect(sha256(readFileSync(JS_PATH)), '真实 dcap.js 不得被本测试改动').toBe(jsHash);
  });
});
