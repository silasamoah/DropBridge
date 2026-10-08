import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../server.js';

test('one listener serves both UIs, LAN configuration and isolated signalling', { timeout: 10000 }, async t => {
  const { server } = createServer();
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, clients = [];
  t.after(async () => { clients.forEach(ws => ws.terminate()); await new Promise(resolve => server.close(resolve)); });
  for (const route of ['/', '/files/', '/clipboard/', '/files/js/app.js', '/clipboard/js/app.js', '/files/config']) assert.equal((await fetch(base + route)).status, 200, route);
  assert.match(await (await fetch(base + '/files/')).text(), /\/files\/styles.css/);
  const clipboard = await fetch(base + '/clipboard/');
  assert.match(clipboard.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const config = await (await fetch(base + '/clipboard/api/config')).json();
  assert.equal(config.lanEnabled, true);
  assert.ok(config.addresses.includes(base));
  for (const route of ['/files/server/index.js', '/clipboard/server/index.js', '/signal']) assert.equal((await fetch(base + route)).status, 404);
  for (const tool of ['files', 'clipboard']) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/' + tool + '/signal'); clients.push(ws);
    await once(ws, 'open');
    const reply = once(ws, 'message'); ws.send(JSON.stringify({ type: 'create', name: 'Integration test' }));
    const [raw] = await reply, session = JSON.parse(raw);
    assert.match(session.code, /^\d{6}$/);
    const qr = tool === 'files' ? `/files/qr?code=${session.code}&origin=${encodeURIComponent(base)}` : `/clipboard/api/qr?code=${session.code}&base=${encodeURIComponent(base)}`;
    assert.equal((await fetch(base + qr)).status, 200);
  }
});
