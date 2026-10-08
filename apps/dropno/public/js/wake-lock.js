// A wake lock prevents screen sleep while visible; it cannot keep an iOS
// background tab running. The browser may deny or release it at any time.
export class TransferWakeLock {
  constructor() {
    this.wanted = false;
    this.pending = false;
    document.addEventListener('visibilitychange', () => this.update());
  }
  setActive(active) { this.wanted = Boolean(active); void this.update(); }
  async update() {
    if (!this.wanted || document.visibilityState !== 'visible') {
      const lock = this.lock; this.lock = null;
      if (lock) { try { await lock.release(); } catch {} }
      return;
    }
    if (!navigator.wakeLock || !window.isSecureContext || this.lock || this.pending) return;
    this.pending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this.wanted || document.visibilityState !== 'visible') await lock.release();
      else {
        this.lock = lock;
        lock.addEventListener('release', () => { if (this.lock === lock) this.lock = null; });
      }
    } catch { /* Unsupported or denied: the visible keep-open guidance remains. */ }
    finally { this.pending = false; }
  }
}
