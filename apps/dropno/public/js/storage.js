import { transferId } from './hash.js';
export const MEMORY_LIMIT = 512 * 1024 * 1024;
export const DISK_LIMIT = 8 * 1024 * 1024 * 1024;
export class ReceiveStorage {
  constructor() {
    let tab; try { tab = sessionStorage.getItem('dropno-tab'); } catch {}
    this.directory = `dropno-${tab || transferId()}`;
    try { sessionStorage.setItem('dropno-tab', this.directory.slice(7)); } catch {}
    this.memoryBytes = 0; this.pending = new Map(); this.sequence = 0;
  }
  async init() {
    if (window.isSecureContext && navigator.storage?.getDirectory && window.Worker) {
      try {
        this.worker = new Worker('/files/js/storage-worker.js', { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const pending = this.pending.get(data.request); if (!pending) return;
          this.pending.delete(data.request); clearTimeout(pending.timer);
          if (data.error) pending.reject(new Error(data.error)); else pending.resolve();
        };
        this.worker.onerror = () => {
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Temporary storage worker failed')); }
          this.pending.clear(); this.disk = false;
        };
        await this.call('probe', transferId()); this.disk = true;
      } catch { this.worker?.terminate(); this.worker = null; }
    }
    return this.disk ? DISK_LIMIT : MEMORY_LIMIT;
  }
  call(type, id, extra = {}) {
    const request = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request); reject(new Error('Temporary storage stalled')); }, 60000);
      this.pending.set(request, { resolve, reject, timer });
      this.worker.postMessage({ request, type, id, directory: this.directory, ...extra });
    });
  }
  async open(meta) {
    if (this.disk) {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota && meta.size > estimate.quota - (estimate.usage || 0)) throw new Error('Not enough browser storage for this file.');
      if (meta.size > DISK_LIMIT) throw new Error('File exceeds the 8 GiB storage limit.');
      await this.call('open', meta.id);
      return { kind: 'disk', write: (bytes, offset) => this.call('write', meta.id, { bytes, offset }),
        finish: async () => { await this.call('finish', meta.id); return this.file(meta.id); }, remove: () => this.call('remove', meta.id) };
    }
    if (this.memoryBytes + meta.size > MEMORY_LIMIT) throw new Error('Memory storage is full. Clear received files or use HTTPS for disk storage.');
    this.memoryBytes += meta.size;
    const chunks = []; let removed = false;
    return { kind: 'memory', write: async bytes => { chunks.push(bytes); }, finish: async () => new Blob(chunks, { type: 'application/octet-stream' }),
      remove: async () => { if (!removed) { removed = true; this.memoryBytes -= meta.size; chunks.length = 0; } } };
  }
  async file(id) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(this.directory);
    return (await dir.getFileHandle(id)).getFile();
  }
  remember(records) {
    try { sessionStorage.setItem('dropno-files', JSON.stringify(records.filter(r => r.kind === 'disk').map(r => ({ meta: r.meta, kind: r.kind })))); } catch {}
  }
  async restore() {
    if (!this.disk) return [];
    let entries; try { entries = JSON.parse(sessionStorage.getItem('dropno-files')); } catch {}
    const restored = [];
    for (const entry of Array.isArray(entries) ? entries.slice(0, 100) : []) {
      if (!/^[a-f0-9]{32}$/.test(entry?.meta?.id)) continue;
      try {
        const blob = await this.file(entry.meta.id); if (blob.size !== entry.meta.size) continue;
        restored.push({ ...entry, blob, remove: () => this.call('remove', entry.meta.id) });
      } catch {}
    }
    const keep = new Set(restored.map(r => r.meta.id));
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(this.directory, { create: true });
    for await (const [name] of dir.entries()) if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
    return restored;
  }
}
