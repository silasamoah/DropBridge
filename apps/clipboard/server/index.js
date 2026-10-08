import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode-svg';
import { RoomManager } from './room-manager.js';
import { connectionOptions } from './network.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']],
  ...['app', 'signalling', 'peer', 'clipboard', 'protocol', 'delivery', 'pairing', 'setup'].map(name => [`/js/${name}.js`, [`js/${name}.js`, 'text/javascript']]),
]);
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'self'",
};
export function createBridgeServer({ reconnectGraceMs = 120000, heartbeatMs = 30000, pairingLifetimeMs = 86400000, publicUrl = process.env.PUBLIC_URL } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers).end('Method not allowed'); return; }
      if (url.pathname === '/api/config') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(connectionOptions(req, server, publicUrl))); return;
      }
      if (url.pathname === '/api/qr') {
        const code = url.searchParams.get('code'), base = url.searchParams.get('base'), config = connectionOptions(req, server, publicUrl);
        if (!/^\d{6}$/.test(code || '') || (!config.addresses.includes(base) && base !== `https://${req.headers.host}`)) { res.writeHead(400, headers).end('Invalid pairing address or room code'); return; }
        const svg = new QRCode({ content: `${base}/clipboard/#room=${code}`, width: 224, height: 224, padding: 4, ecl: 'M', join: true, xmlDeclaration: false }).svg();
        res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' }); res.end(req.method === 'HEAD' ? undefined : svg); return;
      }
      const asset = assets.get(url.pathname);
      if (!asset) { res.writeHead(404, headers).end('Not found'); return; }
      const body = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { ...headers, 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500, headers).end('Unable to serve request'); }
  });
  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024 });
  // ws forwards HTTP listen errors; the HTTP server's caller reports them.
  wss.on('error', () => {});
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const rooms = new RoomManager({ send, reconnectGraceMs, pairingLifetimeMs });
  wss.on('connection', (ws, req) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin).origin;
        if (new URL(origin).host !== req.headers.host && origin !== publicUrl) { ws.close(1008, 'Origin rejected'); return; }
      } catch { ws.close(1008, 'Invalid origin'); return; }
    }
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => rooms.pause(ws, true)); ws.on('close', () => rooms.pause(ws, true));
    let windowStart = Date.now(), count = 0;
    ws.on('message', (raw, binary) => {
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); count = 0; }
      if (++count > 120) { ws.close(1008, 'Too many requests'); return; }
      try {
        if (binary) throw new Error('Text signalling messages only');
        rooms.handle(ws, JSON.parse(raw.toString()));
      } catch (error) { send(ws, { type: 'error', message: error instanceof SyntaxError ? 'Invalid JSON' : error.message }); }
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { rooms.pause(ws, true); ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
    rooms.sweep();
  }, heartbeatMs);
  timer.unref(); server.on('close', () => clearInterval(timer));
  return { server, wss, rooms };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createBridgeServer();
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use on ${host}. Stop the existing server or choose another PORT (PowerShell: $env:PORT = '3001'; npm start).`
      : `Server error: ${error.message}`); process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`ClipboardBridge: http://${host}:${port}`));
}
