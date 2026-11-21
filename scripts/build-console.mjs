// Builds the management console page from one template.
//   node scripts/build-console.mjs                    → server/console.html (live, fetches the viewer APIs)
//   node scripts/build-console.mjs --data snap.json   → an offline snapshot page elsewhere
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const template = fs.readFileSync(path.join(root, 'server/console.template.html'), 'utf8');
const argIndex = process.argv.indexOf('--data');
const snapshot = argIndex >= 0 ? fs.readFileSync(path.resolve(process.argv[argIndex + 1]), 'utf8') : 'null';
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(root, 'server/console.html');
if (!template.includes('/*__DATA__*/null')) throw new Error('template marker missing');
const html = template.replace('/*__DATA__*/null', snapshot);
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB${snapshot === 'null' ? ', live' : ', snapshot'})`);
