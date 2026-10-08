import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PairingStore, validTicket } from '../public/js/pairing.js';
const storage = () => {
  const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const ticket = code => ({ code, token: randomUUID(), expiresAt: Date.now() + 86400000, remember: true });

test('reload restores the right seat without overwriting another tab’s pairing', () => {
  const local = storage(), tabA = storage(), tabB = storage(), first = ticket('123456'), second = ticket('123456');
  const a = new PairingStore(local, tabA), b = new PairingStore(local, tabB);
  assert.equal(a.save(first), true); b.save(second);
  assert.equal(new PairingStore(local, tabA).active().token, first.token);
  assert.equal(new PairingStore(local, tabB).active().token, second.token);
  assert.equal(a.list().length, 2);
  assert.equal(new PairingStore(local, storage()).active(), null);
  a.forget(first.token); assert.equal(a.active(), null); assert.equal(b.active().token, second.token);
  b.clearActive(); assert.equal(b.active(), null); assert.equal(b.list().length, 1);
  assert.equal(validTicket(first, first.expiresAt), false);
});

test('blocked or corrupted storage falls back to in-memory pairing', () => {
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); }, removeItem() { throw new Error('Blocked'); } };
  const store = new PairingStore(blocked, blocked);
  assert.deepEqual(store.list(), []); assert.equal(store.active(), null); assert.equal(store.save(ticket('123456')), false); assert.doesNotThrow(() => store.forget('x'));
  const corrupt = storage(); corrupt.setItem('clipboardbridge.pairings.v1', '{invalid');
  assert.deepEqual(new PairingStore(corrupt, storage()).list(), []);
});
