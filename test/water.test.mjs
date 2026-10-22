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
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 2, baseMm: 3, seaFloorM: 0, depthStretch: 2, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roads: false, waterMm: 0.6, cols: 1, rows: 1 };
  const model = { zoom: 12, pixelM: 28, lowM: 500, highM: 1600, reliefMm: 11, triangles: 90000, water: { km2: 12.345, readAt: '2026-10-22' } };
  const kml = core.printKml({ centre, set, model });
  assert.match(kml, /<Data name="waterKm2">.*<value>12.35<\/value>/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
});
