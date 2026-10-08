import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('an occupied port produces a friendly error and exits cleanly', async t => {
  const { server, wss } = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(server.address().port) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(stderr, /already in use/);
  assert.match(stderr, /3001/);
  assert.doesNotMatch(stderr, /Unhandled 'error'/);
});

test('static files, QR, pairing, reserved reconnect tokens and cleanup', { timeout: 10000 }, async t => {
  const { server, wss } = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  assert.equal((await fetch(base)).status, 200);
  assert.match(await (await fetch(base)).text(), /dropno/);
  assert.equal((await fetch(base + '/js/transfer.js')).status, 200);
  assert.equal((await fetch(base + '/package.json')).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  async function client() {
    const ws = new WebSocket(base.replace('http', 'ws') + '/signal');
    clients.push(ws); await once(ws, 'open');
    const queue = [], waiters = [];
    ws.on('message', data => { const msg = JSON.parse(data); if (waiters.length) waiters.shift()(msg); else queue.push(msg); });
    return { ws, send: data => ws.send(JSON.stringify(data)), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)) };
  }
  const a = await client(), b = await client(), c = await client();
  a.send({ type: 'create' }); const created = await a.next();
  assert.match(created.code, /^\d{6}$/);
  b.send({ type: 'join', code: created.code });
  assert.equal((await b.next()).type, 'joined');
  const paired = await a.next(); assert.equal(paired.initiator, true);
  assert.equal((await b.next()).initiator, false);
  c.send({ type: 'join', code: created.code }); assert.equal((await c.next()).type, 'error');
  a.send({ type: 'signal', epoch: paired.epoch, data: { candidate: { candidate: 'test' } } });
  assert.equal((await b.next()).data.candidate.candidate, 'test');
  a.send({ type: 'leave' }); assert.equal((await b.next()).type, 'peer-left');
  c.send({ type: 'join', code: created.code }); assert.equal((await c.next()).type, 'error');
  c.ws.send('{bad json'); assert.equal((await c.next()).type, 'error');
  c.ws.send(Buffer.from([1, 2, 3])); assert.equal((await c.next()).type, 'error');
  a.send({ type: 'create' }); const second = await a.next();
  const qr = await fetch(`${base}/qr?code=${second.code}&origin=${encodeURIComponent(base)}`);
  assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
  b.send({ type: 'join', code: second.code });
  await b.next(); await a.next(); await b.next();
  a.send({ type: 'ping' }); assert.equal((await a.next()).type, 'pong');
  a.ws.terminate();
  assert.equal((await b.next()).type, 'peer-offline');
  c.send({ type: 'join', code: second.code }); assert.equal((await c.next()).type, 'error');
  const replacement = await client();
  replacement.send({ type: 'resume', token: second.token, name: 'Returning phone' });
  const resumed = await replacement.next();
  assert.equal(resumed.type, 'resumed'); assert.equal(resumed.code, second.code);
  assert.equal((await b.next()).type, 'peer-online');
  replacement.send({ type: 'restart', epoch: resumed.epoch });
  assert.equal((await replacement.next()).epoch, resumed.epoch + 1);
  assert.equal((await b.next()).type, 'paired');
  c.send({ type: 'resume', token: 'wrong-token' }); assert.equal((await c.next()).type, 'resume-expired');
  const clone = await client(), oldClosed = once(replacement.ws, 'close');
  clone.send({ type: 'resume', token: second.token });
  assert.equal((await clone.next()).type, 'resumed');
  assert.equal((await b.next()).type, 'peer-online');
  assert.equal((await oldClosed)[0], 4001);
  clone.send({ type: 'leave' }); assert.equal((await b.next()).type, 'peer-left');
  c.send({ type: 'resume', token: second.token }); assert.equal((await c.next()).type, 'resume-expired');
});
