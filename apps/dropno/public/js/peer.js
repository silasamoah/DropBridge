export class Peer extends EventTarget {
  constructor(signal, iceServers, iceTransportPolicy = 'all') {
    super();
    this.signal = signal;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    this.candidates = [];
    this.pc.onicecandidate = event => {
      if (event.candidate) {
        try { this.signal({ candidate: event.candidate.toJSON() }); }
        catch (error) { this.emit('error', error.message); }
      }
    };
    this.pc.ondatachannel = event => this.attach(event.channel);
    this.pc.onconnectionstatechange = () => {
      this.emit('state', this.pc.connectionState);
      if (this.pc.connectionState === 'failed') this.emit('error', 'Direct connection failed. Try the same Wi-Fi network and create a new room.');
    };
    this.timeout = setTimeout(() => {
      if (this.channel?.readyState !== 'open') this.emit('error', 'Connection timed out. Try the same Wi-Fi network and create a new room.');
    }, 30000);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  attach(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => { clearTimeout(this.timeout); this.emit('open', channel); };
    channel.onclose = () => this.emit('closed');
    channel.onerror = () => this.emit('error', 'The transfer channel encountered an error.');
  }
  async start(initiator) {
    if (!initiator) return;
    this.attach(this.pc.createDataChannel('dropno-v2', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ description: this.pc.localDescription.toJSON() });
  }
  async receive(data) {
    if (data.description) {
      await this.pc.setRemoteDescription(data.description);
      for (const candidate of this.candidates) await this.pc.addIceCandidate(candidate);
      this.candidates = [];
      if (data.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal({ description: this.pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate);
      else this.candidates.push(data.candidate);
    }
  }
  close() {
    clearTimeout(this.timeout);
    this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.ondatachannel = null;
    if (this.channel) { this.channel.onopen = null; this.channel.onclose = null; this.channel.onerror = null; this.channel.close(); }
    this.pc.close();
  }
}
