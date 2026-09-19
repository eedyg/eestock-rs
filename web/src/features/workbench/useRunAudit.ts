import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunAudit } from '@/api/types';

/**
 * ADR-026 §2.4：执行完整度审计的**按需**取数（与 `useRunSeries` 同风格的三态）。
 *
 * - **懒加载**：只有 `enabled`（= 当前 Tab 需要审计数据）且 run 有结果时才发请求；
 *   未打开的 Tab、无结果的 run、未选中 run 一律**不发请求**（审计要扫 `per_bar`，有真实成本）。
 * - **不重复打请求**：同一 run 的审计只取一次（切 Tab / 重渲染不重取）；`retry()` 显式重取。
 * - 三态：`loading` / `error`（+ `retry`）/ 数据（`data.recorded=false` 的「未记录」由渲染侧显式表达）。
 */
export interface RunAuditState {
  data: WorkbenchRunAudit | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useRunAudit({
  api,
  runId,
  enabled,
}: {
  api: ApiClient;
  runId: string | null;
  enabled: boolean;
}): RunAuditState {
  const [data, setData] = useState<WorkbenchRunAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** 已取数（或已发出请求）的键：`runId#nonce` —— 同键即复用，杜绝切 Tab 重复请求。 */
  const fetchedKeyRef = useRef<string | null>(null);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !runId) return () => undefined;
    const key = `${runId}#${nonce}`;
    if (fetchedKeyRef.current === key) return () => undefined;
    fetchedKeyRef.current = key;
    let alive = true;
    setData(null); // 切换 run / 重试 ⇒ 不残留上一次的审计数据
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const audit = await api.getRunAudit(runId);
        if (alive) {
          setData(audit);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, runId, enabled, nonce]);

  return { data, loading, error, retry };
}
