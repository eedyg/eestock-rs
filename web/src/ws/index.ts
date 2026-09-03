import { WsClient } from './WsClient';

// 单连接 /ws（00-shell）；经 Vite dev proxy 转发（09-frontend.md §6）
export const defaultWs = new WsClient({
  url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
});
