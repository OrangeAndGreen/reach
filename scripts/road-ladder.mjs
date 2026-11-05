// Writes the road width test print (core.roadLadder) as an STL: node scripts/road-ladder.mjs [file]
// The same file downloads from the Print tab's "Download road width test" button.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as core from '../src/core.js';

const file = process.argv[2] || 'output/reach-road-width-test.stl';
const { solids, rungs, sizeMm } = core.roadLadder();
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, new Uint8Array(core.writeStl(solids.flat())));
console.log(`${file}: ${sizeMm.map((v) => +v.toFixed(1)).join(' x ')} mm`);
for (const r of rungs) console.log(`  ${r.dots} dot${r.dots > 1 ? 's' : ' '}  ${r.cls}: ${r.widthMm} mm wide, ${r.liftMm} mm high`);
