const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

(async () => {
  await fs.mkdir('.test-artifacts', { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chromium', args: process.env.TEST_DISABLE_MDNS === '1' ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [] });
  const context = await browser.newContext({ acceptDownloads: true });
  const otherContext = await browser.newContext({ acceptDownloads: true });
  const instrument = () => {
    window.__sockets = []; window.__pcs = []; window.__ready = []; window.__acked = 0;
    const Socket = WebSocket, PC = RTCPeerConnection;
    window.WebSocket = class extends Socket { constructor(...args) { super(...args); window.__sockets.push(this); } };
    window.RTCPeerConnection = class extends PC { constructor(...args) { super(...args); window.__pcs.push(this); } };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'ready') window.__ready.push(msg);
        if (msg.type === 'ack') window.__acked = msg.offset;
      } else if (window.__corruptNext && data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data.slice(0)); bytes[24] ^= 1; data = bytes.buffer; window.__corruptNext = false;
      }
      return send.call(this, data);
    };
  };
  await Promise.all([context.addInitScript(instrument), otherContext.addInitScript(instrument)]);
  const a = await context.newPage(), b = await otherContext.newPage(), errors = [];
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
  const base = process.env.DROPNO_URL || 'http://localhost:3000';
  async function connected() { await Promise.all([a.locator('#status.connected').waitFor(), b.locator('#status.connected').waitFor()]); }
  async function saveEquals(page, name, bytes) {
    const row = page.locator('.received-item').filter({ hasText: name });
    await row.waitFor({ timeout: 90000 });
    const promise = page.waitForEvent('download'); await row.locator('.download').click();
    const download = await promise;
    assert.equal(download.suggestedFilename(), name);
    assert.deepEqual(await fs.readFile(await download.path()), bytes);
  }
  async function send(from, to, name, bytes) {
    await from.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await saveEquals(to, name, bytes);
    await from.waitForFunction(() => document.querySelector('#progress-text').textContent === 'Delivered · Verified', null, { timeout: 90000 });
  }
  try {
    await Promise.all([a.goto(base), b.goto(base)]);
    await Promise.all([a.waitForFunction(() => !document.querySelector('#create').disabled), b.waitForFunction(() => !document.querySelector('#create').disabled)]);
    await a.locator('#device-name').fill('Laptop'); await a.locator('#device-name').dispatchEvent('change');
    await b.locator('#device-name').fill('Phone'); await b.locator('#device-name').dispatchEvent('change');
    await a.locator('#create').click(); await a.locator('#code').waitFor({ state: 'visible' });
    const code = await a.locator('#code').textContent();
    await b.goto(`${base}/?room=${code}`); await connected();
    assert.match(await a.locator('#peer-name').textContent(), /Phone/);
    assert.equal(await a.locator('#accept').count(), 0);
    assert.equal(await a.locator('#qr').evaluate(img => img.complete && img.naturalWidth > 0), true);
    console.log('PASS pairing link, QR image, device names and no acceptance step');
    const originalCode = await b.locator('#code').textContent();
    await a.evaluate(() => window.__sockets.at(-1).close());
    await a.waitForFunction(() => window.__sockets.length >= 2 && window.__sockets.at(-1).readyState === WebSocket.OPEN);
    await connected(); assert.equal(await b.locator('#code').textContent(), originalCode);
    console.log('PASS signalling reconnect retains pairing and direct channel');
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 111);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i * 31 % 256;
    await send(a, b, 'large.bin', bytes);
    await send(b, a, 'reverse.txt', Buffer.from('Reverse direction'));
    console.log('PASS automatic large-file transfer and reverse transfer: saved bytes match');
    await a.locator('#file').setInputFiles([
      { name: 'queue-one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: 'queue-three.txt', mimeType: 'text/plain', buffer: Buffer.from('three') },
    ]);
    await saveEquals(b, 'queue-one.txt', Buffer.from('one'));
    await saveEquals(b, 'empty.txt', Buffer.alloc(0));
    await saveEquals(b, 'queue-three.txt', Buffer.from('three'));
    console.log('PASS multi-file queue and empty file integrity');
    const drop = await b.evaluateHandle(() => {
      const dt = new DataTransfer(); dt.items.add(new File(['dropped'], 'drag.txt')); return dt;
    });
    await b.locator('#drop').dispatchEvent('drop', { dataTransfer: drop }); await drop.dispose();
    await saveEquals(a, 'drag.txt', Buffer.from('dropped'));
    console.log('PASS drag and drop');
    await Promise.all([send(a, b, 'duplex-a.txt', Buffer.alloc(65537, 0x31)), send(b, a, 'duplex-b.txt', Buffer.alloc(65539, 0x32))]);
    console.log('PASS simultaneous transfers in both directions');
    await a.locator('#trust-device').click();
    assert.match(await a.locator('#identity-status').textContent(), /Trusted device/);
    assert.match(await b.locator('#storage-status').textContent(), /disk storage/);
    await b.reload(); await connected();
    assert.match(await a.locator('#identity-status').textContent(), /Trusted device/);
    assert.equal(await b.locator('#code').textContent(), originalCode);
    await saveEquals(b, 'large.bin', bytes);
    console.log('PASS disk-backed completed files and private pairing survive page reload');
    console.log('PASS trusted device key survives reload and is signature-verified again');
    const resumable = Buffer.alloc(12 * 1024 * 1024 + 17, 0x37);
    await b.evaluate(() => { window.__acked = 0; window.__ready = []; });
    await a.locator('#file').setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: resumable });
    await b.waitForFunction(() => window.__acked >= 262144);
    const before = await b.evaluate(() => window.__acked);
    assert.ok(before < resumable.length);
    await b.evaluate(() => { window.__pcs.at(-1).close(); window.__sockets.at(-1).close(); });
    await b.waitForFunction(() => window.__ready.some(msg => msg.offset > 0), null, { timeout: 90000 });
    await saveEquals(b, 'resume.bin', resumable);
    assert.ok(await b.evaluate(() => window.__ready.at(-1).offset) >= before);
    console.log(`PASS interrupted transfer resumes from confirmed offset (${before} bytes), final bytes match`);
    await a.evaluate(() => { window.__corruptNext = true; });
    await a.locator('#file').setInputFiles({ name: 'corrupt.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await b.waitForFunction(() => document.querySelector('#message').textContent.includes('Checksum mismatch'), null, { timeout: 90000 });
    assert.equal(await b.locator('.received-item').filter({ hasText: 'corrupt.bin' }).count(), 0);
    console.log('PASS checksum mismatch discards corrupted file');
    await b.evaluate(() => { window.__acked = 0; });
    await a.locator('#file').setInputFiles({ name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: resumable });
    await b.waitForFunction(() => window.__acked >= 131072);
    await a.locator('#cancel').click();
    await b.waitForFunction(() => document.querySelector('#message').textContent.includes('cancelled'));
    assert.equal(await b.locator('.received-item').filter({ hasText: 'cancel.bin' }).count(), 0);
    await send(a, b, 'after-cancel.txt', Buffer.from('still works'));
    console.log('PASS cancellation cleans partial data and next file works');
    await a.locator('#disconnect').click();
    await b.waitForFunction(() => document.querySelector('#status').textContent === 'Ready to pair');
    assert.equal(await b.locator('#file').isDisabled(), true);
    await b.locator('#join-code').fill('000000'); await b.locator('#join').click();
    await b.waitForFunction(() => document.querySelector('#message').textContent.includes('Room not found'));
    console.log('PASS explicit disconnect and invalid room error');
    await b.locator('#clear-files').click(); await b.locator('#received').waitFor({ state: 'hidden' });
    await a.setViewportSize({ width: 390, height: 844 });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.screenshot({ path: '.test-artifacts/mobile.png', fullPage: true });
    await b.setViewportSize({ width: 1280, height: 1000 }); await b.screenshot({ path: '.test-artifacts/desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS clearing files, responsive layout and no page errors');
    const memoryContext = await browser.newContext({ acceptDownloads: true });
    await memoryContext.addInitScript(() => {
      Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    });
    const m1 = await memoryContext.newPage(), m2 = await memoryContext.newPage();
    for (const page of [m1, m2]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([m1.goto(base), m2.goto(base)]);
    await m1.locator('#create').click(); await m1.locator('#code').waitFor({ state: 'visible' });
    await m2.locator('#join-code').fill(await m1.locator('#code').textContent()); await m2.locator('#join').click();
    await Promise.all([m1.locator('#status.connected').waitFor(), m2.locator('#status.connected').waitFor()]);
    assert.match(await m2.locator('#storage-status').textContent(), /in memory/);
    assert.equal(await m2.locator('#trust-device').isVisible(), false);
    await send(m1, m2, 'memory.txt', Buffer.from('fallback works'));
    const limits = await m2.evaluate(async () => {
      const { ReceiveStorage, MEMORY_LIMIT } = await import(new URL('js/storage.js', location.href).href);
      const storage = new ReceiveStorage(); await storage.init();
      const full = await storage.open({ id: 'budget-test', size: MEMORY_LIMIT });
      let refused = false;
      try { await storage.open({ id: 'too-large', size: 1 }); } catch { refused = true; }
      await full.remove(); const next = await storage.open({ id: 'small', size: 1 }); await next.remove();
      return { refused, remaining: storage.memoryBytes };
    });
    assert.deepEqual(limits, { refused: true, remaining: 0 });
    await m2.locator('#clear-files').click(); await m2.locator('#received').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS memory fallback, total memory budget and releasing received files');
  } catch (error) {
    console.log('DEBUG A', await a.locator('body').innerText());
    console.log('DEBUG B', await b.locator('body').innerText());
    console.log('PAGE ERRORS', errors); throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });


