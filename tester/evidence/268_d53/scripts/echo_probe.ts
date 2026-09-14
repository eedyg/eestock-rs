// 独立探针：mock PUT 去重后 GET 回显/内存态是否也是去重形态（item 2 的「落库/回显」）
import { createMockClient } from '../web/src/api/mock';
const api = createMockClient();
const put = await api.saveMultiPeriodConfig({ enabled: true, periods: ['1m','5m'], heights: {'1m':420,'5m':180}, indicators: ['dcap','dcap'] });
const get = await api.getMultiPeriodConfig();
console.log('PUT_ECHO', JSON.stringify(put.indicators));
console.log('GET_AFTER_PUT', JSON.stringify(get.indicators), JSON.stringify(get));
const api2 = createMockClient();
let code: unknown = null;
try { await api2.saveMultiPeriodConfig({ enabled: false, periods: [], heights: {}, indicators: ['dcap'] }); } catch (e: any) { code = e.status; }
const after = await api2.getMultiPeriodConfig();
console.log('REJECTED_THEN_GET', 'status=' + String(code), JSON.stringify(after));
