import { networkInterfaces } from 'node:os';

export function connectionOptions(req, server, publicUrl) {
  const origin = new URL(`http://${req.headers.host}`).origin, urls = new Set([origin]);
  const bound = server.address(), lanEnabled = bound && ['0.0.0.0', '::'].includes(bound.address);
  if (lanEnabled) for (const interfaces of Object.values(networkInterfaces())) for (const address of interfaces || []) {
    if (address.family === 'IPv4' && !address.internal) urls.add(`http://${address.address}:${bound.port}`);
  }
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path');
    urls.add(url.origin);
  }
  const addresses = [...urls], local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  return { addresses, defaultUrl: publicUrl ? new URL(publicUrl).origin : local && addresses.length > 1 ? addresses[1] : origin, lanEnabled };
}
