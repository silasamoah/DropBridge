import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import qrcode from 'qrcode-generator';
import { attachSignalling } from './rooms.js';

const root = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
export function createServer() {
  const iceServers = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : process.env.STUN_URL ? [{ urls: process.env.STUN_URL }] : [];
  if (!Array.isArray(iceServers)) throw new Error('ICE_SERVERS must be a JSON array.');
  let rooms;
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/config') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ iceServers, iceTransportPolicy: process.env.RELAY_ONLY === '1' ? 'relay' : 'all' }));
      }
      if (url.pathname === '/qr') {
        const code = url.searchParams.get('code'), origin = new URL(url.searchParams.get('origin'));
        if (!rooms.has(code) || origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) { res.writeHead(400); return res.end('Invalid room'); }
        const qr = qrcode(0, 'M'); qr.addData(`${origin.origin}/files/?room=${code}`); qr.make();
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }));
      }
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = path.resolve(root, '.' + name);
      if (!target.startsWith(root + path.sep) || !types[path.extname(target)]) { res.writeHead(404); return res.end(); }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': types[path.extname(target)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  const signalling = attachSignalling(server); rooms = signalling.rooms;
  server.on('close', () => signalling.wss.close());
  return { server, ...signalling };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { server, wss } = createServer();
    const port = Number(process.env.PORT || 3000);
    let startupFailed = false;
    const startupError = error => {
      if (startupFailed) return;
      startupFailed = true;
      if (error.code === 'EADDRINUSE') console.error(`Dropno could not start: port ${port} is already in use.\nOpen the existing instance, stop it, or use another port in PowerShell:\n  $env:PORT = '3001'; npm start`);
      else console.error(`Dropno could not start: ${error.message}`);
      wss.close(); process.exitCode = 1;
    };
    server.on('error', startupError); wss.on('error', startupError);
    server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Dropno ready: http://localhost:${server.address().port}`));
  } catch (error) { console.error(`Dropno could not start: ${error.message}`); process.exitCode = 1; }
}
