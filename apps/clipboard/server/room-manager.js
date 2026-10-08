import { randomInt, randomUUID } from 'node:crypto';

// Transport-independent pairing state. No clipboard content belongs in this layer.
export class RoomManager {
  constructor({ send, close = client => client.close(), now = Date.now, reconnectGraceMs = 120000, pairingLifetimeMs = 86400000, waitingRoomMs = 600000, maxRooms = 1000 }) {
    Object.assign(this, { send, close, now, reconnectGraceMs, pairingLifetimeMs, waitingRoomMs, maxRooms });
    this.rooms = new Map();
  }
  ticket(type, code, room, seat) { return { type, code, token: seat.token, remember: seat.remember, expiresAt: room.expiresAt }; }
  resumeUntil(room, seat) { return seat.remember ? room.expiresAt : Math.min(room.expiresAt, seat.awayAt + this.reconnectGraceMs); }
  expired(room) {
    const now = this.now();
    return now >= room.expiresAt || room.clients.some(seat => seat.awayAt !== null && now >= this.resumeUntil(room, seat))
      || (room.clients.length === 1 && now - room.created >= this.waitingRoomMs);
  }
  end(code, room, type, except) {
    this.rooms.delete(code);
    for (const seat of room.clients) if (seat.client) { seat.client.room = null; if (seat.client !== except) this.send(seat.client, { type }); }
  }
  ready(room) {
    if (room.clients.length !== 2 || room.clients.some(seat => !seat.client || seat.awayAt !== null)) return;
    room.session = randomUUID();
    room.clients.forEach((seat, index) => this.send(seat.client, { type: 'peer-ready', initiator: index === 0, session: room.session }));
  }
  pause(client, disconnected = false) {
    const room = this.rooms.get(client.room), seat = room?.clients.find(item => item.client === client);
    if (!seat) return;
    seat.awayAt ??= this.now(); room.session = null;
    if (disconnected) { seat.client = null; client.room = null; }
    for (const other of room.clients) if (other !== seat && other.client) this.send(other.client, { type: 'peer-paused', resumeUntil: this.resumeUntil(room, seat) });
  }
  sweep() { for (const [code, room] of this.rooms) if (this.expired(room)) this.end(code, room, 'expired'); }
  handle(client, msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid message');
    if (msg.type === 'forget') {
      const room = this.rooms.get(msg.code);
      if (room && typeof msg.token === 'string' && room.clients.some(seat => seat.token === msg.token)) this.end(msg.code, room, 'peer-left');
      this.send(client, { type: 'forgotten', code: msg.code }); return;
    }
    if (msg.type === 'leave') {
      const room = this.rooms.get(client.room);
      if (room) this.end(client.room, room, 'peer-left', client);
      this.send(client, { type: 'left' }); return;
    }
    if (msg.type === 'suspend') { this.pause(client); return; }
    if (msg.type === 'resume') {
      if (client.room) throw new Error('Leave the current room first');
      const room = this.rooms.get(msg.code);
      if (room && this.expired(room)) this.end(msg.code, room, 'expired');
      const seat = room && this.rooms.has(msg.code) && typeof msg.token === 'string' && room.clients.find(item => item.token === msg.token);
      if (!seat) { this.send(client, { type: 'resume-rejected' }); return; }
      const previous = seat.client;
      if (previous) { previous.room = null; this.close(previous); }
      seat.client = client; seat.awayAt = null; client.room = msg.code;
      this.send(client, this.ticket('resumed', msg.code, room, seat));
      const other = room.clients.find(item => item !== seat);
      if (other && other.awayAt !== null) this.send(client, { type: 'peer-paused', resumeUntil: this.resumeUntil(room, other) });
      this.ready(room); return;
    }
    if (msg.type === 'create') {
      if (client.room) throw new Error('Leave the current room first');
      this.sweep(); if (this.rooms.size >= this.maxRooms) throw new Error('Server is busy');
      let code; do { code = String(randomInt(100000, 1000000)); } while (this.rooms.has(code));
      const seat = { client, token: randomUUID(), remember: msg.remember === true, awayAt: null };
      const room = { clients: [seat], created: this.now(), expiresAt: this.now() + this.pairingLifetimeMs, session: null };
      this.rooms.set(code, room); client.room = code;
      this.send(client, this.ticket('created', code, room, seat)); return;
    }
    if (msg.type === 'join') {
      if (client.room) throw new Error('Leave the current room first');
      if (typeof msg.code !== 'string' || !/^\d{6}$/.test(msg.code)) throw new Error('Enter a six-digit room code');
      this.sweep(); const room = this.rooms.get(msg.code);
      if (!room) throw new Error('Room not found or expired');
      if (room.clients.length >= 2) throw new Error('Room already has two devices');
      const seat = { client, token: randomUUID(), remember: msg.remember === true, awayAt: null };
      room.clients.push(seat); client.room = msg.code;
      this.send(client, this.ticket('joined', msg.code, room, seat)); this.ready(room); return;
    }
    if (msg.type === 'signal') {
      const room = this.rooms.get(client.room);
      if (!room || room.clients.length !== 2) throw new Error('Pair two devices first');
      if (!room.session || msg.session !== room.session) return;
      const data = msg.data;
      if (!data || !['offer', 'answer', 'candidate'].includes(data.type)) throw new Error('Invalid signal');
      if (data.type !== 'candidate' && typeof data.sdp !== 'string') throw new Error('Invalid session description');
      if (data.type === 'candidate' && (!data.candidate || typeof data.candidate !== 'object')) throw new Error('Invalid ICE candidate');
      const other = room.clients.find(seat => seat.client !== client);
      if (other?.client) this.send(other.client, { type: 'signal', data, session: room.session }); return;
    }
    throw new Error('Unknown message type');
  }
}
