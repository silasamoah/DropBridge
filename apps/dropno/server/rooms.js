import { randomBytes, randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
const GRACE = 10 * 60000, WAITING_TTL = 15 * 60000;
const secret = () => randomBytes(32).toString('hex');
const nameOf = value => typeof value === 'string' ? value.trim().slice(0, 40) || 'Browser' : 'Browser';

export function attachSignalling(server) {
  const rooms = new Map(), tokens = new Map();
  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024 });
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const online = slot => slot?.ws?.readyState === WebSocket.OPEN;
  function destroy(room, reason = 'left', exclude) {
    rooms.delete(room.code);
    for (const slot of room.slots) {
      tokens.delete(slot.token);
      if (slot.ws) { slot.ws.room = null; slot.ws.slot = null; if (slot.ws !== exclude) send(slot.ws, { type: 'peer-left', reason }); }
    }
  }
  function leave(ws) { const room = rooms.get(ws.room); if (room) destroy(room, 'left', ws); }
  function session(ws, room, slot, type) {
    send(ws, { type, code: room.code, token: slot.token, epoch: room.epoch, name: slot.name,
      peerName: room.slots.find(s => s !== slot)?.name, peerOnline: room.slots.some(s => s !== slot && online(s)) });
  }
  function pair(room) {
    room.epoch++;
    room.slots.forEach((slot, i) => send(slot.ws, { type: 'paired', initiator: i === 0, epoch: room.epoch, peerName: room.slots[1 - i].name }));
  }
  function add(room, ws, name) {
    const slot = { token: secret(), ws, name: nameOf(name), offlineAt: null };
    room.slots.push(slot); tokens.set(slot.token, { room, slot }); ws.room = room.code; ws.slot = slot;
    return slot;
  }
  function offline(ws) {
    const room = rooms.get(ws.room), slot = ws.slot;
    if (!room || !slot || slot.ws !== ws) return;
    slot.ws = null; slot.offlineAt = Date.now();
    for (const other of room.slots) if (other !== slot) send(other.ws, { type: 'peer-offline', graceSeconds: GRACE / 1000 });
  }
  wss.on('connection', (ws, req) => {
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return ws.close(1008, 'Origin rejected');
    } catch { return ws.close(1008, 'Invalid origin'); }
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    let windowStart = Date.now(), count = 0;
    ws.on('message', (raw, binary) => {
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); count = 0; }
      if (++count > 200) return ws.close(1008, 'Too many requests');
      try {
        if (binary) throw new Error('Signalling accepts JSON only');
        const msg = JSON.parse(raw);
        if (msg.type === 'create') {
          leave(ws); if (rooms.size >= 1000) throw new Error('Too many rooms. Try again later.');
          let code; do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
          const room = { code, slots: [], epoch: 0, created: Date.now() };
          rooms.set(code, room); session(ws, room, add(room, ws, msg.name), 'created');
        } else if (msg.type === 'join') {
          const room = rooms.get(msg.code);
          if (!room || Date.now() - room.created > WAITING_TTL) throw new Error('Room not found or expired. Create a new room.');
          if (room.slots.length !== 1 || room.slots[0].ws === ws) throw new Error('Room is already full.');
          if (!online(room.slots[0])) throw new Error('Room owner is reconnecting. Try again shortly.');
          leave(ws); session(ws, room, add(room, ws, msg.name), 'joined'); pair(room);
        } else if (msg.type === 'resume') {
          const found = typeof msg.token === 'string' && tokens.get(msg.token);
          if (!found || (found.slot.offlineAt && Date.now() - found.slot.offlineAt > GRACE)) {
            send(ws, { type: 'resume-expired', message: 'Pairing expired. Create or join a new room.' }); return;
          }
          const { room, slot } = found;
          if (ws.room && ws.room !== room.code) leave(ws);
          const old = slot.ws; slot.ws = ws; slot.offlineAt = null; slot.name = nameOf(msg.name || slot.name);
          ws.room = room.code; ws.slot = slot;
          if (old && old !== ws) old.close(4001, 'Session reconnected');
          session(ws, room, slot, 'resumed');
          for (const other of room.slots) if (other !== slot) send(other.ws, { type: 'peer-online', peerName: slot.name, epoch: room.epoch });
        } else if (msg.type === 'restart') {
          const room = rooms.get(ws.room); if (!room || room.slots.length !== 2) return;
          if (!room.slots.every(online)) { send(ws, { type: 'peer-offline', graceSeconds: GRACE / 1000 }); return; }
          if (msg.epoch === room.epoch) pair(room);
        } else if (msg.type === 'signal') {
          const room = rooms.get(ws.room);
          if (!room || room.slots.length !== 2) throw new Error('Pair with another browser first.');
          if (msg.epoch !== room.epoch) return;
          const data = msg.data;
          if (!data || !['description', 'candidate'].some(key => key in data)) throw new Error('Invalid signal');
          for (const slot of room.slots) if (slot.ws !== ws) send(slot.ws, { type: 'signal', epoch: room.epoch, data });
        } else if (msg.type === 'name') {
          const room = rooms.get(ws.room);
          if (room && ws.slot) {
            ws.slot.name = nameOf(msg.name);
            for (const slot of room.slots) if (slot !== ws.slot) send(slot.ws, { type: 'device-name', peerName: ws.slot.name });
          }
        } else if (msg.type === 'leave') leave(ws);
        else if (msg.type === 'ping') send(ws, { type: 'pong' });
        else throw new Error('Unknown request');
      } catch (err) { send(ws, { type: 'error', message: err.message }); }
    });
    ws.on('close', () => offline(ws)); ws.on('error', () => offline(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); }
    }
    for (const room of rooms.values()) {
      if (room.slots.some(slot => slot.offlineAt && Date.now() - slot.offlineAt > GRACE) ||
          (room.slots.length === 1 && Date.now() - room.created > WAITING_TTL)) destroy(room, 'expired');
    }
  }, 30000);
  timer.unref(); server.on('close', () => clearInterval(timer));
  return { wss, rooms };
}
