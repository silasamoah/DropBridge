import { Signalling } from './signalling.js';
import { Peer } from './peer.js';
import { Transfer } from './transfer.js';
import { ReceiveStorage } from './storage.js';
import { TransferWakeLock } from './wake-lock.js';
import { DeviceIdentity } from './identity.js';

const $ = id => document.getElementById(id);
const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
const write = (store, key, value) => { try { value === null ? store.removeItem(key) : store.setItem(key, value); } catch {} };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${(bytes / 1073741824).toFixed(1)} GiB`;
const signal = new Signalling(), wakeLock = new TransferWakeLock(), storage = new ReceiveStorage();
const transfer = new Transfer(storage);
const identity = new DeviceIdentity();
let verifiedPeer;
let peer, session = parse(read(sessionStorage, 'dropno-session')), epoch = 0, peerOnline = false, peerDeviceName = 'another browser', recoverTimer, config, incoming = Promise.resolve(), files = [];
let history = parse(read(localStorage, 'dropno-history')) || [];
if (!Array.isArray(history)) history = [];
const defaultName = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'This browser';
$('device-name').value = read(localStorage, 'dropno-name') || defaultName;
const deviceName = () => $('device-name').value.trim().slice(0, 40) || defaultName;
const joinFromLink = new URL(location.href).searchParams.get('room');
function message(text = '') { $('message').textContent = text; $('message').hidden = !text; }
function status(text, connected = false) { $('status').textContent = text; $('status').classList.toggle('connected', connected); }
function rememberSession(value) { session = value; write(sessionStorage, 'dropno-session', value ? JSON.stringify(value) : null); }
function showRoom() {
  $('room').hidden = !session; $('disconnect').hidden = !session;
  if (!session) return;
  $('code').textContent = session.code;
  $('qr').src = `/files/qr?code=${session.code}&origin=${encodeURIComponent(location.origin)}`;
}
function renderState() {
  const paired = Boolean(session);
  $('file').disabled = !paired; $('drop').classList.toggle('disabled', !paired);
  $('drop-hint').textContent = !paired ? 'Pair with another browser to get started' : transfer.connected ? 'Files arrive automatically · Add more to the queue' : 'Queued files will send when the connection returns';
  $('cancel').hidden = !transfer.current && !transfer.queue.length;
  wakeLock.setActive(transfer.current && transfer.connected);
  $('queue').replaceChildren();
  for (const item of transfer.queue) {
    const li = document.createElement('li'), text = document.createElement('span'), button = document.createElement('button');
    text.textContent = `${item.file.name} · ${size(item.file.size)}`; button.textContent = 'Remove'; button.className = 'quiet';
    button.onclick = () => transfer.removeQueued(item.id); li.append(text, button); $('queue').append(li);
  }
}
function renderHistory() {
  $('history').replaceChildren();
  for (const item of history.slice(0, 30)) {
    const li = document.createElement('li'); li.textContent = `${item.direction} ${item.name} · ${size(item.size)} · ${new Date(item.time).toLocaleString()}`; $('history').append(li);
  }
}
function renderTrust() {
  $('identity-status').textContent = !verifiedPeer ? '' : identity.isTrusted(verifiedPeer) ? 'Trusted device · Signature verified' : verifiedPeer.verified ? 'Device key verified · Not yet trusted' : 'Device verification requires HTTPS and supported storage on both browsers';
  $('trust-device').hidden = !verifiedPeer?.verified || identity.isTrusted(verifiedPeer);
  $('trusted-devices').replaceChildren();
  for (const [id, entry] of Object.entries(identity.trusted)) {
    const li = document.createElement('li'), text = document.createElement('span'), button = document.createElement('button');
    text.textContent = entry.name || 'Trusted browser'; button.className = 'quiet'; button.textContent = 'Forget';
    button.onclick = () => { identity.forget(id); renderTrust(); };
    li.append(text, button); $('trusted-devices').append(li);
  }
}
function addHistory(meta, direction) {
  history.unshift({ name: meta.name, size: meta.size, direction, time: Date.now() }); history = history.slice(0, 30);
  write(localStorage, 'dropno-history', JSON.stringify(history)); renderHistory();
}
function renderFiles() {
  $('received').hidden = !files.length; $('received-files').replaceChildren();
  for (const record of files) {
    record.url ||= URL.createObjectURL(record.blob);
    const row = document.createElement('div'), title = document.createElement('p'), link = document.createElement('a'), remove = document.createElement('button');
    row.className = 'received-item'; row.dataset.id = record.meta.id;
    title.textContent = `${record.meta.name} · ${size(record.meta.size)} · SHA-256 verified`;
    link.className = 'button download'; link.textContent = 'Save file ↓'; link.href = record.url;
    link.download = record.meta.name.replace(/[\\/\u0000-\u001f]/g, '_') || 'download';
    remove.className = 'quiet'; remove.textContent = 'Remove'; remove.onclick = async () => {
      try { await record.remove(); URL.revokeObjectURL(record.url); files = files.filter(f => f !== record); storage.remember(files); renderFiles(); }
      catch (error) { message(error.message); }
    };
    row.append(title, link, remove); $('received-files').append(row);
  }
}
function closePeer() { clearTimeout(recoverTimer); transfer.pause(); peer?.close(); peer = null; verifiedPeer = null; renderTrust(); }
function endSession(text = 'Pairing ended. Create or join a room to connect.') {
  closePeer(); void transfer.cancelAll(); rememberSession(null); peerOnline = false; showRoom(); renderState(); status(signal.connected ? 'Ready to pair' : 'Server disconnected'); message(text);
  $('peer-name').textContent = '';
}
function recover() {
  clearTimeout(recoverTimer);
  if (!session || document.visibilityState === 'hidden') return;
  if (peer?.channel?.readyState === 'open' && peer.pc.connectionState === 'connected') return;
  status('Reconnecting your browsers…');
  recoverTimer = setTimeout(() => {
    if (!session || !signal.connected || !peerOnline || document.visibilityState === 'hidden') return;
    signal.send('restart', { epoch });
  }, 800);
}
async function beginPair(msg) {
  closePeer(); epoch = msg.epoch; peerOnline = true;
  peerDeviceName = msg.peerName || 'another browser';
  $('peer-name').textContent = `Paired with ${peerDeviceName}`;
  status('Making a connection…');
  const instance = peer = new Peer(data => signal.send('signal', { epoch: msg.epoch, data }), config.iceServers, config.iceTransportPolicy);
  instance.addEventListener('open', async event => {
    if (peer !== instance) return;
    try { verifiedPeer = await identity.authenticate(event.detail); }
    catch (error) { if (peer === instance) { closePeer(); message(error.message); recover(); } return; }
    if (peer !== instance) return;
    renderTrust();
    transfer.attach(event.detail); status('Connected · Ready to send', true); message(); renderState();
    try {
      const stats = await instance.pc.getStats();
      let relayed = false;
      for (const stat of stats.values()) if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        const local = stats.get(stat.localCandidateId), remote = stats.get(stat.remoteCandidateId);
        relayed ||= local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      }
      if (peer === instance) $('peer-name').textContent = `Paired with ${peerDeviceName} · ${relayed ? 'Relayed connection' : 'Direct connection'}`;
    } catch {}
  });
  const interrupted = event => {
    if (peer !== instance) return;
    closePeer();
    if (event?.detail) message(`${event.detail} Retrying; queued files and received bytes are retained.`);
    recover();
  };
  instance.addEventListener('error', interrupted); instance.addEventListener('closed', interrupted);
  instance.addEventListener('state', ({ detail }) => {
    if (peer !== instance) return;
    if (detail === 'disconnected') {
      status('Connection interrupted');
      clearTimeout(recoverTimer); recoverTimer = setTimeout(() => { if (peer === instance && instance.pc.connectionState === 'disconnected') interrupted(); }, 5000);
    }
    if (detail === 'connected' && transfer.connected) { clearTimeout(recoverTimer); status('Connected · Ready to send', true); }
  });
  await instance.start(msg.initiator);
}
async function handle(msg) {
  if (['created', 'joined', 'resumed'].includes(msg.type)) {
    rememberSession({ code: msg.code, token: msg.token }); epoch = msg.epoch; peerOnline = msg.peerOnline;
    showRoom(); renderState();
    if (msg.peerName) { peerDeviceName = msg.peerName; $('peer-name').textContent = `Paired with ${peerDeviceName}`; }
    if (msg.type === 'created') status('Waiting for your other browser');
    else if (msg.type === 'resumed') {
      if (transfer.connected) status('Connected · Ready to send', true);
      else if (peerOnline) recover(); else status('Waiting for your other browser to return');
    }
  } else if (msg.type === 'paired') await beginPair(msg);
  else if (msg.type === 'signal' && msg.epoch === epoch && peer) await peer.receive(msg.data);
  else if (msg.type === 'peer-offline') {
    peerOnline = false;
    message('Other browser is away. Its place is reserved for 10 minutes. Transfers resume when the connection returns.');
    if (!transfer.connected) status('Waiting for your other browser');
  } else if (msg.type === 'peer-online') {
    peerOnline = true; epoch = msg.epoch; peerDeviceName = msg.peerName; $('peer-name').textContent = `Paired with ${peerDeviceName}`;
    if (!transfer.connected) recover(); else { message(); status('Connected · Ready to send', true); }
  } else if (msg.type === 'peer-left' || msg.type === 'resume-expired') endSession(msg.message || 'Pairing ended or expired. Create or join a new room.');
  else if (msg.type === 'device-name') { peerDeviceName = msg.peerName; $('peer-name').textContent = `Paired with ${peerDeviceName}`; }
  else if (msg.type === 'error') message(msg.message);
}
signal.addEventListener('open', () => {
  $('create').disabled = false; $('join').disabled = false;
  if (session?.token) { signal.send('resume', { token: session.token, name: deviceName() }); status(transfer.connected ? 'Connected · Ready to send' : 'Restoring pairing…', transfer.connected); }
  else if (/^\d{6}$/.test(joinFromLink || '') && !window.linkJoined) {
    window.linkJoined = true; $('join-code').value = joinFromLink; signal.send('join', { code: joinFromLink, name: deviceName() });
  } else status('Ready to pair');
});
signal.addEventListener('message', event => { incoming = incoming.then(() => handle(event.detail)).catch(error => { message(error.message); closePeer(); recover(); }); });
signal.addEventListener('close', event => {
  $('create').disabled = true; $('join').disabled = true;
  if (event.detail?.code === 4001) {
    endSession('This pairing moved to another tab. Reload this tab to create or join a separate room.');
    status('Pairing moved to another tab'); return;
  }
  if (!transfer.connected) status('Reconnecting to server…');
  message('Server connection lost. Reconnecting automatically; your pairing and transfer progress are retained.');
});
signal.addEventListener('error', () => message('Could not reach the server. Reconnecting when this page is visible.'));
transfer.addEventListener('state', renderState);
transfer.addEventListener('progress', ({ detail: p }) => {
  const receiving = p.direction === 'receive';
  $(receiving ? 'receive-transfer' : 'transfer').hidden = false;
  $(receiving ? 'receive-name' : 'file-name').textContent = p.name;
  $(receiving ? 'receive-state' : 'progress-text').textContent = p.stage;
  $(receiving ? 'receive-progress' : 'progress').value = p.size ? p.bytes / p.size * 100 : 100;
  $(receiving ? 'receive-detail' : 'detail').textContent = `${size(p.bytes)} / ${size(p.size)}`;
  $(receiving ? 'receive-speed' : 'speed').textContent = `${size(Math.round(p.speed || 0))}/s`;
});
transfer.addEventListener('received', ({ detail: record }) => { files.push(record); storage.remember(files); renderFiles(); addHistory(record.meta, 'Received'); });
transfer.addEventListener('sent', ({ detail: meta }) => addHistory(meta, 'Sent'));
transfer.addEventListener('error', ({ detail }) => message(detail));
transfer.addEventListener('stalled', () => { closePeer(); recover(); });
transfer.addEventListener('disconnected', recover);
$('device-name').onchange = () => { write(localStorage, 'dropno-name', deviceName()); if (signal.connected && session) signal.send('name', { name: deviceName() }); };
$('create').onclick = () => { endSession(''); signal.send('create', { name: deviceName() }); };
$('join-form').onsubmit = event => {
  event.preventDefault(); const code = $('join-code').value.trim();
  if (!/^\d{6}$/.test(code)) return message('Enter a six-digit room code.');
  if (session && signal.connected) signal.send('leave');
  endSession(''); signal.send('join', { code, name: deviceName() });
};
$('disconnect').onclick = () => { if (signal.connected) signal.send('leave'); endSession(); };
$('copy-link').onclick = async () => {
  const link = `${location.origin}/files/?room=${session.code}`;
  try { await navigator.clipboard.writeText(link); message('Pairing link copied.'); }
  catch { message(`Pairing link: ${link}`); }
};
$('trust-device').onclick = () => { try { identity.trust(verifiedPeer, peerDeviceName); renderTrust(); } catch (error) { message(error.message); } };
function choose(selected) {
  try { if (!session) throw new Error('Pair with another browser first.'); message(); transfer.enqueue(Array.from(selected)); }
  catch (error) { message(error.message); }
}
$('file').onchange = () => { choose($('file').files); $('file').value = ''; };
for (const type of ['dragenter', 'dragover']) $('drop').addEventListener(type, event => { event.preventDefault(); if (session) $('drop').classList.add('over'); });
for (const type of ['dragleave', 'drop']) $('drop').addEventListener(type, event => { event.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', event => { if (session) choose(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
$('cancel').onclick = () => { void transfer.cancelAll(); };
$('clear-files').onclick = async () => {
  for (const record of [...files]) {
    try { await record.remove(); URL.revokeObjectURL(record.url); files = files.filter(f => f !== record); }
    catch (error) { message(error.message); }
  }
  storage.remember(files); renderFiles();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && transfer.current) message('iOS may pause this transfer in the background. Return to Dropno to reconnect and resume.');
  if (document.visibilityState === 'visible') { recover(); renderState(); }
});
window.addEventListener('beforeunload', () => { signal.stop(); wakeLock.setActive(false); peer?.close(); for (const record of files) if (record.url) URL.revokeObjectURL(record.url); });
try {
  if (!window.RTCPeerConnection) throw new Error('Use a browser that supports WebRTC.');
  await storage.init(); await identity.init(); files = await storage.restore(); renderFiles(); renderHistory(); renderTrust(); renderState();
  $('storage-status').textContent = storage.disk ? 'Receives into browser disk storage · Up to 8 GiB per file, subject to free space' : 'Receives in memory · 512 MiB total · HTTPS enables disk storage where supported';
  config = await (await fetch('/files/config')).json(); signal.connect();
} catch (error) { status('Unavailable'); message(error.message); }
