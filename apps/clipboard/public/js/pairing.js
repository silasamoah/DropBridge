const SAVED_KEY = 'clipboardbridge.pairings.v1', TAB_KEY = 'clipboardbridge.active.v1';
export function validTicket(ticket, now = Date.now()) {
  return !!ticket && /^\d{6}$/.test(ticket.code) && typeof ticket.token === 'string' && /^[a-f0-9-]{36}$/.test(ticket.token)
    && typeof ticket.expiresAt === 'number' && ticket.expiresAt > now && ticket.remember === true;
}
export class PairingStore {
  constructor(local, session) { this.local = local; this.session = session; }
  list() {
    try {
      const values = JSON.parse(this.local.getItem(SAVED_KEY) || '[]');
      if (!Array.isArray(values)) return [];
      const live = values.filter(ticket => validTicket(ticket)).slice(-8);
      if (live.length !== values.length) { try { this.local.setItem(SAVED_KEY, JSON.stringify(live)); } catch {} }
      return live;
    } catch { return []; }
  }
  clearActive() { try { this.session.removeItem(TAB_KEY); } catch {} }
  active() {
    try {
      const ticket = JSON.parse(this.session.getItem(TAB_KEY));
      return validTicket(ticket) && this.list().some(item => item.token === ticket.token) ? ticket : null;
    } catch { return null; }
  }
  save(ticket) {
    if (!validTicket(ticket)) return false;
    try {
      this.local.setItem(SAVED_KEY, JSON.stringify([...this.list().filter(item => item.token !== ticket.token), ticket].slice(-8)));
      this.session.setItem(TAB_KEY, JSON.stringify(ticket)); return true;
    } catch { return false; }
  }
  forget(token) {
    try { this.local.setItem(SAVED_KEY, JSON.stringify(this.list().filter(item => item.token !== token))); } catch {}
    try {
      if (JSON.parse(this.session.getItem(TAB_KEY) || 'null')?.token === token) this.session.removeItem(TAB_KEY);
    } catch {}
  }
}
export function browserPairingStore() {
  // Access itself can throw when storage is disabled.
  try { return new PairingStore(localStorage, sessionStorage); }
  catch { return new PairingStore(null, null); }
}
