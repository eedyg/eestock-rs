import type { Bar, Period, SourcesHealth, SymbolSnapshot } from './types';

export interface KlineQuery {
  code: string;
  period: Period;
  before?: string; // 游标：排他上界 ts（向前翻页）
  limit?: number;
}

export interface ApiClient {
  getSymbols(): Promise<SymbolSnapshot[]>;
  getKline(q: KlineQuery): Promise<Bar[]>;
  getSourcesHealth(): Promise<SourcesHealth>;
}

export function createHttpClient(baseUrl = '', fetcher: typeof fetch = fetch): ApiClient {
  async function get<T>(path: string): Promise<T> {
    const res = await fetcher(`${baseUrl}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return (await res.json()) as T;
  }
  return {
    getSymbols: () => get('/api/symbols'),
    getKline: (q) => {
      const params = new URLSearchParams({ code: q.code, period: q.period });
      if (q.before) params.set('before', q.before);
      if (q.limit != null) params.set('limit', String(q.limit));
      return get(`/api/kline?${params.toString()}`);
    },
    getSourcesHealth: () => get('/api/sources/health'),
  };
}
