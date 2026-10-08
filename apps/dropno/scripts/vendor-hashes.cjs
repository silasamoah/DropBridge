// Keep the locally served browser modules and license in sync with the locked dependency.
const fs = require('node:fs');
const path = require('node:path');
const source = path.dirname(require.resolve('@noble/hashes/sha2.js'));
const target = path.resolve(__dirname, '../public/vendor/hashes');
fs.mkdirSync(target, { recursive: true });
for (const name of ['sha2.js', '_md.js', '_u64.js', 'utils.js', 'LICENSE']) fs.copyFileSync(path.join(source, name), path.join(target, name));
console.log('Browser hash modules and license are up to date.');
