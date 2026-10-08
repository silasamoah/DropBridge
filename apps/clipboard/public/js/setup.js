export class PairingSetup {
  constructor({ select, image, link, hint, help }) { Object.assign(this, { select, image, link, hint, help }); this.code = null; }
  async load() {
    try {
      const response = await fetch('/clipboard/api/config');
      if (!response.ok) throw new Error();
      this.config = await response.json();
      // Under HTTPS prefer the visible origin unless PUBLIC_URL is configured.
      if (location.protocol === 'https:') {
        this.config.addresses = this.config.addresses.map(url => url === `http://${location.host}` ? location.origin : url);
        if (this.config.defaultUrl === `http://${location.host}`) this.config.defaultUrl = location.origin;
      }
      for (const url of this.config.addresses) {
        const option = document.createElement('option'); option.value = url; option.textContent = url; this.select.append(option);
      }
      // An HTTPS proxy should set PUBLIC_URL; do not silently generate an HTTP link.
      this.select.value = this.config.addresses.includes(this.config.defaultUrl) ? this.config.defaultUrl : this.config.addresses[0];
      this.select.onchange = () => this.render(); this.render();
    } catch { this.hint.textContent = 'QR setup is unavailable. Enter the room code on your other device instead.'; }
    this.help.textContent = window.isSecureContext
      ? 'Copy is available here. For phones, use the same Wi-Fi and a reachable server address; localhost means the phone itself.'
      : 'Automatic copying needs HTTPS on this device. You can still select and copy received text manually. See HTTPS setup below.';
  }
  room(code) { this.code = code; this.render(); }
  render() {
    if (!this.code || !this.config) return;
    const base = this.select.value;
    this.image.src = `/clipboard/api/qr?code=${this.code}&base=${encodeURIComponent(base)}`;
    this.image.hidden = false;
    this.link.href = `${base}/clipboard/#room=${this.code}`; this.link.textContent = this.link.href;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
    this.hint.textContent = loopback
      ? 'This address only works on this computer. Restart with HOST=0.0.0.0 for a phone-accessible address.'
      : 'Scan with your phone camera, then tap Join room. Both devices must reach this address.';
  }
}

