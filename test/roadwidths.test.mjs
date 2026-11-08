import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Road widths typed in: each class's width on the model, ROAD_CLASSES's by default.

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const flatGround = (n, z) => new Array(n * n).fill(z);
/** How far across a straight road along y = 10 spreads at its start, x = 2. */
const acrossAtStart = (tris) => {
  const ys = tris.filter((p) => p[0] === 2).map((p) => p[1]);
  return Math.max(...ys) - Math.min(...ys);
};

test('the default widths are the ROAD_CLASSES widths', () => {
  for (const [cls, c] of Object.entries(core.ROAD_CLASSES)) assert.equal(core.ROAD_WIDTHS[cls], c.widthMm);
  assert.deepEqual(core.roadWidths(), core.ROAD_WIDTHS);
  assert.deepEqual(core.roadWidths({}), core.ROAD_WIDTHS);
  assert.deepEqual(core.roadWidths(null), core.ROAD_WIDTHS);
});

test('a width given for a class takes over from its default, and the rest keep theirs', () => {
  assert.deepEqual(core.roadWidths({ secondary: 0.45, primary: 1 }), { ...core.ROAD_WIDTHS, secondary: 0.45, primary: 1 });
  // anything not a finite number keeps the default
  assert.deepEqual(core.roadWidths({ motorway: NaN, trunk: '0.5', primary: null, secondary: Infinity }), core.ROAD_WIDTHS);
});

test('a width is held between 0.2 and 5 mm and to 0.01 mm', () => {
  assert.equal(core.ROAD_WIDTH_MIN_MM, 0.2);
  assert.equal(core.ROAD_WIDTH_MAX_MM, 5);
  const w = core.roadWidths({ motorway: 12, trunk: 0.05, primary: -1, secondary: 0.456 });
  assert.deepEqual(w, { motorway: 5, trunk: 0.2, primary: 0.2, secondary: 0.46 });
});

test('a width typed in reads as mm, held to the bounds; blank or not a number is null', () => {
  assert.equal(core.parseRoadWidthMm('0.6'), 0.6);
  assert.equal(core.parseRoadWidthMm(' 0.45 mm '), 0.45);
  assert.equal(core.parseRoadWidthMm('0,5'), 0.5);
  assert.equal(core.parseRoadWidthMm('+.8'), 0.8);
  assert.equal(core.parseRoadWidthMm('0.1'), 0.2);
  assert.equal(core.parseRoadWidthMm('0'), 0.2);
  assert.equal(core.parseRoadWidthMm('9'), 5);
  assert.equal(core.parseRoadWidthMm('1.234'), 1.23);
  assert.equal(core.parseRoadWidthMm(''), null);
  assert.equal(core.parseRoadWidthMm(null), null);
  assert.equal(core.parseRoadWidthMm('-0.6'), null);
  assert.equal(core.parseRoadWidthMm('wide'), null);
});

test('a raised road is as wide as the width given for its class', () => {
  const n = 21, widthMm = 20, line = [[2, 10], [18, 10]];
  const opts = { widthMm, mmPerMetre: 0.001 }; // 20 km across: the class widths win over the real road
  near(acrossAtStart(core.roadTriangles([{ cls: 'secondary', line }], flatGround(n, 1), n, opts)), 0.6);
  const tris = core.roadTriangles([{ cls: 'secondary', line }], flatGround(n, 1), n, { ...opts, widths: { ...core.ROAD_WIDTHS, secondary: 0.45 } });
  assert.ok(core.isClosed(tris));
  near(acrossAtStart(tris), 0.45);
});

test('the real road still wins where it is wider than the width given', () => {
  const n = 21, widthMm = 20;
  // 100 m across 20 mm: a 10 m secondary road is 2 mm, over the 0.45 given
  const tris = core.roadTriangles([{ cls: 'secondary', line: [[2, 10], [18, 10]] }], flatGround(n, 1), n,
    { widthMm, mmPerMetre: 0.2, widths: { secondary: 0.45 } });
  near(acrossAtStart(tris), 2);
});

test('a sunk road is cut as wide as the width given for its class', () => {
  const n = 21, widthMm = 20; // a grid point each mm
  const line = [[2, 10.5], [18, 10.5]], levels = { ...core.NO_ROADS, primary: -1 }, opts = { widthMm, mmPerMetre: 0.001, levels };
  // 0.8 mm across: only the grid points nearest the line, a row of them
  const narrow = core.carveRoads(flatGround(n, 3), [{ cls: 'primary', line }], n, opts);
  // 3 mm across: the points 1.5 mm either side, the rows at y = 9, 10, 11 and 12
  const wide = core.carveRoads(flatGround(n, 3), [{ cls: 'primary', line }], n, { ...opts, widths: { primary: 3 } });
  const rows = (mask) => new Set([...mask.keys()].filter((k) => mask[k]).map((k) => Math.floor(k / n))).size;
  assert.equal(rows(narrow.mask), 1);
  assert.equal(rows(wide.mask), 4);
});

test('a road run shorter than its width given is left out', () => {
  const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
  // 100 mm across the box: this primary road is 1 mm long
  const osm = { elements: [{ type: 'way', tags: { highway: 'primary' }, geometry: [{ lon: 0.005, lat: 0.005 }, { lon: 0.0051, lat: 0.005 }] }] };
  assert.equal(core.roadLines(osm, bounds, 100).length, 1);
  assert.equal(core.roadLines(osm, bounds, 100, { widths: { ...core.ROAD_WIDTHS, primary: 1.5 } }).length, 0);
});

test('a KML keeps the road widths, and one from before them opens at the defaults', () => {
  const centre = { name: 'Chicago Loop', lat: 41.88, lon: -87.63 };
  const roadWidthMm = { motorway: 2, trunk: 1, primary: 0.7, secondary: 0.45 };
  const set = { sideKm: 10, widthMm: 120, cells: 201, exaggeration: 1, baseMm: 3, roadMm: core.ROAD_LEVELS, roadWidthMm, waterMm: core.NO_WATER };
  const kml = core.printKml({ centre, set });
  assert.deepEqual(core.parsePrintKml(kml).set.roadWidthMm, roadWidthMm);
  const before = kml.replace(/ *<Data name="(motorway|trunk|primary|secondary)WidthMm">[\s\S]*?<\/Data>\n/g, '');
  assert.deepEqual(core.parsePrintKml(before).set.roadWidthMm, core.ROAD_WIDTHS);
  // a set without widths saves the defaults
  const plain = core.printKml({ centre, set: { ...set, roadWidthMm: undefined } });
  assert.deepEqual(core.parsePrintKml(plain).set.roadWidthMm, core.ROAD_WIDTHS);
});

test('a KML with a road width out of bounds is turned away', () => {
  const centre = { name: 'Chicago Loop', lat: 41.88, lon: -87.63 };
  const set = { sideKm: 10, widthMm: 120, cells: 201, exaggeration: 1, baseMm: 3, roadMm: core.ROAD_LEVELS, waterMm: core.NO_WATER };
  const kml = core.printKml({ centre, set }).replace(/(<Data name="trunkWidthMm">[\s\S]*?<value>)[^<]*/, '$19');
  assert.throws(() => core.parsePrintKml(kml), /trunkWidthMm/);
});
