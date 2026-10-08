import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBridgeServer } from '../server/index.js';

// Optional test tooling; Playwright is not a runtime dependency.
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.error('Browser tests need Playwright. See README → Browser checks.'); process.exit(1); }
const engine = process.env.BROWSER_ENGINE || 'chromium', browserType = playwright[engine];
if (!['chromium', 'webkit', 'firefox'].includes(engine)) throw new Error('Unsupported BROWSER_ENGINE');
const results = [], errors = [];
let bridge, browser;
async function boot(port = 0) {
  bridge = createBridgeServer({ publicUrl: null });
  await new Promise((resolve, reject) => { bridge.server.once('error', reject); bridge.server.listen(port, '127.0.0.1', resolve); });
  return `http://localhost:${bridge.server.address().port}`;
}
async function shutdown() {
  if (!bridge) return;
  for (const ws of bridge.wss.clients) ws.terminate();
  await new Promise(resolve => bridge.wss.close(resolve));
  await new Promise(resolve => bridge.server.close(resolve));
}
async function connected(...pages) {
  for (const page of pages) await page.waitForFunction(() => document.querySelector('#status').textContent === 'Connected', null, { timeout: 30000 });
}
async function send(from, to, text) {
  await from.locator('#outgoing').fill(text); await from.locator('#send').click();
  await to.waitForFunction(value => document.querySelector('#incoming').value === value, text);
  await from.waitForFunction(() => document.querySelector('#delivery-status').dataset.state === 'delivered');
}
try {
  const base = await boot();
  browser = await browserType.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1200, height: 1000 }, ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ...(engine !== 'firefox' ? { isMobile: true } : {}), ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  await phone.addInitScript(() => {
    const original = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data) {
      if (window.dropAcknowledgements && typeof data === 'string' && JSON.parse(data).type === 'clipboard:ack') return;
      return original.call(this, data);
    };
  });
  const a = await desktop.newPage(); let b = await phone.newPage();
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
  await a.goto(base); await a.locator('#create').click();
  await a.locator('#room-code').waitFor({ state: 'visible' });
  await a.waitForFunction(() => document.querySelector('#qr-image').complete && document.querySelector('#qr-image').naturalWidth > 0);
  const code = await a.locator('#room-code').innerText();
  const link = await a.locator('#share-link').getAttribute('href');
  assert.equal(link, `${base}/#room=${code}`);
  await b.goto(link); assert.equal(await b.locator('#code').inputValue(), code);
  assert.equal(new URL(b.url()).hash, '');
  await b.locator('#join').click(); await connected(a, b);
  results.push('QR image renders locally; pairing link prefills code without automatic joining');
  const text = 'Hello 🌍\nA second line <script>plain text</script>';
  await send(a, b, text); await send(b, a, 'Reverse direction ✓');
  results.push('Real WebRTC transfer in both directions with delivery acknowledgements and Unicode');
  if (engine === 'chromium') {
    await b.locator('#copy').click(); await b.waitForFunction(() => document.querySelector('#notice').textContent.includes('Copied'));
    assert.equal((await b.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), text);
    results.push('System clipboard copy on localhost');
  }
  await b.evaluate(() => { window.dropAcknowledgements = true; });
  await a.locator('#outgoing').fill('Confirmation-loss test'); await a.locator('#send').click();
  await b.waitForFunction(() => document.querySelector('#incoming').value === 'Confirmation-loss test');
  const receivedAt = await b.locator('#received-time').innerText();
  await a.waitForFunction(() => document.querySelector('#delivery-status').dataset.state === 'failed', null, { timeout: 12000 });
  await b.evaluate(() => { window.dropAcknowledgements = false; });
  await a.locator('#retry-send').click();
  await a.waitForFunction(() => document.querySelector('#delivery-status').dataset.state === 'delivered');
  assert.equal(await b.locator('#received-time').innerText(), receivedAt);
  results.push('Lost acknowledgement shows Unconfirmed; explicit retry is deduplicated and delivered');
  await a.locator('#outgoing').fill('Draft survives an ordinary resume');
  await b.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await a.waitForFunction(() => document.querySelector('#status').textContent === 'Other device paused');
  assert.match(await a.locator('#recovery-detail').innerText(), /reserved/);
  await b.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await connected(a, b); assert.equal(await a.locator('#outgoing').inputValue(), 'Draft survives an ordinary resume');
  assert.equal(await b.locator('#room-code').innerText(), code);
  results.push('Simulated background/foreground recovery retains room and draft');
  await b.reload(); await connected(a, b); assert.equal(await b.locator('#room-code').innerText(), code);
  await send(b, a, 'After reload'); results.push('Remembered pairing automatically resumes after reload');
  await b.close();
  await a.waitForFunction(() => document.querySelector('#status').textContent === 'Other device paused');
  b = await phone.newPage(); b.on('pageerror', error => errors.push(error.message)); await b.goto(base);
  await b.getByRole('button', { name: `Resume ${code}`, exact: true }).click();
  await connected(a, b); await send(b, a, 'After opening a new tab');
  results.push('A new tab offers explicit resume of the saved pairing');
  await a.locator('#outgoing').fill('Draft survives a network interruption');
  await a.evaluate(() => window.dispatchEvent(new Event('offline')));
  await a.waitForFunction(() => document.querySelector('#status').textContent === 'Network offline');
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await connected(a, b); assert.equal(await a.locator('#outgoing').inputValue(), 'Draft survives a network interruption');
  await send(a, b, 'After network resume'); results.push('Simulated offline/online recovery preserves draft and resumes transfer');
  await a.locator('#outgoing').fill('a'.repeat(12001)); await a.locator('#send').click();
  await a.waitForFunction(() => document.querySelector('#notice').textContent.includes('12 KB'));
  await a.locator('#outgoing').fill('Ready when you are.');
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.UI_ARTIFACT_DIR) {
    await mkdir(process.env.UI_ARTIFACT_DIR, { recursive: true });
    await a.screenshot({ path: join(process.env.UI_ARTIFACT_DIR, 'desktop.png'), fullPage: true });
    await b.screenshot({ path: join(process.env.UI_ARTIFACT_DIR, 'mobile.png'), fullPage: true });
  }
  const port = bridge.server.address().port;
  await shutdown(); await boot(port);
  for (const page of [a,b]) await page.waitForFunction(() => document.querySelector('#status').textContent === 'Ready to pair');
  assert.equal(await a.locator('.saved-pair').count(), 0); results.push('Server restart reconnects safely and invalidates saved pairing');
  await a.locator('#create').click(); await a.locator('#room-code').waitFor({ state: 'visible' });
  await b.locator('#code').fill(await a.locator('#room-code').innerText()); await b.locator('#join').click(); await connected(a,b);
  await b.getByRole('button', { name: 'Forget pairing', exact: true }).click();
  for (const page of [a,b]) await page.waitForFunction(() => document.querySelector('#room-panel').hidden);
  assert.equal(await b.locator('.saved-pair').count(), 0); results.push('Forget pairing revokes server reservation and local saved credentials');
  assert.deepEqual(errors, []);
  results.push('Oversize text validation, mobile layout without horizontal overflow, no browser errors');
  console.log(JSON.stringify({ engine, passed: results, physicalPhones: 'Not tested; see docs/phone-testing.md' }, null, 2));
  if (process.env.UI_ARTIFACT_DIR) await writeFile(join(process.env.UI_ARTIFACT_DIR, 'report.json'), JSON.stringify({ engine, passed: results, errors }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (browser) await browser.close(); await shutdown(); }
