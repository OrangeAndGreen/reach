import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Lakes and wide rivers, sunk.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

/** A frame that puts lon/lat straight onto model mm, so a test can draw in mm. */
const flat = { toMm: (lon, lat) => [lon, lat] };
const way = (id, pts, tags = { natural: 'water' }) => ({ type: 'way', id, tags, geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
const close = (ring) => [...ring, ring[0]];

test('the water query asks for water and riverbank areas, as ways and multipolygons', () => {
  const q = core.overpassWaterQuery({ south: 41.8, west: -87.7, north: 41.9, east: -87.6 });
  const box = '41.800000,-87.700000,41.900000,-87.600000';
  for (const part of [`way["natural"="water"](${box})`, `relation["natural"="water"]["type"="multipolygon"](${box})`,
    `way["waterway"="riverbank"](${box})`, `relation["waterway"="riverbank"]["type"="multipolygon"](${box})`]) assert.ok(q.includes(part), part);
  assert.match(q, /out geom;$/);
});

test('waterRings takes a closed way, a multipolygon with an island, and skips what is not open water', () => {
  assert.deepEqual(core.waterRings(way(1, close([[0, 0], [1, 0], [1, 1]]))), [[[0, 0], [1, 0], [1, 1]]]);
  assert.deepEqual(core.waterRings(way(2, [[0, 0], [1, 0], [1, 1]])), []); // never closes
  assert.deepEqual(core.waterRings(way(3, close([[0, 0], [1, 0], [1, 1]]), { natural: 'water', water: 'wastewater' })), []);
  assert.deepEqual(core.waterRings(way(4, close([[0, 0], [1, 0], [1, 1]]), { natural: 'water', covered: 'yes' })), []);
  const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
  const lake = {
    type: 'relation', id: 5, tags: { natural: 'water', type: 'multipolygon' },
    members: [
      { type: 'way', role: 'outer', geometry: g([[0, 0], [10, 0], [10, 10]]) }, // the outline in two halves
      { type: 'way', role: 'outer', geometry: g([[0, 0], [0, 10], [10, 10]]) },
      { type: 'way', role: 'inner', geometry: g(close([[4, 4], [6, 4], [6, 6], [4, 6]])) },
    ],
  };
  const rings = core.waterRings(lake);
  assert.equal(rings.length, 2);
  assert.equal(rings[0].length, 4);
});

test('waterByCell keeps only each cell its own piece of a lake', () => {
  const z = 13;
  const cells = [{ x: 2100, y: 3040 }, { x: 2101, y: 3040 }];
  const a = core.cellBounds(cells[0], z), b = core.cellBounds(cells[1], z);
  // a lake across both cells and well past them, with far more ground than either
  const lake = way(7, close([[a.west - 1, a.south - 1], [b.east + 1, a.south - 1], [b.east + 1, a.north + 1], [a.west - 1, a.north + 1]]));
  const parts = core.waterByCell({ elements: [lake, way(8, close([[50, 50], [51, 50], [51, 51]]))] }, cells, z);
  for (const [i, c] of cells.entries()) {
    const list = parts.get(`${c.x}/${c.y}`), cb = [a, b][i];
    assert.equal(list.length, 1);
    for (const [lon, lat] of list[0].rings[0]) {
      assert.ok(lon >= cb.west - 1e-9 && lon <= cb.east + 1e-9 && lat >= cb.south - 1e-9 && lat <= cb.north + 1e-9);
    }
  }
  // two pieces of one lake, so merging the cells keeps both
  assert.equal(core.mergeElements([...parts.values()]).elements.length, 2);
});

test('waterPoints fills a lake, leaves its island and the sea, and drops a pond too small to show', () => {
  const n = 21, widthMm = 20; // a point every 1 mm
  const heights = new Array(n * n).fill(100);
  const lake = { type: 'water', id: 'a', rings: [[[2, 2], [18, 2], [18, 18], [2, 18]], [[8, 8], [12, 8], [12, 12], [8, 12]]] };
  const at = (x, y) => (n - 1 - y) * n + x; // mm to grid index, row 0 north
  let water = core.waterPoints({ elements: [lake] }, heights, n, widthMm, flat);
  assert.equal(water[at(5, 5)], 1);
  assert.equal(water[at(10, 10)], 0, 'the island');
  assert.equal(water[at(1, 1)], 0, 'outside');
  assert.equal(water[at(5, 15)], 1, 'north is up');
  heights[at(5, 5)] = 0; // at sea level: the sea's, not the lake's
  water = core.waterPoints({ elements: [lake] }, heights, n, widthMm, flat);
  assert.equal(water[at(5, 5)], 0);
  const pond = { type: 'water', id: 'b', rings: [[[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]]] }; // one grid point, 1 mm²
  assert.equal(core.waterPoints({ elements: [pond] }, heights, n, widthMm, flat).reduce((s, v) => s + v, 0), 0);
});

test('two pieces of a lake cut at a cell edge fill as the whole lake does', () => {
  const n = 21, widthMm = 20;
  const heights = new Array(n * n).fill(100);
  const whole = { type: 'water', id: 'w', rings: [[[2, 2], [18, 2], [18, 18], [2, 18]]] };
  const left = { type: 'water', id: 'l', rings: [core.clipToConvex(whole.rings[0], [[0, 0], [10, 0], [10, 20], [0, 20]])] };
  const right = { type: 'water', id: 'r', rings: [core.clipToConvex(whole.rings[0], [[10, 0], [20, 0], [20, 20], [10, 20]])] };
  assert.deepEqual(core.waterPoints({ elements: [left, right] }, heights, n, widthMm, flat), core.waterPoints({ elements: [whole] }, heights, n, widthMm, flat));
});

test('carveWater sinks a lake to one level under its lowest water, and leaves the land', () => {
  const n = 5;
  const mm = new Array(n * n).fill(8);
  const water = new Uint8Array(n * n);
  for (const k of [6, 7, 8, 11, 12, 13]) { water[k] = 1; mm[k] = 5; }
  mm[6] = 5.4; // the shore's blur lifts one water point
  const out = core.carveWater(mm, water, n, 0.6);
  for (const k of [6, 7, 8, 11, 12, 13]) near(out[k], 4.4, 1e-9);
  assert.equal(out[0], 8);
  // never under the floor, nor raised where the ground already lies lower
  near(core.carveWater([1, 1, 1, 1], new Uint8Array([1, 1, 1, 1]), 2, 1.2)[0], 0.6, 1e-9);
  near(core.carveWater([0.3, 1, 1, 1], new Uint8Array([1, 0, 0, 0]), 2, 1.2)[0], 0.3, 1e-9);
});

test('a print KML keeps the water setting and the area sunk', () => {
  const centre = { name: 'Lake Placid', lat: 44.28, lon: -73.98 };
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 2, baseMm: 3, seaFloorM: 0, depthStretch: 2, shoreMm: 0, shoreRidge: false, label: false, labelText: '', balance: false, infillPercent: 15, cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: core.NO_ROADS, waterMm: { lakes: -0.6, wide: 1.2, narrow: -2 }, cols: 1, rows: 1, tracks: [], waters: [], bins: [], binClearMm: 0.4 };
  const model = { zoom: 12, pixelM: 28, lowM: 500, highM: 1600, reliefMm: 11, triangles: 90000, water: { lakesKm2: 12.345, wideKm2: 1, riverKm: 3, readAt: '2026-10-22' } };
  const kml = core.printKml({ centre, set, model });
  assert.match(kml, /<Data name="lakesKm2">.*<value>12.35<\/value>/);
  assert.match(kml, /<Data name="wideRiversMm">.*<value>1.2<\/value>/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
});

test('a KML from before each kind of water had its own level sinks them all its one depth', () => {
  const centre = { name: 'Lake Placid', lat: 44.28, lon: -73.98 };
  const set = { sideKm: 20, widthMm: 120, cells: 201, exaggeration: 2, baseMm: 3, roadMm: core.NO_ROADS, waterMm: core.NO_WATER };
  const old = (kml, data) => kml.replace(/ *<Data name="(lakes|wideRivers|narrowRivers)Mm">[\s\S]*?<\/Data>\n/g, '').replace('</ExtendedData>', `${data}</ExtendedData>`);
  const kml = old(core.printKml({ centre, set }), '<Data name="waterMm"><value>1.2</value></Data>');
  assert.deepEqual(core.parsePrintKml(kml).set.waterMm, { lakes: -1.2, wide: -1.2, narrow: -1.2 });
  assert.deepEqual(core.parsePrintKml(old(core.printKml({ centre, set }), '')).set.waterMm, core.NO_WATER);
});

test('waterKinds splits a lake from a river area, and the lake keeps where they overlap', () => {
  const n = 21, widthMm = 20;
  const heights = new Array(n * n).fill(100);
  const lake = { type: 'water', rings: [[[2, 2], [10, 2], [10, 18], [2, 18]]], wide: false };
  const river = { type: 'water', rings: [[[8, 8], [18, 8], [18, 12], [8, 12]]], wide: true };
  const { lakes, wide } = core.waterKinds({ elements: [lake, river] }, heights, n, widthMm, flat);
  const at = (x, y) => (n - 1 - y) * n + x;
  assert.equal(lakes[at(5, 5)], 1);
  assert.equal(wide[at(5, 5)], 0);
  assert.equal(lakes[at(9, 10)], 1); // in both
  assert.equal(wide[at(9, 10)], 0);
  assert.equal(wide[at(15, 10)], 1);
  assert.equal(lakes[at(15, 10)], 0);
});

test('wideRiver tells a river area from a lake', () => {
  assert.equal(core.wideRiver({ waterway: 'riverbank' }), true);
  assert.equal(core.wideRiver({ natural: 'water', water: 'river' }), true);
  assert.equal(core.wideRiver({ natural: 'water', water: 'canal' }), true);
  assert.equal(core.wideRiver({ natural: 'water', water: 'reservoir' }), false);
  assert.equal(core.wideRiver({ natural: 'water' }), false);
});

test('raised water stands its height over the lowest water near it, lifting only what is under it', () => {
  // a lake reading 1 mm flat, its edge blurred up to 1.5 mm
  const mm = [1.5, 1, 1, 1], water = new Uint8Array([1, 1, 1, 1]);
  const out = core.carveWater(mm, water, 2, -0.4);
  near(out[1], 1.4, 1e-9);
  near(out[0], 1.5, 1e-9); // already over the level, left as it is
});

test('a raised river is a ridge over the lowest ground upstream, never cutting', () => {
  const n = 21, widthMm = 20;
  const mm = new Array(n * n).fill(5);
  for (let i = 0; i < n; i++) mm[10 * n + i] = 5 - i * 0.1; // the river's row falls 2 mm west to east
  mm[10 * n + 12] = 6; // a bump in the data
  const river = [[0, 10, 1], [20, 10, 1]];
  const { mm: out, mask } = core.carveRivers(mm, [river], n, { widthMm, mmPerMetre: 1, depthMm: -0.8 });
  near(out[10 * n + 5], 4.5 + 0.8, 0.06); // samples half a step downstream reach it too
  near(out[10 * n + 12], 6, 1e-9); // the bump stays: a raised river only lifts
  near(out[10 * n + 13], 3.7 + 0.8, 0.06); // and drops back to the lowest level upstream past it
  assert.equal(mask[10 * n + 5], 1);
});

// Narrow rivers, cut as channels.

test('the water query asks for river lines too', () => {
  const q = core.overpassWaterQuery({ south: 41.8, west: -87.7, north: 41.9, east: -87.6 });
  assert.ok(q.includes('way["waterway"="river"](41.800000,-87.700000,41.900000,-87.600000)'));
});

test('riverLine keeps a river way in its own order with its width, and skips culverts and streams', () => {
  assert.deepEqual(core.riverLine(way(1, [[0, 0], [1, 0]], { waterway: 'river', width: '45' })), [[0, 0, 45], [1, 0, 45]]);
  assert.deepEqual(core.riverLine(way(2, [[0, 0], [1, 0]], { waterway: 'river' })), [[0, 0, core.RIVER_WIDTH_M], [1, 0, core.RIVER_WIDTH_M]]);
  assert.equal(core.riverLine(way(3, [[0, 0], [1, 0]], { waterway: 'river', tunnel: 'culvert' })), null);
  assert.equal(core.riverLine(way(4, [[0, 0], [1, 0]], { waterway: 'stream' })), null);
});

test('waterByCell keeps a river whole in each cell it crosses, once when merged', () => {
  const z = 13;
  const cells = [{ x: 2100, y: 3040 }, { x: 2101, y: 3040 }];
  const a = core.cellBounds(cells[0], z), b = core.cellBounds(cells[1], z);
  const mid = (a.south + a.north) / 2;
  const river = way(9, [[a.west + 1e-4, mid], [b.east - 1e-4, mid]], { waterway: 'river' });
  const parts = core.waterByCell({ elements: [river] }, cells, z);
  for (const c of cells) assert.deepEqual(parts.get(`${c.x}/${c.y}`).map((e) => e.line.length), [2]);
  const merged = core.mergeElements([...parts.values()]);
  assert.equal(merged.elements.length, 1);
  assert.deepEqual(core.riverLines(merged, flat), [[[a.west + 1e-4, mid, core.RIVER_WIDTH_M], [b.east - 1e-4, mid, core.RIVER_WIDTH_M]]]);
});

test('carveRivers cuts a channel that never climbs downstream, and leaves the banks', () => {
  const n = 21, widthMm = 20; // a point every 1 mm
  const at = (x, y) => (n - 1 - y) * n + x;
  // a valley falling west to east, with a bump in the data halfway along
  const mm = Array.from({ length: n * n }, (_, k) => 10 - (k % n) * 0.2);
  for (let y = 0; y < n; y++) mm[at(10, y)] += 3;
  const river = [[0, 10, 0], [20, 10, 0]]; // no width: the narrowest cut
  const { mm: out, mask, km } = core.carveRivers(mm, [river], n, { widthMm, mmPerMetre: 1, depthMm: 0.6 });
  for (let x = 1; x <= 20; x++) assert.ok(out[at(x, 10)] <= out[at(x - 1, 10)] + 1e-9, `climbs at ${x}`);
  near(out[at(0, 10)], 9.4, 1e-9);
  near(out[at(10, 10)], 10 - 9 * 0.2 - 0.6, 1e-9, 'the bump is cut through at the level before it');
  assert.equal(mask[at(5, 10)], 1);
  assert.equal(mask[at(5, 12)], 0, 'the bank');
  assert.equal(out[at(5, 12)], mm[at(5, 12)]);
  near(km, 0.02, 1e-9);
});

test('carveRivers keeps a diagonal channel 4-connected and carries a level across a join', () => {
  const n = 21, widthMm = 20;
  const at = (x, y) => (n - 1 - y) * n + x;
  const mm = new Array(n * n).fill(10);
  let { mask } = core.carveRivers(mm, [[[0, 0, 0], [20, 20, 0]]], n, { widthMm, mmPerMetre: 0.01, depthMm: 0.6 });
  for (let x = 0; x < 20; x++) assert.ok(mask[at(x + 1, x)] || mask[at(x, x + 1)], `a step at ${x}`);
  // a tributary drawn first meets a river that has already come low; below the join both follow the lower level
  const low = mm.slice();
  for (let x = 0; x <= 10; x++) low[at(x, 4)] = 5;
  const main = [[0, 4, 0], [10, 4, 0], [10, 10, 0]], below = [[10, 10, 0], [10, 18, 0]], trib = [[18, 10, 0], [10, 10, 0]];
  const out = core.carveRivers(low, [trib, below, main], n, { widthMm, mmPerMetre: 0.01, depthMm: 0.6 }).mm;
  near(out[at(10, 15)], 4.4, 1e-9);
  near(out[at(15, 10)], 9.4, 1e-9, 'the tributary above the join keeps its own level');
});

test('carveRivers leaves the lakes, the sea and the floor alone', () => {
  const n = 5, widthMm = 4;
  const mm = new Array(n * n).fill(1);
  const skip = new Uint8Array(n * n), heights = new Array(n * n).fill(50);
  skip[2 * n + 1] = 1;
  heights[2 * n + 3] = 0;
  const { mm: out, mask } = core.carveRivers(mm, [[[0, 2, 0], [4, 2, 0]]], n, { widthMm, mmPerMetre: 0.01, depthMm: 1.2, skip, heights });
  assert.deepEqual([...mask.slice(2 * n, 3 * n)], [1, 0, 1, 0, 1]);
  near(out[2 * n], 0.6, 1e-9);
  assert.equal(out[2 * n + 1], 1);
});
