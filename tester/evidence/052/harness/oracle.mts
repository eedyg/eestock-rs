/**
 * 阶段 3 独立验收 · 离线独立 oracle（与浏览器内渲染路径分离的运行时）。
 * 用源码模块 `dcapIndicator.ts` 的 CORE 计算（computeDcapSeries）对「探针记录的同一条 dataList + 新参数」
 * 逐点复算，与真实 klinecharts 上 DCAP 指标的 result 逐位对照 ⇒ 证明「线值确实按新参数更新」。
 * 运行：cd web && npx vite-node /tmp/acc3/oracle.mts
 */
import fs from 'node:fs';
// 独立 oracle 直接用 CORE 算法源码（tangle 生成物 dcap.ts 的 computeDcapSeries）——与图表接线层无关，
// 也不引入 klinecharts（浏览器专用）。calcParams → params 的映射与 dcapIndicator.ts 同序（8 参）。
import { computeDcapSeries } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcap.ts';

const ORACLE_KEYS = ['n_s', 'n_m', 'n_l', 'r_s', 'r_m', 'r_l', 'smooth', 'm'] as const;
function dcapParamsFromCalcParams(cp: number[]) {
  const o: Record<string, number> = {};
  ORACLE_KEYS.forEach((k, i) => (o[k] = Number(cp[i])));
  return o as { n_s: number; n_m: number; n_l: number; r_s: number; r_m: number; r_l: number; smooth: number; m: number };
}

const files = process.argv.slice(2);
const all = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const perSave = [];
  for (const s of j.saves ?? []) {
    // 用「本次保存期望的新参数」复算（而非回读 chart 上的参数）⇒ 才能验证「线值确实按新参数更新」
    const params = dcapParamsFromCalcParams(s.expectCalcParams ?? s.calcParams);
    const expected = computeDcapSeries(s.closes, params) as Array<Record<string, number | null>>;
    let nCompare = 0;
    let nMismatch = 0;
    let maxAbs = 0;
    let firstMismatch = null;
    const keys = ['s', 'm', 'l'];
    const len = Math.min(expected.length, s.result.length);
    for (let i = 0; i < len; i++) {
      for (const k of keys) {
        const a = expected[i]?.[k] ?? null;
        const b = s.result[i]?.[k] ?? null;
        nCompare++;
        if ((a == null) !== (b == null)) {
          nMismatch++;
          if (!firstMismatch) firstMismatch = { i, k, oracle: a, chart: b };
          continue;
        }
        if (a == null) continue;
        const d = Math.abs((b as number) - (a as number));
        if (d > 1e-12) {
          nMismatch++;
          if (!firstMismatch) firstMismatch = { i, k, oracle: a, chart: b };
        }
        if (d > maxAbs) maxAbs = d;
      }
    }
    const zeroOk = s.result.every((r: Record<string, number | null>) => r == null || r.zero === 0);
    perSave.push({
      id: s.id,
      expectCalcParams: s.expectCalcParams,
      chartCalcParams: s.calcParams,
      dataLen: s.closes.length,
      resultLen: s.result.length,
      nCompare,
      nMismatch,
      maxAbsDelta: +maxAbs.toExponential(4),
      firstMismatch,
      zeroOk,
      oracleNonNull: keys.map((k) => expected.filter((r) => typeof r?.[k] === 'number').length),
    });
  }
  all.push({ file: f, tag: j.tag, mutation: j.mutation, perSave });
}
const outPath = process.env.ORACLE_OUT ?? '/tmp/acc3/oracle.json';
fs.writeFileSync(outPath, JSON.stringify(all, null, 1));
for (const a of all) {
  for (const p of a.perSave) {
    console.log(`${a.tag} ${p.id} expectParams=${JSON.stringify(p.expectCalcParams)} chartParams=${JSON.stringify(p.chartCalcParams)} dataLen=${p.dataLen} compare=${p.nCompare} mismatch=${p.nMismatch} maxAbs=${p.maxAbsDelta} zeroOk=${p.zeroOk}`);
  }
}
console.log('written', outPath);
