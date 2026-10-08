import { sha256, hex, transferId } from './hash.js';
const encode = text => new TextEncoder().encode(text);
const canonical = jwk => JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
const fingerprint = jwk => hex(sha256(encode(canonical(jwk))));

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dropno-identity', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Device identity storage is blocked'));
  });
}
async function storedIdentity(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', value ? 'readwrite' : 'readonly');
    const request = value ? tx.objectStore('keys').put(value, 'device') : tx.objectStore('keys').get('device');
    let result; request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

export class DeviceIdentity {
  constructor() {
    try { this.trusted = JSON.parse(localStorage.getItem('dropno-trusted')) || {}; } catch { this.trusted = {}; }
    if (typeof this.trusted !== 'object' || Array.isArray(this.trusted)) this.trusted = {};
  }
  async init() {
    if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) return;
    let db;
    try {
      db = await database();
      let identity = await storedIdentity(db);
      if (!identity?.privateKey || !identity.publicKey) {
        const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        identity = { privateKey: keys.privateKey, publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey) };
        await storedIdentity(db, identity);
      }
      this.privateKey = identity.privateKey; this.publicKey = identity.publicKey; this.id = fingerprint(this.publicKey);
    } catch { /* Automatic transfer still works without persistent identity support. */ }
    finally { db?.close(); }
  }
  isTrusted(peer) { return Boolean(peer?.verified && Object.hasOwn(this.trusted, peer.id)); }
  trust(peer, name) {
    if (!peer?.verified) throw new Error('This browser connection has no verified device key.');
    this.trusted[peer.id] = { name: String(name).slice(0, 40) }; this.save();
  }
  forget(id) { delete this.trusted[id]; this.save(); }
  save() { localStorage.setItem('dropno-trusted', JSON.stringify(this.trusted)); }
  async authenticate(channel) {
    const nonce = transferId();
    let remote, publicKey, localVerified = false, remoteReady = false, chain = Promise.resolve();
    const textFor = (ownNonce, otherNonce, ownId, otherId) => encode(`Dropno identity v1\n${ownNonce}\n${otherNonce}\n${ownId}\n${otherId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Device verification timed out')), 15000);
      const cleanup = () => { clearTimeout(timer); channel.removeEventListener('message', message); channel.removeEventListener('close', closed); };
      const fail = error => { cleanup(); reject(error); };
      const finish = () => { if (localVerified && remoteReady) { cleanup(); resolve(remote); } };
      const send = value => channel.send(JSON.stringify(value));
      const closed = () => fail(new Error('Connection closed during device verification'));
      const message = event => {
        chain = chain.then(async () => {
          if (typeof event.data !== 'string' || event.data.length > 8192) throw new Error('Invalid device verification message');
          const msg = JSON.parse(event.data);
          if (msg.type === 'identity-hello') {
            if (remote) throw new Error('Repeated device greeting');
            if (!/^[a-f0-9]{32}$/.test(msg.nonce)) throw new Error('Invalid device challenge');
            if (this.privateKey && msg.key) {
              if (msg.key.kty !== 'EC' || msg.key.crv !== 'P-256' || !/^[a-f0-9]{64}$/.test(msg.id) || fingerprint(msg.key) !== msg.id) throw new Error('Invalid device identity');
              publicKey = await crypto.subtle.importKey('jwk', msg.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
              remote = { id: msg.id, nonce: msg.nonce, verified: false };
              const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, textFor(nonce, msg.nonce, this.id, msg.id));
              send({ type: 'identity-proof', signature: hex(new Uint8Array(signature)) });
            } else {
              remote = { verified: false }; localVerified = true;
              send({ type: 'identity-ready' }); finish();
            }
          } else if (msg.type === 'identity-proof') {
            if (!remote || !publicKey || !/^[a-f0-9]{128}$/.test(msg.signature)) throw new Error('Invalid device proof');
            const bytes = Uint8Array.from(msg.signature.match(/../g), byte => parseInt(byte, 16));
            const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, bytes, textFor(remote.nonce, nonce, remote.id, this.id));
            if (!verified) throw new Error('Device signature verification failed');
            remote.verified = true; localVerified = true; send({ type: 'identity-ready' }); finish();
          } else if (msg.type === 'identity-ready') { remoteReady = true; finish(); }
        }).catch(fail);
      };
      channel.addEventListener('message', message); channel.addEventListener('close', closed);
      send({ type: 'identity-hello', nonce, id: this.id, key: this.publicKey });
    });
  }
}
