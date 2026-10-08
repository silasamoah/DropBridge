export const MAX_TEXT_BYTES = 12000;
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export function messageId() { return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export function validateText(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('Enter some text first.');
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new Error('Text must be 12 KB or less.');
}
export function encodeText(text, id = messageId()) {
  validateText(text);
  if (!validId(id)) throw new Error('Invalid message identifier.');
  return JSON.stringify({ version: 2, type: 'clipboard:text', id, text });
}
export function encodeAck(id) {
  if (!validId(id)) throw new Error('Invalid acknowledgement identifier.');
  return JSON.stringify({ version: 2, type: 'clipboard:ack', id });
}
export function decodeMessage(raw) {
  if (typeof raw !== 'string' || raw.length > 80000) throw new Error('Invalid clipboard payload.');
  const msg = JSON.parse(raw);
  if (msg?.version !== 2 || !validId(msg.id)) throw new Error('Unsupported clipboard payload. Refresh both devices.');
  if (msg.type === 'clipboard:text') validateText(msg.text);
  else if (msg.type !== 'clipboard:ack') throw new Error('Unsupported clipboard payload.');
  return msg;
}
export function decodeText(raw) {
  const msg = decodeMessage(raw);
  if (msg.type !== 'clipboard:text') throw new Error('Expected text payload.');
  return msg.text;
}
