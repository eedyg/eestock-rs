// 独立探针（Tester D5-3）：不经仓库测试文件，直接驱动 mock 的 PUT 路径，
// 逐条打印 mock 侧实际结论（status / normalized / error），并与向量 expect 逐字段比对。
import { readFileSync } from 'node:fs';
import { createMockClient } from '../web/src/api/mock';
import { ApiError } from '../web/src/api/types';

const VP = process.argv[2];
const vectors = JSON.parse(readFileSync(VP, 'utf8')) as any[];
const stable = (v: unknown): string => {
  const n = (x: any): any => Array.isArray(x) ? x.map(n)
    : (x !== null && typeof x === 'object')
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, n(x[k])])) : x;
  return JSON.stringify(n(v) ?? null);
};
const out: any[] = [];
for (const v of vectors) {
  const api = createMockClient();
  let status: number | string; let normalized: any = null; let error: string | null = null;
  try {
    const got = await api.saveMultiPeriodConfig(v.input);
    status = 200; normalized = got;
  } catch (e) {
    if (e instanceof ApiError) { status = e.status; error = e.message; } else { status = 'NON-ApiError'; error = String(e); }
  }
  const exp = v.expect;
  const statusMatch = status === exp.status;
  const normMatch = exp.status === 200 ? stable(normalized) === stable(exp.normalized) : null;
  const errMatch = exp.status === 400
    ? (error ?? '').includes(exp.errorMustContain) : null;
  out.push({ name: v.name, expect: exp.status, mock: status, statusMatch, normMatch, errMatch,
    mockNormalized: normalized, mockError: error, expectNormalized: exp.normalized ?? null,
    expectErrorMustContain: exp.errorMustContain ?? null });
}
for (const r of out) {
  console.log(JSON.stringify({ name: r.name, expect: r.expect, mock: r.mock,
    statusMatch: r.statusMatch, normMatch: r.normMatch, errMatch: r.errMatch,
    mockNormalized: r.mockNormalized,
    mockIndicators: r.mockNormalized?.indicators ?? null,
    expectIndicators: r.expectNormalized?.indicators ?? null,
    mockError: r.mockError }));
}
const bad = out.filter((r) => !r.statusMatch || r.normMatch === false || r.errMatch === false);
console.log(`PROBE_SUMMARY total=${out.length} mismatched=${bad.length} names=${JSON.stringify(bad.map((b) => b.name))}`);
