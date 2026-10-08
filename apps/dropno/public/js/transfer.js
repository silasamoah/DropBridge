import { sha256, hex, hashFile, transferId } from './hash.js';
import { DISK_LIMIT, MEMORY_LIMIT } from './storage.js';

const CHUNK = 16 * 1024, WINDOW = 128 * 1024, HEADER = 24;
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// One persistent controller per tab. Channels may be replaced while File
// objects, receive sinks, incremental hashes and queued files remain alive.
export class Transfer extends EventTarget {
  constructor(storage) {
    super(); this.storage = storage; this.queue = []; this.completed = new Map(); this.cancelled = new Set();
    this.generation = 0; this.incoming = Promise.resolve();
    this.monitor = setInterval(() => {
      if (!this.connected || document.visibilityState !== 'visible') return;
      const t = this.tx;
      if (t && t.sha && Date.now() - t.activity > 30000) { this.pause(); this.emit('stalled'); }
    }, 5000);
  }
  get connected() { return this.channel?.readyState === 'open'; }
  get current() { return this.tx || this.rx; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  state() { this.emit('state', { queue: this.queue, sending: this.tx, receiving: this.rx, connected: this.connected }); }
  control(type, extra = {}) {
    if (!this.connected) return false;
    this.channel.send(JSON.stringify({ type, ...extra })); return true;
  }
  attach(channel) {
    this.pause(); this.channel = channel; this.peerReady = false;
    const generation = this.generation;
    this.onMessage = event => {
      this.incoming = this.incoming.then(async () => {
        if (generation !== this.generation) return;
        try { await this.receive(event.data); }
        catch (error) { await this.receiveError(error.message); }
      }).catch(error => this.emit('error', error.message));
    };
    this.onClose = () => { if (this.channel === channel) { this.pause(); this.emit('disconnected'); } };
    channel.addEventListener('message', this.onMessage); channel.addEventListener('close', this.onClose);
    this.incoming = this.incoming.then(() => {
      if (generation !== this.generation) return;
      this.control('hello', { version: 2, maxSize: this.storage.disk ? DISK_LIMIT : MEMORY_LIMIT });
      this.state();
    });
  }
  pause() {
    this.generation++;
    if (this.channel) { this.channel.removeEventListener('message', this.onMessage); this.channel.removeEventListener('close', this.onClose); }
    this.channel = null; this.peerReady = false;
    if (this.tx?.sha) this.progress(this.tx, 'Paused · Waiting to reconnect');
    if (this.rx) this.progress(this.rx, 'Paused · Waiting to reconnect');
    this.state();
  }
  progress(t, stage, bytes = t.direction === 'send' ? t.acked : t.bytes) {
    t.stage = stage;
    const elapsed = Math.max((performance.now() - (t.started || performance.now())) / 1000, .01);
    this.emit('progress', { id: t.meta.id, name: t.meta.name, size: t.meta.size, bytes,
      speed: Math.max(0, bytes - (t.base || 0)) / elapsed, direction: t.direction, stage });
    this.state();
  }
  enqueue(files) {
    if (files.length + this.queue.length > 100) throw new Error('Queue up to 100 files at a time.');
    for (const file of files) {
      if (file.size > DISK_LIMIT) throw new Error(`${file.name} exceeds the 8 GiB limit.`);
    }
    for (const file of files) this.queue.push({ id: transferId(), file });
    this.state(); void this.next();
  }
  removeQueued(id) { this.queue = this.queue.filter(item => item.id !== id); this.state(); }
  async next() {
    if (this.tx || !this.queue.length || this.disposed) return;
    const item = this.queue.shift();
    const t = this.tx = { file: item.file, meta: { id: item.id, name: item.file.name, size: item.file.size },
      direction: 'send', acked: 0, sent: 0, activity: Date.now(), started: performance.now() };
    this.progress(t, 'Checking file');
    try {
      t.sha = await hashFile(t.file, bytes => { if (this.tx === t) this.progress(t, 'Checking file', bytes); }, () => this.tx !== t);
      if (this.tx !== t) return;
      t.meta.sha = t.sha; t.activity = Date.now();
      this.progress(t, this.connected ? 'Preparing transfer' : 'Queued · Waiting to reconnect', 0);
      this.offer();
    } catch (error) { if (this.tx === t) { this.tx = null; this.emit('error', error.message); this.state(); void this.next(); } }
  }
  offer() {
    const t = this.tx;
    if (!t?.sha || !this.connected || !this.peerReady) return;
    if (t.meta.size > this.peerLimit) { void this.cancelSend('The receiving browser cannot store a file this large.'); return; }
    t.activity = Date.now(); this.progress(t, 'Connecting transfer', t.acked);
    this.control('offer', { meta: t.meta });
  }
  async pump(t, generation) {
    t.started = performance.now(); t.base = t.acked;
    this.progress(t, t.acked ? 'Resuming' : 'Sending');
    while (this.tx === t && this.connected && this.generation === generation) {
      if (t.sent === t.meta.size && t.acked === t.meta.size) {
        this.control('end', { id: t.meta.id }); this.progress(t, 'Verifying receipt'); return;
      }
      if (t.sent === t.meta.size || t.sent - t.acked >= WINDOW || this.channel.bufferedAmount > WINDOW * 2) { await delay(10); continue; }
      const data = await t.file.slice(t.sent, t.sent + CHUNK).arrayBuffer();
      if (this.tx !== t || !this.connected || this.generation !== generation) return;
      const packet = new Uint8Array(HEADER + data.byteLength);
      for (let i = 0; i < 16; i++) packet[i] = parseInt(t.meta.id.slice(i * 2, i * 2 + 2), 16);
      new DataView(packet.buffer).setFloat64(16, t.sent);
      packet.set(new Uint8Array(data), HEADER);
      this.channel.send(packet.buffer); t.sent += data.byteLength;
    }
  }
  async receive(data) {
    if (typeof data !== 'string') {
      if (!(data instanceof ArrayBuffer) || data.byteLength <= HEADER || data.byteLength > HEADER + CHUNK) throw new Error('Invalid file chunk.');
      const id = hex(new Uint8Array(data, 0, 16));
      if (this.cancelled.has(id) || this.completed.has(id)) return;
      const r = this.rx;
      if (!r || id !== r.meta.id) return; // Ignore obsolete packets after cancellation/reconnect.
      const offset = new DataView(data).getFloat64(16), bytes = data.slice(HEADER);
      if (offset !== r.bytes || offset + bytes.byteLength > r.meta.size) throw new Error('Unexpected chunk offset or length.');
      await r.sink.write(bytes, offset);
      if (this.rx !== r) return;
      r.hash.update(new Uint8Array(bytes)); r.bytes += bytes.byteLength;
      this.control('ack', { id, offset: r.bytes });
      if (!r.lastUpdate || performance.now() - r.lastUpdate > 100 || r.bytes === r.meta.size) {
        this.progress(r, 'Receiving'); r.lastUpdate = performance.now();
      }
      return;
    }
    if (data.length > 8192) throw new Error('Invalid transfer message.');
    const msg = JSON.parse(data);
    if (msg.type === 'hello') {
      if (msg.version !== 2 || !Number.isSafeInteger(msg.maxSize) || msg.maxSize < 0 || msg.maxSize > DISK_LIMIT) throw new Error('Incompatible Dropno version. Refresh both browsers.');
      this.peerReady = true; this.peerLimit = msg.maxSize; this.offer(); void this.next(); return;
    }
    if (msg.type === 'offer') {
      const m = msg.meta;
      if (!m || !validId(m.id) || typeof m.name !== 'string' || m.name.length > 1024 || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > DISK_LIMIT || !/^[a-f0-9]{64}$/.test(m.sha)) throw new Error('Invalid file metadata.');
      if (this.cancelled.has(m.id)) { this.control('cancel', { id: m.id }); return; }
      if (this.completed.has(m.id)) {
        if (this.completed.get(m.id) !== m.sha) throw new Error('Transfer identity changed.');
        this.control('complete', { id: m.id, sha: m.sha }); return;
      }
      if (this.rx && this.rx.meta.id !== m.id) { this.control('busy', { id: m.id }); return; }
      if (this.rx) {
        if (this.rx.meta.sha !== m.sha || this.rx.meta.size !== m.size || this.rx.meta.name !== m.name) throw new Error('Transfer metadata changed during resume.');
      } else {
        try {
          const generation = this.generation;
          const sink = await this.storage.open(m);
          if (generation !== this.generation) { await sink.remove(); return; }
          this.rx = { meta: m, sink, hash: sha256.create(), bytes: 0, direction: 'receive' };
        } catch (error) { this.control('failed', { id: m.id, message: error.message }); this.emit('error', error.message); return; }
      }
      this.rx.started = performance.now(); this.rx.base = this.rx.bytes;
      this.progress(this.rx, this.rx.bytes ? 'Resuming receive' : 'Receiving automatically');
      this.control('ready', { id: m.id, offset: this.rx.bytes }); return;
    }
    const t = this.tx;
    if (msg.type === 'ready' && t?.meta.id === msg.id) {
      if (!Number.isSafeInteger(msg.offset) || msg.offset < 0 || msg.offset > t.meta.size) throw new Error('Invalid resume offset.');
      if (t.pumpGeneration === this.generation) return;
      t.acked = t.sent = msg.offset; t.activity = Date.now(); t.pumpGeneration = this.generation;
      void this.pump(t, this.generation).catch(error => { if (this.tx === t) { this.pause(); this.emit('error', error.message); this.emit('stalled'); } });
    } else if (msg.type === 'ack' && t?.meta.id === msg.id) {
      if (!Number.isSafeInteger(msg.offset) || msg.offset < t.acked || msg.offset > t.sent) throw new Error('Invalid acknowledgement.');
      t.acked = msg.offset; t.activity = Date.now();
      if (!t.lastUpdate || performance.now() - t.lastUpdate > 100 || t.acked === t.meta.size) { this.progress(t, 'Sending'); t.lastUpdate = performance.now(); }
    } else if (msg.type === 'end' && this.rx?.meta.id === msg.id) {
      const r = this.rx;
      if (r.bytes !== r.meta.size) throw new Error('Incomplete file.');
      this.progress(r, 'Verifying file');
      const actual = hex(r.hash.digest());
      if (actual !== r.meta.sha) throw new Error('Checksum mismatch. The damaged file was discarded.');
      const blob = await r.sink.finish();
      if (this.rx !== r) { await r.sink.remove().catch(() => {}); return; }
      this.completed.set(r.meta.id, actual);
      if (this.completed.size > 200) this.completed.delete(this.completed.keys().next().value);
      this.progress(r, 'Verified · Ready to save');
      this.emit('received', { meta: r.meta, blob, kind: r.sink.kind, remove: r.sink.remove });
      this.rx = null; this.control('complete', { id: msg.id, sha: actual }); this.state();
    } else if (msg.type === 'complete' && t?.meta.id === msg.id) {
      if (msg.sha !== t.sha) throw new Error('Receiver checksum does not match.');
      t.acked = t.meta.size; this.progress(t, 'Delivered · Verified'); this.emit('sent', t.meta);
      this.tx = null; this.state(); void this.next();
    } else if (msg.type === 'busy' && t?.meta.id === msg.id) {
      clearTimeout(this.busyTimer); this.busyTimer = setTimeout(() => this.offer(), 1000);
    } else if (msg.type === 'cancel' || msg.type === 'failed') {
      if (t?.meta.id === msg.id) await this.cancelSend(msg.type === 'failed' ? String(msg.message).slice(0, 200) : 'The other browser cancelled this file.', false);
      if (this.rx?.meta.id === msg.id) await this.cancelReceive('The other browser cancelled this file.', false);
    }
  }
  rememberCancel(id) { this.cancelled.add(id); if (this.cancelled.size > 200) this.cancelled.delete(this.cancelled.values().next().value); }
  async cancelSend(message = 'Sending cancelled.', notify = true) {
    const t = this.tx; if (!t) return;
    this.progress(t, notify ? 'Cancelled' : 'Stopped');
    this.rememberCancel(t.meta.id); if (notify) this.control('cancel', { id: t.meta.id });
    this.tx = null; this.emit('error', message); this.state(); void this.next();
  }
  async cancelReceive(message = 'Receiving cancelled.', notify = true) {
    const r = this.rx; if (!r) return;
    this.progress(r, notify ? 'Cancelled' : 'Stopped');
    this.rx = null; this.rememberCancel(r.meta.id);
    if (notify) this.control('cancel', { id: r.meta.id });
    await r.sink.remove().catch(() => {}); this.emit('error', message); this.state();
  }
  async receiveError(message) {
    if (this.rx) { this.control('failed', { id: this.rx.meta.id, message }); await this.cancelReceive(message, false); }
    else this.emit('error', message);
  }
  async cancelAll() { this.queue = []; await this.cancelSend(); await this.cancelReceive(); this.state(); }
  dispose() { this.disposed = true; clearInterval(this.monitor); clearTimeout(this.busyTimer); void this.cancelAll(); this.pause(); }
}
