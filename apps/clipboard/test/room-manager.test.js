import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/room-manager.js';

test('remembered pairing survives long suspension, replaces stale socket, and expires absolutely', () => {
  let now = 1000;
  const manager = new RoomManager({ now: () => now, send: (client, msg) => client.messages.push(msg), close: client => manager.pause(client, true), reconnectGraceMs: 20, pairingLifetimeMs: 1000 });
  const client = () => ({ messages: [] });
  const a = client(), b = client();
  manager.handle(a, { type: 'create', remember: true }); const ticketA = a.messages[0];
  manager.handle(b, { type: 'join', code: ticketA.code, remember: true }); const ticketB = b.messages[0];
  assert.notEqual(ticketA.token, ticketB.token);
  manager.pause(b, true); now += 100; manager.sweep(); assert.equal(manager.rooms.size, 1);
  const unknown = client(); manager.handle(unknown, { type: 'resume', code: ticketA.code, token: 'unknown' });
  assert.equal(unknown.messages[0].type, 'resume-rejected');
  const resumed = client(); manager.handle(resumed, { type: 'resume', code: ticketA.code, token: ticketB.token });
  assert.equal(resumed.messages[0].type, 'resumed');
  const replacement = client(); manager.handle(replacement, { type: 'resume', code: ticketA.code, token: ticketB.token });
  assert.equal(replacement.messages[0].type, 'resumed');
  assert.equal(manager.rooms.get(ticketA.code).clients[1].client, replacement);
  now = ticketA.expiresAt; manager.sweep(); assert.equal(manager.rooms.size, 0);
  assert.equal(a.messages.at(-1).type, 'expired'); assert.equal(replacement.messages.at(-1).type, 'expired');
});

test('forget requires a valid private token and revokes the entire pairing', () => {
  const manager = new RoomManager({ send: (client, msg) => client.messages.push(msg) });
  const a = { messages: [] }, b = { messages: [] };
  manager.handle(a, { type: 'create', remember: true }); const ticket = a.messages[0];
  manager.handle(b, { type: 'forget', code: ticket.code, token: 'wrong' }); assert.equal(manager.rooms.size, 1);
  manager.handle(b, { type: 'forget', code: ticket.code, token: ticket.token }); assert.equal(manager.rooms.size, 0);
  assert.equal(a.room, null); assert.equal(a.messages.at(-1).type, 'peer-left');
  manager.handle(b, { type: 'resume', code: ticket.code, token: ticket.token }); assert.equal(b.messages.at(-1).type, 'resume-rejected');
});
