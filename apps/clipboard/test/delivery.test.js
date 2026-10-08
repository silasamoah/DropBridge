import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryTracker } from '../public/js/delivery.js';
import { decodeMessage, encodeAck, encodeText, messageId } from '../public/js/protocol.js';

test('acknowledgements, lost confirmation, retry and duplicate suppression', () => {
  let dropAck = true, received = 0, latestId;
  const sender = new DeliveryTracker({ sendText(text, id) { latestId = id; receiver.receive(decodeMessage(encodeText(text, id))); }, acknowledge() {} });
  const receiver = new DeliveryTracker({ sendText() {}, acknowledge(id) { if (!dropAck) sender.receive(decodeMessage(encodeAck(id))); } });
  receiver.addEventListener('text', () => received++);
  sender.send('Hello 🌍');
  assert.equal(sender.latest.state, 'sending'); assert.equal(received, 1);
  sender.receive(decodeMessage(encodeAck(messageId()))); assert.equal(sender.latest.state, 'sending');
  sender.fail('Connection dropped before confirmation'); assert.equal(sender.latest.state, 'failed');
  assert.equal(sender.latest.text, 'Hello 🌍');
  dropAck = false; sender.retry();
  assert.equal(sender.latest.id, latestId); assert.equal(sender.latest.state, 'delivered'); assert.equal(received, 1);
  const oldId = latestId;
  dropAck = true; sender.send('Another message'); sender.receive(decodeMessage(encodeAck(oldId)));
  assert.equal(sender.latest.state, 'sending'); assert.equal(received, 2);
  sender.clear(); receiver.clear();
});

test('missing confirmation times out without reporting delivery', { timeout: 2000 }, async () => {
  const tracker = new DeliveryTracker({ sendText() {}, acknowledge() {}, timeoutMs: 20 });
  const failed = new Promise(resolve => tracker.addEventListener('change', event => { if (event.detail?.state === 'failed') resolve(event.detail); }));
  tracker.send('Unconfirmed text'); const transfer = await failed;
  assert.equal(transfer.text, 'Unconfirmed text'); assert.match(transfer.reason, /confirmation/);
  tracker.clear();
});

test('invalid input and transport failure keep an accurate delivery state', () => {
  const tracker = new DeliveryTracker({ sendText() { throw new Error('Disconnected'); }, acknowledge() {} });
  assert.throws(() => tracker.send('x'.repeat(12001))); assert.equal(tracker.latest, null);
  tracker.send('Draft'); assert.equal(tracker.latest.state, 'failed'); assert.equal(tracker.latest.reason, 'Disconnected');
  assert.throws(() => decodeMessage('{"version":2,"type":"clipboard:ack","id":"malformed"}'));
  tracker.clear();
});
