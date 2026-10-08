import { sha256 } from '../vendor/hashes/sha2.js';
export { sha256 };
export const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export const transferId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export async function hashFile(file, onProgress = () => {}, isCancelled = () => false) {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    if (isCancelled()) throw new Error('Cancelled');
    const chunk = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
    hash.update(chunk); onProgress(Math.min(offset + chunk.length, file.size));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return hex(hash.digest());
}
