export class Signalling extends EventTarget {
  constructor() {
    super();
    this.retryDelay = 1000;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.check();
    });
    window.addEventListener('online', () => this.check());
  }
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  connect() {
    if (this.stopped || document.visibilityState === 'hidden') return;
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;
    clearTimeout(this.retryTimer);
    const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/files/signal`);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retryDelay = 1000;
      this.dispatchEvent(new Event('open'));
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') { clearTimeout(this.checkTimer); return; }
        this.dispatchEvent(new CustomEvent('message', { detail: data }));
      }
      catch { this.dispatchEvent(new Event('error')); }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      clearTimeout(this.checkTimer);
      if (this.stopped) return;
      if (event.code === 4001) {
        this.stopped = true;
        this.dispatchEvent(new CustomEvent('close', { detail: { code: event.code } }));
        return;
      }
      this.dispatchEvent(new Event('close'));
      this.schedule();
    };
    socket.onerror = () => { if (this.socket === socket) this.dispatchEvent(new Event('error')); };
  }
  schedule() {
    clearTimeout(this.retryTimer);
    if (this.stopped || document.visibilityState === 'hidden') return;
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10000);
  }
  check() {
    if (this.stopped) return;
    if (!this.connected) { this.connect(); return; }
    clearTimeout(this.checkTimer);
    const socket = this.socket;
    this.send('ping');
    // After iOS suspension an apparently open socket may no longer be usable.
    this.checkTimer = setTimeout(() => {
      if (this.socket !== socket || document.visibilityState === 'hidden') return;
      this.socket = null;
      socket.close();
      this.dispatchEvent(new Event('close'));
      this.connect();
    }, 10000);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer); clearTimeout(this.checkTimer);
    this.socket?.close();
  }
  send(type, extra = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Signalling server disconnected. Reload to reconnect.');
    this.socket.send(JSON.stringify({ type, ...extra }));
  }
}
