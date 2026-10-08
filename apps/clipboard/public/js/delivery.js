import { messageId, validateText } from './protocol.js';

// Acknowledgements confirm receipt in the remote page, never an OS clipboard write.
export class DeliveryTracker extends EventTarget {
  constructor({ sendText, acknowledge, timeoutMs = 8000 }) {
    super(); Object.assign(this, { sendText, acknowledge, timeoutMs });
    this.seen = new Set(); this.latest = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  change(state, reason) {
    this.latest.state = state; this.latest.reason = reason;
    this.emit('change', { ...this.latest });
  }
  send(text) {
    validateText(text);
    if (this.latest?.state === 'sending') throw new Error('Wait for delivery or retry before sending another message.');
    this.latest = { id: messageId(), text, state: 'ready' };
    this.attempt();
  }
  retry() {
    if (this.latest?.state !== 'failed') throw new Error('No unconfirmed message to retry.');
    this.attempt();
  }
  attempt() {
    clearTimeout(this.timer); this.change('sending');
    // Arm before sending; synchronous test adapters can acknowledge immediately.
    this.timer = setTimeout(() => this.fail('No delivery confirmation. The other device may be paused.'), this.timeoutMs);
    try { this.sendText(this.latest.text, this.latest.id); }
    catch (error) { this.fail(error.message); }
  }
  fail(reason) {
    if (this.latest?.state !== 'sending') return;
    clearTimeout(this.timer); this.change('failed', reason);
  }
  receive(message) {
    if (message.type === 'clipboard:ack') {
      if (this.latest?.id === message.id) { clearTimeout(this.timer); this.change('delivered'); }
      return;
    }
    if (!this.seen.has(message.id)) {
      this.seen.add(message.id);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
      this.emit('text', message.text);
    }
    // Re-acknowledge retries without displaying them twice in this tab.
    try { this.acknowledge(message.id); }
    catch { this.emit('problem', 'Text arrived, but delivery confirmation could not be sent.'); }
  }
  clear() { clearTimeout(this.timer); this.latest = null; this.seen.clear(); this.emit('change', null); }
}
