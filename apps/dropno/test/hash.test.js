import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashFile, sha256, hex } from '../public/js/hash.js';

test('streamed browser hashes match Node SHA-256 for empty and multi-block files', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), Buffer.alloc(2 * 1024 * 1024 + 17, 0x61)]) {
    const expected = createHash('sha256').update(bytes).digest('hex');
    const blob = new Blob([bytes]);
    assert.equal(await hashFile(blob), expected);
    const incremental = sha256.create();
    for (let offset = 0; offset < bytes.length; offset += 16384) incremental.update(bytes.subarray(offset, offset + 16384));
    assert.equal(hex(incremental.digest()), expected);
  }
});
