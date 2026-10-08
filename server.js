import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createFiles } from './apps/dropno/server/index.js';
import { createBridgeServer } from './apps/clipboard/server/index.js';

export function createServer() {
  const files = createFiles(), clipboard = createBridgeServer();
  const mounts = { '/files': files, '/clipboard': clipboard };
  function resolve(req) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    for (const [prefix, app] of Object.entries(mounts)) {
      if (pathname.startsWith(prefix + '/')) {
        req.url = req.url.slice(prefix.length);
        return app;
      }
    }
  }
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (mounts[pathname]) { res.writeHead(308, { Location: pathname + '/' }); return res.end(); }
    const app = resolve(req);
    if (app) return app.server.emit('request', req, res);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    const asset = { '/': ['index.html', 'text/html'], '/shell.css': ['shell.css', 'text/css'], '/shell.js': ['shell.js', 'text/javascript'] }[pathname];
    if (!asset) { res.writeHead(404); return res.end('Not found'); }
    try {
      const body = await readFile(new URL('./public/' + asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500); res.end('Unable to serve UI'); }
  });
  clipboard.server.address = () => server.address();
  server.on('upgrade', (req, socket, head) => {
    const app = resolve(req);
    if (!app || new URL(req.url, 'http://localhost').pathname !== '/signal') return socket.destroy();
    app.server.emit('upgrade', req, socket, head);
  });
  server.on('close', () => {
    for (const app of Object.values(mounts)) {
      for (const ws of app.wss.clients) ws.terminate();
      app.server.emit('close');
      app.wss.close();
    }
  });
  return { server, files, clipboard };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createServer();
  const port = Number(process.env.PORT || 3000);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Choose another PORT.` : error.message); process.exit(1); });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`DropBridge ready: http://localhost:${server.address().port}`));
}
