import { useCallback, useEffect, useRef, useState } from 'react';

/** 区域三态切片（与 quality/store AsyncSlice 同构）；reload 用于错误占位「重试」。 */
export interface ApiSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * 页面⑧ 只读区域通用异步加载：loading/error/data 三态 + reload。
 * 用 ref 持最新 load，避免父组件内联箭头函数导致无限重载。
 */
export function useApiSlice<T>(load: () => Promise<T>): ApiSlice<T> & { reload: () => void } {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<ApiSlice<T>>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRef.current().then(
      (data) => {
        if (alive) setState({ data, loading: false, error: null });
      },
      (e: Error) => {
        if (alive) setState({ data: null, loading: false, error: e.message });
      },
    );
    return () => {
      alive = false;
    };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
