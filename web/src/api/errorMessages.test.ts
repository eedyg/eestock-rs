/**
 * ADR-024 §3.1.1（P5 整改 N1）—— 前端**按 `code` 分支**的错误展示单测。
 * 反假绿：#15「未知码仍可读」用例必须存在（不得只映射已知码）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './types';
import { errorDisplayText, isKnownErrorCode, KNOWN_ERROR_CODES } from './errorMessages';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('errorDisplayText（ADR-024 §3.1.1 code → 中文提示）', () => {
  it('已知码分支：range_empty 回显可用区间 / resource_guard 回显预估 / period_invalid 文案', () => {
    const t1 = errorDisplayText(
      new ApiError(400, '请求区间与可得区间无交集（518880 M1 …）', 'range_empty', {
        available_from: '2026-01-01T00:00:00Z',
        available_to: '2026-02-01T00:00:00Z',
      }),
    );
    expect(t1).toContain('无数据');
    expect(t1).toContain('2026-01-01T00:00:00Z ~ 2026-02-01T00:00:00Z');
    expect(t1).toContain('请求区间与可得区间无交集'); // 服务端原文保留（可诊断）

    const t2 = errorDisplayText(
      new ApiError(400, '预估 770477 根 bar …', 'resource_guard', {
        requested_bars: 770477,
        estimated_secs: 482.398,
        confirmable: true,
      }),
    );
    expect(t2).toContain('770477');
    expect(t2).toContain('可二次确认后重提');

    expect(errorDisplayText(new ApiError(400, 'period 须为 M1/M5/…', 'period_invalid'))).toContain(
      '不支持的周期',
    );
    expect(errorDisplayText(new ApiError(400, 'from 须早于 to', 'from_after_to'))).toContain(
      '开始时间必须早于结束时间',
    );
  });

  it('#15 未知码 ⇒ 回退服务端 message（可读，不吞信息）', () => {
    const e = new ApiError(400, 'HTTP 400: 某个新契约错误：明细如下', 'brand_new_code_2099');
    expect(isKnownErrorCode('brand_new_code_2099')).toBe(false);
    expect(errorDisplayText(e)).toBe('HTTP 400: 某个新契约错误：明细如下');
  });

  it('无 code（旧形状/网络错误）⇒ message 原样', () => {
    expect(errorDisplayText({ message: 'Failed to fetch' })).toBe('Failed to fetch');
    expect(errorDisplayText({})).toBe('请求失败');
  });

  it('已知码不带 detail 时仍给出中文提示（不抛错）', () => {
    expect(errorDisplayText(new ApiError(400, 'range_empty', 'range_empty'))).toContain('无数据');
  });

  it('parity：§3.1.1 列举的四个码必须在映射表内（向量 `empty_intersection`/`resource_guard` 同源）', () => {
    const vectors = JSON.parse(
      readFileSync(resolve(HERE, '../../../design/16-backtest-scalability/contract-vectors.json'), 'utf8'),
    ) as { span_limit_semantics: { empty_intersection: { code: string }; resource_guard: { code: string } } };
    const must = [
      vectors.span_limit_semantics.empty_intersection.code,
      vectors.span_limit_semantics.resource_guard.code,
      'period_invalid',
      'from_after_to',
    ];
    for (const c of must) {
      expect(KNOWN_ERROR_CODES, `缺码 ${c}`).toContain(c);
    }
  });
});
