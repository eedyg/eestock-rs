import { createHttpClient, type ApiClient } from './client';
import { createMockClient } from './mock';

// 默认值站在生产一侧（mock 构建事故根治）：仅 VITE_API_MOCK=1 显式启用契约 mock（09-frontend.md §4）；
// 未设置/'0'/其他值一律直连真后端，防止缺省构建静默出 mock 数据
const useMock = import.meta.env.VITE_API_MOCK === '1';

export const defaultApi: ApiClient = useMock ? createMockClient() : createHttpClient('');
