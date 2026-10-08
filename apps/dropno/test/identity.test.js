import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DeviceIdentity } from '../public/js/identity.js';
import { sha256, hex } from '../public/js/hash.js';

class Channel extends EventTarget {
  send(data) {
    if (this.mutate) data = this.mutate(data);
    queueMicrotask(() => this.other.dispatchEvent(new MessageEvent('message', { data })));
  }
  close() { this.dispatchEvent(new Event('close')); this.other.dispatchEvent(new Event('close')); }
}
async function identity() {
  const instance = new DeviceIdentity();
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  instance.privateKey = keys.privateKey;
  instance.publicKey = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const key = instance.publicKey;
  instance.id = hex(sha256(new TextEncoder().encode(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))));
  return instance;
}
test('mutual device proofs verify and changed signatures are rejected', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const items = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => items.get(key) || null, setItem: (key, value) => items.set(key, value) } });
  try {
  const first = await identity(), second = await identity();
  const a = new Channel(), b = new Channel(); a.other = b; b.other = a;
  const [peerB, peerA] = await Promise.all([first.authenticate(a), second.authenticate(b)]);
  assert.equal(peerB.id, second.id); assert.equal(peerB.verified, true);
  assert.equal(peerA.id, first.id); assert.equal(peerA.verified, true);
  first.trust(peerB, 'Phone'); assert.equal(first.isTrusted(peerB), true); assert.equal(first.isTrusted(peerA), false);
  const restored = new DeviceIdentity(); assert.equal(restored.isTrusted(peerB), true);
  restored.forget(peerB.id); assert.equal(restored.isTrusted(peerB), false);
  const c = new Channel(), d = new Channel(); c.other = d; d.other = c;
  c.mutate = text => {
    const msg = JSON.parse(text);
    if (msg.type === 'identity-proof') msg.signature = (msg.signature[0] === '0' ? '1' : '0') + msg.signature.slice(1);
    return JSON.stringify(msg);
  };
  const pendingC = first.authenticate(c).catch(error => error);
  await assert.rejects(second.authenticate(d), /signature verification failed/);
  c.close(); await pendingC;
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
});
