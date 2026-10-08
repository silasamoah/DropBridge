import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferWakeLock } from '../public/js/wake-lock.js';

test('wake lock follows active transfer and foreground visibility', async () => {
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let requests = 0, releases = 0;
  globalThis.document = doc; globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request: async () => {
    requests++;
    const lock = new EventTarget();
    lock.release = async () => { releases++; lock.dispatchEvent(new Event('release')); };
    return lock;
  } } } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    const wake = new TransferWakeLock();
    wake.setActive(true); await settle(); assert.equal(requests, 1);
    wake.setActive(true); await settle(); assert.equal(requests, 1);
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); await settle();
    assert.equal(releases, 1);
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await settle();
    assert.equal(requests, 2);
    wake.setActive(false); await settle(); assert.equal(releases, 2);
    window.isSecureContext = false;
    wake.setActive(true); await settle(); assert.equal(requests, 2);
  } finally {
    globalThis.document = oldDocument; globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  }
});
