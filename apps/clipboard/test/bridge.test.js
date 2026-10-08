import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../server/index.js';
import { encodeText, decodeText } from '../public/js/protocol.js';

test('text contract preserves Unicode, rejects unsupported and oversized payloads', () => {
  const text = '  Hello 🌍\nSecond line\t';
  assert.equal(decodeText(encodeText(text)), text);
  assert.throws(() => encodeText(''));
  assert.throws(() => encodeText('🌍'.repeat(3001)));
  assert.throws(() => decodeText('{"version":2,"type":"clipboard:text","text":"x"}'));
  assert.throws(() => decodeText('{"version":1,"type":"clipboard:text","text":3}'));
  assert.throws(() => decodeText('not json'));
  assert.doesNotThrow(() => encodeText('a'.repeat(12000)));
});

test('HTTP, pairing, relay, validation, room capacity and cleanup', async t => {
  const { server, wss } = createBridgeServer({ publicUrl: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`);
    clients.push(ws);
    ws.inbox = []; ws.waiters = [];
    ws.on('message', raw => { const msg = JSON.parse(raw); const waiter = ws.waiters.shift(); if (waiter) waiter(msg); else ws.inbox.push(msg); });
    await once(ws, 'open');
    return ws;
  };
  const next = ws => ws.inbox.length ? Promise.resolve(ws.inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for server')), 2000);
    ws.waiters.push(msg => { clearTimeout(timer); resolve(msg); });
  });
  const send = (ws, msg) => ws.send(JSON.stringify(msg));
  const base = `http://127.0.0.1:${port}`;
  // A second startup on an occupied port should exit cleanly with useful guidance.
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill(), 5000);
  const [exitCode] = await once(child, 'close');
  clearTimeout(watchdog);
  assert.equal(exitCode, 1);
  assert.match(stderr, /already in use/);
  assert.doesNotMatch(stderr, /Unhandled 'error'/);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ClipboardBridge/);
  assert.equal((await fetch(`${base}/server/index.js`)).status, 404);
  assert.equal((await fetch(`${base}/js/peer.js`)).status, 200);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.lanEnabled, false); assert.equal(config.defaultUrl, base);
  const qr = await fetch(`${base}/api/qr?code=123456&base=${encodeURIComponent(base)}`);
  assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type'), /svg/); assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(`${base}/api/qr?code=123456&base=https%3A%2F%2Funrelated.example`)).status, 400);
  assert.equal((await fetch(`${base}/api/qr?code=invalid&base=${encodeURIComponent(base)}`)).status, 400);
  const a = await connect(), b = await connect(), c = await connect();
  a.send('bad JSON'); assert.equal((await next(a)).type, 'error');
  send(b, { type: 'join', code: 'abc' }); assert.match((await next(b)).message, /six-digit/);
  send(b, { type: 'join', code: '000000' }); assert.match((await next(b)).message, /not found/);
  send(a, { type: 'create' }); const created = await next(a);
  assert.match(created.code, /^\d{6}$/);
  send(a, { type: 'create' }); assert.equal((await next(a)).type, 'error');
  send(b, { type: 'join', code: created.code }); const joined = await next(b); assert.equal(joined.type, 'joined');
  const initialReady = await next(a);
  assert.equal(initialReady.initiator, true); assert.equal((await next(b)).initiator, false);
  send(c, { type: 'join', code: created.code }); assert.match((await next(c)).message, /two devices/);
  for (const [from, to, data] of [[a, b, { type: 'offer', sdp: 'test offer' }], [b, a, { type: 'answer', sdp: 'test answer' }], [a, b, { type: 'candidate', candidate: { candidate: 'test' } }]]) {
    send(from, { type: 'signal', data, session: initialReady.session }); assert.deepEqual((await next(to)).data, data);
  }
  b.close(); assert.equal((await next(a)).type, 'peer-paused');
  send(c, { type: 'join', code: created.code }); assert.match((await next(c)).message, /two devices/);
  send(c, { type: 'resume', code: created.code, token: 'wrong token' }); assert.equal((await next(c)).type, 'resume-rejected');
  const resumedClient = await connect();
  send(resumedClient, { type: 'resume', code: created.code, token: joined.token }); assert.equal((await next(resumedClient)).type, 'resumed');
  const resumedReady = await next(a); await next(resumedClient);
  assert.notEqual(resumedReady.session, initialReady.session);
  // Stale candidate must be dropped, so the next relayed message is the new offer.
  send(a, { type: 'signal', data: { type: 'candidate', candidate: {} }, session: initialReady.session });
  send(a, { type: 'signal', data: { type: 'offer', sdp: 'fresh offer' }, session: resumedReady.session });
  assert.equal((await next(resumedClient)).data.sdp, 'fresh offer');
  send(a, { type: 'clipboard:text', text: 'must not relay' }); assert.equal((await next(a)).type, 'error');
  send(a, { type: 'leave' }); assert.equal((await next(a)).type, 'left'); assert.equal((await next(resumedClient)).type, 'peer-left');
  send(c, { type: 'join', code: created.code }); assert.match((await next(c)).message, /not found/);
  send(resumedClient, { type: 'create' }); const newRoom = await next(resumedClient);
  send(a, { type: 'join', code: newRoom.code }); await next(a); await next(a); await next(resumedClient);
  a.close(); assert.equal((await next(resumedClient)).type, 'peer-paused');
});

test('reserved room expires after its reconnect grace period', async t => {
  const { server, wss } = createBridgeServer({ reconnectGraceMs: 80, heartbeatMs: 25, publicUrl: null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/signal`); clients.push(ws); await once(ws, 'open');
  const createdMessage = once(ws, 'message'); ws.send('{"type":"create"}');
  const room = JSON.parse((await createdMessage)[0]);
  const expired = once(ws, 'message'); ws.send('{"type":"suspend"}');
  assert.equal(JSON.parse((await expired)[0]).type, 'expired');
  const rejected = once(ws, 'message'); ws.send(JSON.stringify({ type: 'resume', code: room.code, token: room.token }));
  assert.equal(JSON.parse((await rejected)[0]).type, 'resume-rejected');
});
