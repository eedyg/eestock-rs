import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQL 清理工具（写操作纪律：测试用真实标的、测试后 SQL 清理、留台账）。
 *
 * 连接目标：宿主机暴露的 timescaledb（docker-compose ports 5433:5432）。
 * 默认 127.0.0.1:5433、user/pass/db 均为 eestock；可用 E2E_DB_* 环境变量覆盖。
 *
 * 口径（tester/report/006 §10 同源）：DELETE FROM symbols/kline_raw/kline_accurate/
 * source_health_events/alert_events WHERE code='<code>'，清理后复核计数归零。
 */

const here = dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = resolve(here, '..');
export const LEDGER = resolve(E2E_ROOT, 'sql-ledger.md');

const dbEnv = {
  ...process.env,
  PGHOST: process.env.E2E_DB_HOST ?? '127.0.0.1',
  PGPORT: process.env.E2E_DB_PORT ?? '5433',
  PGUSER: process.env.E2E_DB_USER ?? 'eestock',
  PGPASSWORD: process.env.E2E_DB_PASS ?? 'eestock',
  PGDATABASE: process.env.E2E_DB_NAME ?? 'eestock',
};

export function psql(sql: string): string {
  // 从 stdin 喂 SQL，规避 shell 引号转发问题（psql -At 无表头）
  return execSync('psql -X -q -At', { env: dbEnv, input: sql }).toString().trim();
}

/** 各业务表按 code 清理（无外键级联，需逐表删除；连续聚合自动刷新不残留行）。
 * alert_events 的实体标识列是 `source`（07-app-plane 告警线格式），非 `code`。 */
const CLEAN_TABLES = [
  ['symbols', 'code'],
  ['kline_raw', 'code'],
  ['kline_accurate', 'code'],
  ['source_health_events', 'code'],
  ['alert_events', 'source'],
] as const;

export function countCode(code: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, col] of CLEAN_TABLES) {
    out[t] = Number(psql(`SELECT count(*) FROM ${t} WHERE ${col}='${code}';`));
  }
  return out;
}

/** 记录台账（append），供报告引用；返回台账行文本 */
function ledger(action: string, code: string, detail: string): string {
  const line = `- ${new Date().toISOString()}  [${action}] code=${code}  ${detail}\n`;
  if (!existsSync(dirname(LEDGER))) mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, line, 'utf8');
  return line;
}

/** 清理一个测试标的并写台账，返回删除前后计数 */
export function cleanupSymbol(code: string): Record<string, string> {
  const before = countCode(code);
  for (const [t, col] of CLEAN_TABLES) {
    psql(`DELETE FROM ${t} WHERE ${col}='${code}';`);
  }
  const after = countCode(code);
  ledger(
    'cleanup',
    code,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}（全表归零复核）`,
  );
  return { before: JSON.stringify(before), after: JSON.stringify(after) };
}

/** 测试开始前的兜底清理（确保无残留，幂等） */
export function preClean(code: string): void {
  for (const [t, col] of CLEAN_TABLES) {
    psql(`DELETE FROM ${t} WHERE ${col}='${code}';`);
  }
}
