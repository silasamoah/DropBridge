import { encodeText, decodeMessage, encodeAck } from './protocol.js';

export class ClipboardPeer extends EventTarget {
  constructor(signal) { super(); this.signal = signal; this.pending = []; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async start(initiator) {
    this.close();
    if (!globalThis.RTCPeerConnection) throw new Error('This browser does not support WebRTC.');
    const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
    this.timer = setTimeout(() => { if (this.pc === pc && this.channel?.readyState !== 'open') { this.close(); this.emit('problem', 'Connection timed out. Check your network and use Retry connection.'); } }, 20000);
    pc.onicecandidate = event => { if (event.candidate && this.pc === pc) { try { this.signal({ type: 'candidate', candidate: event.candidate.toJSON() }); } catch (error) { this.emit('problem', error.message); } } };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed') { this.close(); this.emit('problem', 'Peer connection failed. Use Retry connection.'); }
      else if (pc.connectionState === 'disconnected') this.emit('status', 'Connection interrupted');
      else if (pc.connectionState === 'connected' && this.channel?.readyState === 'open') this.emit('status', 'Connected');
    };
    pc.ondatachannel = event => this.attach(event.channel);
    if (initiator) {
      this.attach(pc.createDataChannel('clipboard'));
      await pc.setLocalDescription(await pc.createOffer());
      if (this.pc === pc) this.signal({ type: 'offer', sdp: pc.localDescription.sdp });
    }
  }
  attach(channel) {
    this.channel = channel;
    channel.onopen = () => { clearTimeout(this.timer); this.emit('status', 'Connected'); };
    channel.onclose = () => this.emit('status', 'Disconnected');
    channel.onerror = () => this.emit('problem', 'Text channel failed. Use Retry connection.');
    channel.onmessage = event => { try { this.emit('payload', decodeMessage(event.data)); } catch (error) { this.emit('problem', error.message); } };
  }
  async receive(data) {
    const pc = this.pc;
    if (!pc) throw new Error('Peer is not ready. Pair again.');
    if (data.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else this.pending.push(data.candidate);
      return;
    }
    await pc.setRemoteDescription({ type: data.type, sdp: data.sdp });
    for (const candidate of this.pending.splice(0)) await pc.addIceCandidate(candidate);
    if (data.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.pc === pc) this.signal({ type: 'answer', sdp: pc.localDescription.sdp });
    }
  }
  sendPacket(packet) {
    if (this.channel?.readyState !== 'open') throw new Error('Connect to another device first.');
    if (this.channel.bufferedAmount > 65536) throw new Error('Channel is busy. Try again shortly.');
    const limit = this.pc?.sctp?.maxMessageSize;
    if (limit && new TextEncoder().encode(packet).length > limit) throw new Error('Encoded text exceeds this browser’s message limit. Shorten the text.');
    this.channel.send(packet);
  }
  send(text, id) { this.sendPacket(encodeText(text, id)); }
  acknowledge(id) { this.sendPacket(encodeAck(id)); }
  get connected() { return this.channel?.readyState === 'open'; }
  close() {
    clearTimeout(this.timer);
    if (this.channel) { this.channel.onclose = null; this.channel.onmessage = null; this.channel.onopen = null; this.channel.onerror = null; this.channel.close(); }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.ondatachannel = null; this.pc.close(); }
    this.channel = null; this.pc = null; this.pending = [];
  }
}
