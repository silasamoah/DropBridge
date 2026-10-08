import { Signalling } from './signalling.js';
import { ClipboardPeer } from './peer.js';
import { copyText } from './clipboard.js';
import { DeliveryTracker } from './delivery.js';
import { browserPairingStore } from './pairing.js';
import { PairingSetup } from './setup.js';

const ids = ['status', 'create', 'join', 'join-form', 'code', 'room-panel', 'room-code', 'leave', 'reconnect', 'outgoing', 'incoming', 'send', 'copy', 'notice', 'received-time', 'remember', 'saved-pairings', 'qr-panel', 'qr-image', 'share-address', 'share-link', 'qr-hint', 'setup-help', 'recovery-detail', 'delivery-status', 'retry-send'];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const signalling = new Signalling(), store = browserPairingStore();
const setup = new PairingSetup({ select: el['share-address'], image: el['qr-image'], link: el['share-link'], hint: el['qr-hint'], help: el['setup-help'] });
const peer = new ClipboardPeer(data => signalling.send({ type: 'signal', data, session }));
const delivery = new DeliveryTracker({ sendText: (text, id) => peer.send(text, id), acknowledge: id => peer.acknowledge(id) });
let online = false, room = null, token = null, expiresAt = null, session = null, busy = false;
let queue = Promise.resolve(), generation = 0, retryTimer, retryDelay = 1000, retryAt = null, pausedUntil = null;
const linkedCode = new URLSearchParams(location.hash.slice(1)).get('room');
if (/^\d{6}$/.test(linkedCode || '')) {
  store.clearActive();
  el.code.value = linkedCode; history.replaceState(null, '', location.pathname + location.search);
} else {
  const ticket = store.active();
  if (ticket) ({ code: room, token, expiresAt } = ticket);
}

