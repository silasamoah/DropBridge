export class Signalling extends EventTarget {
  connect() {
    const previous = this.socket;
    if (previous) { previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null; previous.close(); }
    const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/clipboard/signal`);
    socket.onopen = () => this.dispatchEvent(new Event('open'));
    socket.onclose = () => this.dispatchEvent(new Event('close'));
    socket.onerror = () => this.dispatchEvent(new CustomEvent('problem', { detail: 'Cannot reach the signalling server.' }));
    socket.onmessage = event => {
      try { this.dispatchEvent(new CustomEvent('message', { detail: JSON.parse(event.data) })); }
      catch { this.dispatchEvent(new CustomEvent('problem', { detail: 'Invalid server response.' })); }
    };
  }
  disconnect() {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    socket.close(); this.socket = null;
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Signalling is offline. Reconnect first.');
    this.socket.send(JSON.stringify(message));
  }
}
