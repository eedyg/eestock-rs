/** P5.5-C 临时静态服务 + 反向代理（GET 只读转发到 127.0.0.1:8081；/ws 直接断开）。
 *  临时实例，验收后拆除。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.P55C_ROOT ?? '/tmp/p55c_dist';
const PORT = Number(process.env.P55C_PORT ?? 5392);
const TARGET = { host: '127.0.0.1', port: 8081 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const p = http.request(
      { ...TARGET, method: req.method, path: req.url, headers: { ...req.headers, host: `${TARGET.host}:${TARGET.port}` } },
      (up) => {
        // 反向代理只允许只读：任何写请求直接 405（防止误写线上）
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    p.on('error', () => {
      res.writeHead(502).end('proxy error');
    });
    if (req.method === 'GET' || req.method === 'HEAD') req.pipe(p);
    else {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end('{"error":"write blocked by acceptance proxy"}');
      req.resume();
    }
    return;
  }
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(PORT, '127.0.0.1', () => console.log(`p55c static+proxy on http://127.0.0.1:${PORT}`));
