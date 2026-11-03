// Writes the bridge test print (core.bridgeLadder) as an STL: node scripts/bridge-ladder.mjs [file]
// The same file downloads from the Print tab's "Download bridge test" button.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as core from '../src/core.js';

const file = process.argv[2] || 'output/reach-bridge-test.stl';
const { solids, rungs, sizeMm } = core.bridgeLadder();
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, new Uint8Array(core.writeStl(solids.flat())));
console.log(`${file}: ${sizeMm.map((v) => +v.toFixed(1)).join(' x ')} mm`);
for (const r of rungs) console.log(`  ${r.dots} dot${r.dots > 1 ? 's' : ' '}  ${r.spanMm} mm span`);
