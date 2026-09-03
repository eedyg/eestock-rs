import { createHttpClient, type ApiClient } from './client';
import { createMockClient } from './mock';

// 后端 Phase A 并行期默认走契约 mock（09-frontend.md §4）；VITE_API_MOCK=0 切真后端
const useMock = import.meta.env.VITE_API_MOCK !== '0';

export const defaultApi: ApiClient = useMock ? createMockClient() : createHttpClient('');