function notice(message, error = false) { el.notice.textContent = message; el.notice.classList.toggle('error', error); }
function status(message) { el.status.textContent = message; el.status.classList.toggle('connected', peer.connected); render(); }
function duration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return seconds >= 3600 ? `${Math.ceil(seconds / 3600)}h` : seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
}
function recoveryDetail() {
  if (retryAt) el['recovery-detail'].textContent = `Retrying in ${duration(retryAt - Date.now())} · unsent text stays ready`;
  else if (pausedUntil) el['recovery-detail'].textContent = `Other device paused · pairing reserved for ${duration(pausedUntil - Date.now())}`;
  else if (room && expiresAt) el['recovery-detail'].textContent = `Pairing expires ${new Date(expiresAt).toLocaleString()}`;
  else el['recovery-detail'].textContent = '';
}
function savedPairings() {
  el['saved-pairings'].replaceChildren();
  for (const ticket of store.list()) {
    const row = document.createElement('div'); row.className = 'saved-pair';
    const label = document.createElement('span'); label.textContent = `Saved room ${ticket.code}${ticket.token === token ? ' · this tab' : ''}`;
    const resume = document.createElement('button'); resume.className = 'secondary'; resume.textContent = `Resume ${ticket.code}`;
    resume.hidden = ticket.token === token;
    resume.disabled = !online || !!room || busy;
    resume.onclick = () => { room = ticket.code; token = ticket.token; expiresAt = ticket.expiresAt; store.save(ticket); reconnect(); };
    const forget = document.createElement('button'); forget.className = 'secondary'; forget.textContent = 'Forget pairing';
    forget.onclick = () => {
      if (ticket.token === token) leaveRoom();
      else {
        if (online) run(() => signalling.send({ type: 'forget', code: ticket.code, token: ticket.token }));
        store.forget(ticket.token); render();
        notice(online ? 'Saved pairing forgotten.' : 'Pairing removed from this browser. The offline server reservation will expire.');
      }
    };
    row.append(label, resume, forget); el['saved-pairings'].append(row);
  }
}
function render() {
  el.create.disabled = el.join.disabled = !online || !!room || busy;
  el.code.disabled = el.remember.disabled = !!room || busy;
  document.querySelector('.pair-controls').hidden = !!room;
  el.remember.closest('label').hidden = !!room;
  el['room-panel'].hidden = !room; el['room-code'].textContent = room || '';
  el['qr-panel'].hidden = !room || peer.connected || !!pausedUntil;
  el.send.disabled = !online || !peer.connected || delivery.latest?.state === 'sending';
  el.copy.disabled = !el.incoming.value;
  el.reconnect.hidden = online && (!room || peer.connected);
  el['retry-send'].hidden = delivery.latest?.state !== 'failed';
  el['retry-send'].disabled = !online || !peer.connected;
  savedPairings(); recoveryDetail();
}
function stopPeer() { generation++; session = null; peer.close(); delivery.fail('Connection interrupted. Reconnect, then retry this text.'); }
function reset(message) {
  stopPeer(); if (token) store.forget(token);
  room = token = expiresAt = pausedUntil = null; busy = false; setup.room(null); status(message);
}
function reconnect() {
  clearTimeout(retryTimer); retryAt = null; online = false; busy = false; stopPeer();
  status(room ? 'Resuming connection…' : 'Connecting to server…'); signalling.connect();
}
function scheduleRetry() {
  clearTimeout(retryTimer); retryAt = null;
  if (document.hidden || navigator.onLine === false) { recoveryDetail(); return; }
  retryAt = Date.now() + retryDelay; retryTimer = setTimeout(reconnect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10000); recoveryDetail();
}
function suspend() {
  clearTimeout(retryTimer); retryAt = null;
  if (room && online) { try { signalling.send({ type: 'suspend' }); } catch {} }
  stopPeer(); if (room) status('Paused while in background');
}
function run(action) { try { Promise.resolve(action()).catch(error => notice(error.message, true)); } catch (error) { notice(error.message, true); } }
function leaveRoom() {
  run(() => { if (online) signalling.send({ type: 'leave' }); reset('Ready to pair'); notice('Room ended and this pairing forgotten.'); });
}
signalling.addEventListener('open', () => {
  clearTimeout(retryTimer); retryAt = null; online = true;
  if (room && token) { status('Resuming connection…'); signalling.send({ type: 'resume', code: room, token }); }
  else { retryDelay = 1000; status('Ready to pair'); notice(linkedCode ? 'Room code filled from the QR link. Tap Join room.' : 'Create a room or join your other device’s room.'); }
});
signalling.addEventListener('close', () => {
  online = false; busy = false; stopPeer(); status('Server disconnected');
  notice('Connection paused. Your draft stays ready; this tab will retry when visible.', true); scheduleRetry();
});
signalling.addEventListener('problem', event => notice(event.detail, true));
signalling.addEventListener('message', event => {
  const msg = event.detail;
  if (['peer-left', 'left', 'expired', 'resume-rejected'].includes(msg.type)) {
    reset(msg.type === 'expired' ? 'Room expired' : 'Ready to pair');
    notice(msg.type === 'resume-rejected' ? 'Saved pairing is no longer valid. The server may have restarted; pair again.'
      : msg.type === 'peer-left' ? 'Your other device left or forgot the pairing. Pair again.'
      : msg.type === 'expired' ? 'The pairing expired. Create or join a new room.' : 'You left the room.'); return;
  }
  if (msg.type === 'peer-paused') {
    clearTimeout(retryTimer); retryAt = null;
    stopPeer(); pausedUntil = msg.resumeUntil; status('Other device paused');
    notice('Your other device is away. Return to its ClipboardBridge tab to resume. Your draft stays ready.'); return;
  }
  if (msg.type === 'error') { busy = false; render(); notice(msg.message, true); return; }
  if (['created', 'joined', 'resumed'].includes(msg.type)) {
    room = msg.code; token = msg.token; expiresAt = msg.expiresAt; pausedUntil = null; busy = false;
    el.remember.checked = msg.remember;
    if (!msg.remember) store.clearActive();
    if (msg.remember && !store.save({ code: room, token, expiresAt, remember: true })) notice('Pairing works, but browser storage is unavailable. Reloading may require a new room.', true);
    setup.room(room); status('Waiting for other device'); return;
  }
  if (msg.type === 'peer-ready') { stopPeer(); session = msg.session; pausedUntil = null; status('Connecting to peer…'); }
  if (msg.type === 'signal' && msg.session !== session) return;
  const current = generation;
  queue = queue.then(async () => {
    if (current !== generation) return;
    if (msg.type === 'peer-ready') await peer.start(msg.initiator);
    if (msg.type === 'signal') await peer.receive(msg.data);
  }).catch(error => {
    if (current === generation) { stopPeer(); status('Connection failed'); notice(error.message, true); scheduleRetry(); }
  });
});
peer.addEventListener('status', event => {
  status(event.detail);
  if (event.detail === 'Connected') {
    clearTimeout(retryTimer); retryAt = null; retryDelay = 1000; pausedUntil = null;
    notice('Connected. Sending confirms delivery to the other page; copying stays manual.'); recoveryDetail();
  } else if (['Disconnected', 'Connection interrupted'].includes(event.detail)) {
    delivery.fail('Connection interrupted. Reconnect, then retry this text.'); scheduleRetry();
  }
});
peer.addEventListener('problem', event => { delivery.fail(event.detail); status('Connection problem'); notice(event.detail, true); scheduleRetry(); });
peer.addEventListener('payload', event => delivery.receive(event.detail));
delivery.addEventListener('text', event => {
  el.incoming.value = event.detail; el['received-time'].textContent = `Received at ${new Date().toLocaleTimeString()}`;
  notice('Text received. Use Copy text when you’re ready.'); render();
});
delivery.addEventListener('problem', event => notice(event.detail, true));
delivery.addEventListener('change', event => {
  const transfer = event.detail;
  el['delivery-status'].dataset.state = transfer?.state || '';
  el['delivery-status'].textContent = !transfer ? 'No text sent yet' : transfer.state === 'sending' ? 'Sending · waiting for confirmation…'
    : transfer.state === 'delivered' ? 'Delivered to the other page' : `Unconfirmed · ${transfer.reason}`;
  render();
});
el.create.onclick = () => run(() => { signalling.send({ type: 'create', remember: el.remember.checked }); busy = true; render(); });
el['join-form'].onsubmit = event => { event.preventDefault(); run(() => { signalling.send({ type: 'join', code: el.code.value.trim(), remember: el.remember.checked }); busy = true; render(); }); };
el.leave.onclick = leaveRoom; el.reconnect.onclick = reconnect;
el.send.onclick = () => run(() => delivery.send(el.outgoing.value));
el['retry-send'].onclick = () => run(() => {
  if (el.outgoing.value !== delivery.latest?.text) notice('Retrying your previous message. Your current draft stays unchanged.');
  delivery.retry();
});
el.copy.onclick = () => run(async () => {
  try { await copyText(el.incoming.value); notice('Copied to this device’s clipboard.'); }
  catch (error) { el.incoming.focus(); el.incoming.select(); throw error; }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(retryTimer); retryAt = null; }
  else reconnect();
});
window.addEventListener('pagehide', () => { suspend(); signalling.disconnect(); online = false; });
window.addEventListener('pageshow', event => { if (event.persisted) reconnect(); });
window.addEventListener('online', () => { if (!document.hidden) reconnect(); });
window.addEventListener('offline', () => {
  clearTimeout(retryTimer); retryAt = null; stopPeer(); signalling.disconnect(); online = false;
  status('Network offline'); notice('Waiting for network access. Your draft stays ready.', true);
});
window.addEventListener('storage', () => {
  if (token && el.remember.checked && !store.list().some(ticket => ticket.token === token)) leaveRoom();
  else savedPairings();
});
setInterval(recoveryDetail, 1000);
setup.load(); render(); signalling.connect();
