import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// OpenStreetMap data saved by cell.

const way = (id, points, tags = {}) => ({ type: 'way', id, tags, geometry: points.map(([lon, lat]) => ({ lon, lat })) });

test('cellsForBounds lists every cell a box touches, row by row from the north', () => {
  const z = 16;
  const c = core.cellBounds({ x: 19830, y: 24240 }, z);
  // A box just inside one cell is that cell alone.
  const inset = { west: c.west + 1e-5, east: c.east - 1e-5, south: c.south + 1e-5, north: c.north - 1e-5 };
  assert.deepEqual(core.cellsForBounds(inset, z), [{ x: 19830, y: 24240 }]);
  // Reaching just past its east and south edges takes in three more.
  const wider = { ...inset, east: c.east + 1e-5, south: c.south - 1e-5 };
  assert.deepEqual(core.cellsForBounds(wider, z), [
    { x: 19830, y: 24240 }, { x: 19831, y: 24240 }, { x: 19830, y: 24241 }, { x: 19831, y: 24241 },
  ]);
});

test('a 2 km print near Boston touches a handful of building cells', () => {
  const b = { west: -71.07, east: -71.046, south: 42.351, north: 42.369 };
  const cells = core.cellsForBounds(b, core.OSM_CELL_ZOOM.buildings);
  assert.ok(cells.length >= 16 && cells.length <= 36, `${cells.length} cells`);
});

test('cellBoxes joins a full block of cells into one box', () => {
  const z = 13;
  const cells = [];
  for (let y = 10; y < 13; y++) for (let x = 20; x < 24; x++) cells.push({ x, y });
  const boxes = core.cellBoxes(cells, z);
  assert.equal(boxes.length, 1);
  const nw = core.cellBounds({ x: 20, y: 10 }, z), se = core.cellBounds({ x: 23, y: 12 }, z);
  assert.deepEqual(boxes[0], { west: nw.west, north: nw.north, east: se.east, south: se.south });
});

test('cellBoxes leaves out the saved cells an L of missing ones goes round', () => {
  const z = 13;
  // Row 10 across x 20..22, then x 20 alone in rows 11 and 12: an L.
  const cells = [{ x: 20, y: 10 }, { x: 21, y: 10 }, { x: 22, y: 10 }, { x: 20, y: 11 }, { x: 20, y: 12 }];
  const boxes = core.cellBoxes(cells, z);
  assert.equal(boxes.length, 2);
  const covered = (c) => {
    const m = core.cellBounds(c, z);
    const mid = { lon: (m.west + m.east) / 2, lat: (m.south + m.north) / 2 };
    return boxes.some((b) => mid.lon > b.west && mid.lon < b.east && mid.lat > b.south && mid.lat < b.north);
  };
  for (const c of cells) assert.ok(covered(c), `cell ${c.x}/${c.y} is asked for`);
  assert.ok(!covered({ x: 21, y: 11 }) && !covered({ x: 22, y: 12 }), 'saved cells are not asked for again');
});

test('cellBoxes handles cells listed in any order, and rows with gaps', () => {
  const z = 13;
  const boxes = core.cellBoxes([{ x: 5, y: 3 }, { x: 5, y: 1 }, { x: 4, y: 1 }], z);
  assert.equal(boxes.length, 2);
});

test('the queries ask for every box in a list, in one reply', () => {
  const boxes = [{ south: 1, west: 2, north: 3, east: 4 }, { south: 5, west: 6, north: 7, east: 8 }];
  const b = core.overpassBuildingsQuery(boxes);
  assert.match(b, /way\["building"\]\(1\.000000,2\.000000,3\.000000,4\.000000\)/);
  assert.match(b, /relation\["building"\]\["type"="multipolygon"\]\(5\.000000,6\.000000,7\.000000,8\.000000\)/);
  const r = core.overpassRoadsQuery(boxes);
  assert.equal(r.match(/way\["highway"/g).length, 2);
  assert.match(r, /^\[out:json\]\[timeout:90\];\(.*\);out geom;$/);
});

test('elementBounds reads a way, a relation, or Overpass bounds alone', () => {
  assert.deepEqual(core.elementBounds(way(1, [[1, 2], [3, 0]])), { west: 1, east: 3, south: 0, north: 2 });
  const rel = { type: 'relation', id: 2, members: [{ type: 'way', geometry: [{ lon: 5, lat: 5 }] }, { type: 'way', geometry: [{ lon: 6, lat: 4 }] }] };
  assert.deepEqual(core.elementBounds(rel), { west: 5, east: 6, south: 4, north: 5 });
  assert.deepEqual(core.elementBounds({ type: 'way', id: 3, bounds: { minlon: 1, maxlon: 2, minlat: 3, maxlat: 4 } }),
    { west: 1, east: 2, south: 3, north: 4 });
  assert.equal(core.elementBounds({ type: 'node', id: 4 }), null);
});

test('elementsByCell keeps an element in every asked-for cell it crosses, and none it does not', () => {
  const z = 16;
  const a = core.cellBounds({ x: 100, y: 200 }, z), b = core.cellBounds({ x: 101, y: 200 }, z);
  const midLat = (a.south + a.north) / 2;
  const inA = way(1, [[a.west + 1e-4, midLat], [a.west + 2e-4, midLat]]);
  const across = way(2, [[a.east - 1e-4, midLat], [b.west + 1e-4, midLat]]);
  const outside = way(3, [[b.east + 1e-3, midLat], [b.east + 2e-3, midLat]]);
  const cells = core.elementsByCell({ elements: [inA, across, outside] }, [{ x: 100, y: 200 }, { x: 101, y: 200 }], z);
  assert.deepEqual(cells.get('100/200').map((e) => e.id), [1, 2]);
  assert.deepEqual(cells.get('101/200').map((e) => e.id), [2]);
});

test('elementsByCell gives a cell with nothing in it an empty list, so it is saved as read', () => {
  const cells = core.elementsByCell({ elements: [] }, [{ x: 1, y: 1 }], 16);
  assert.deepEqual(cells.get('1/1'), []);
});

test('mergeElements keeps each element once, whichever cells held it', () => {
  const one = way(1, [[0, 0], [1, 1]]), two = way(2, [[0, 0], [1, 1]]);
  const rel = { type: 'relation', id: 1, members: [] };
  const merged = core.mergeElements([[one, two], [two, rel], [one]]);
  assert.deepEqual(merged.elements.map((e) => `${e.type}/${e.id}`), ['way/1', 'way/2', 'relation/1']);
});

test('cellStale reads a cell again after OSM_CELL_DAYS', () => {
  assert.equal(core.cellStale('2026-01-01', '2026-03-01'), false);
  assert.equal(core.cellStale('2026-01-01', '2026-04-15'), true);
  assert.equal(core.cellStale('2026-01-01', '2026-01-03', 1), true);
});
