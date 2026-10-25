import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Raised roads.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

/** The volume a closed mesh holds, by the divergence theorem: negative if it is inside out. */
const volume = (tris) => {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
};

const flatGround = (n, z) => new Array(n * n).fill(z);

test('the roads query asks for motorway, trunk and primary ways in the box', () => {
  const q = core.overpassRoadsQuery({ south: 41.8, west: -87.7, north: 41.9, east: -87.6 });
  assert.match(q, /way\["highway"~"\^\(motorway\|trunk\|primary\)\$"\]\(41\.800000,-87\.700000,41\.900000,-87\.600000\)/);
  assert.match(q, /out geom;$/);
});

test('the secondary roads query asks for secondary ways alone', () => {
  const q = core.overpassRoadsQuery({ south: 41.8, west: -87.7, north: 41.9, east: -87.6 }, ['secondary']);
  assert.match(q, /way\["highway"~"\^\(secondary\)\$"\]/);
});

test('joinLines joins lines that meet, whichever way round they run', () => {
  const joined = core.joinLines([[[2, 0], [3, 0]], [[0, 0], [1, 0]], [[2, 0], [1, 0]], [[9, 9], [8, 8]]]);
  assert.equal(joined.length, 2);
  const long = joined.find((l) => l.length === 4);
  const xs = long.map((p) => p[0]);
  assert.ok(xs.join() === '0,1,2,3' || xs.join() === '3,2,1,0', xs.join());
});

test('clipLine keeps the runs inside the square, cut at its edges', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  // in from the west, out the north, back in through the north, out the east
  const runs = core.clipLine([[-5, 5], [5, 5], [5, 15], [8, 15], [8, 5], [15, 5]], square);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], [[0, 5], [5, 5], [5, 10]]);
  assert.deepEqual(runs[1], [[8, 10], [8, 5], [10, 5]]);
  assert.deepEqual(core.clipLine([[-5, -5], [-1, 20]], square), []);
});

test('roadLines keeps the four classes, drops tunnels, and joins ways end to end', () => {
  const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
  const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
  const osm = { elements: [
    { type: 'way', tags: { highway: 'motorway' }, geometry: g([[0.001, 0.005], [0.005, 0.005]]) },
    { type: 'way', tags: { highway: 'motorway' }, geometry: g([[0.005, 0.005], [0.009, 0.005]]) },
    { type: 'way', tags: { highway: 'primary', tunnel: 'yes' }, geometry: g([[0.001, 0.002], [0.009, 0.002]]) },
    { type: 'way', tags: { highway: 'primary', tunnel: 'no' }, geometry: g([[0.001, 0.008], [0.009, 0.008]]) },
    { type: 'way', tags: { highway: 'secondary' }, geometry: g([[0.001, 0.006], [0.009, 0.006]]) },
    { type: 'way', tags: { highway: 'residential' }, geometry: g([[0.001, 0.003], [0.009, 0.003]]) },
    { type: 'way', tags: { highway: 'motorway_link' }, geometry: g([[0.001, 0.004], [0.009, 0.004]]) },
  ] };
  const roads = core.roadLines(osm, bounds, 100);
  assert.deepEqual(roads.map((r) => r.cls), ['motorway', 'primary', 'secondary']);
  near(core.lineLength(roads[0].line), 80, 1e-6);
});

test('a road is a closed solid, standing on the ground and lifted by its class', () => {
  const n = 21, widthMm = 20, z = 3;
  const opts = { widthMm, mmPerMetre: 0.001 }; // 20 km across: the class widths win
  for (const cls of Object.keys(core.ROAD_CLASSES)) {
    const { widthMm: w, liftMm } = core.ROAD_CLASSES[cls];
    const tris = core.roadTriangles([{ cls, line: [[2, 10], [10, 10], [18, 14]] }], flatGround(n, z), n, opts);
    assert.ok(core.isClosed(tris), `${cls} is open`);
    assert.ok(volume(tris) > 0, `${cls} is inside out`);
    const zs = tris.map((p) => p[2]);
    near(Math.min(...zs), z - 0.2, 1e-9);
    near(Math.max(...zs), z + liftMm, 1e-9);
    // a straight piece across: its width is the class width
    const ys = tris.filter((p) => p[0] === 2).map((p) => p[1]);
    near(Math.max(...ys) - Math.min(...ys), w, 1e-9);
  }
});

test('on a small print a road is as wide as the real road', () => {
  const n = 21, widthMm = 20;
  // 500 m across 20 mm: a 25 m motorway is 1 mm, under the class's 1.6 mm, which stays
  let tris = core.roadTriangles([{ cls: 'motorway', line: [[2, 10], [18, 10]] }], flatGround(n, 0), n, { widthMm, mmPerMetre: 0.04 });
  let ys = tris.map((p) => p[1]);
  near(Math.max(...ys) - Math.min(...ys), 1.6, 1e-9);
  // 100 m across 20 mm: 25 m is 5 mm
  tris = core.roadTriangles([{ cls: 'motorway', line: [[2, 10], [18, 10]] }], flatGround(n, 0), n, { widthMm, mmPerMetre: 0.2 });
  ys = tris.map((p) => p[1]);
  near(Math.max(...ys) - Math.min(...ys), 5, 1e-9);
});

test('a road over a dip runs smoothed across it, and its floor follows the ground down', () => {
  const n = 41, widthMm = 40, step = 1;
  const zMm = flatGround(n, 5);
  for (let j = 0; j < n; j++) zMm[j * n + 20] = 1; // a ditch 4 mm deep down the middle, north to south
  const tris = core.roadTriangles([{ cls: 'motorway', line: [[5, 20], [35, 20]] }], zMm, n, { widthMm, mmPerMetre: 0.001 });
  assert.ok(core.isClosed(tris));
  // over the ditch the top stays well above the ditch plus the lift
  const over = tris.filter((p) => Math.abs(p[0] - 20) < step / 2).map((p) => p[2]);
  assert.ok(Math.max(...over) > 1 + 1.2 + 1, `top over the ditch is ${Math.max(...over)}`);
  near(Math.min(...over), 0.8, 1e-9);
});

test('a road in a cutting still stands over the banks beside it', () => {
  const n = 21, widthMm = 20;
  const zMm = flatGround(n, 2);
  for (let i = 0; i < n; i++) zMm[10 * n + i] = 0; // the road's own row is 2 mm down
  const tris = core.roadTriangles([{ cls: 'primary', line: [[2, 10], [18, 10]] }], zMm, n, { widthMm, mmPerMetre: 0.001 });
  assert.ok(core.isClosed(tris));
  near(Math.max(...tris.map((p) => p[2])), 2.2, 1e-9);
});

test('a print KML keeps the roads setting and the length of each class printed', () => {
  const centre = { name: 'Chicago Loop', lat: 41.88, lon: -87.63 };
  const set = { sideKm: 10, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1, baseMm: 3, seaFloorM: 0, depthStretch: 1, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: { motorway: 1.2, trunk: -0.8, primary: 0, secondary: -0.4 }, waterMm: core.NO_WATER, cols: 1, rows: 1, tracks: [] };
  const model = { zoom: 13, pixelM: 14, lowM: 170, highM: 200, reliefMm: 0.4, triangles: 90000,
    roads: { count: 40, km: { motorway: 31.24, primary: 88 }, triangles: 40000, readAt: '2026-10-22' } };
  const kml = core.printKml({ centre, set, model });
  assert.match(kml, /<Data name="motorwayKm">.*<value>31.2<\/value>/);
  assert.match(kml, /<Data name="trunkKm">.*<value>0<\/value>/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
});

test('a road with a hairpin still closes', () => {
  const n = 21, widthMm = 20;
  const tris = core.roadTriangles([{ cls: 'trunk', line: [[2, 9], [15, 9], [15.2, 10], [2, 11]] }], flatGround(n, 1), n, { widthMm, mmPerMetre: 0.001 });
  assert.ok(core.isClosed(tris));
});

test('roadTriangles builds only the classes raised, at their own level', () => {
  const n = 21, widthMm = 20;
  const roads = [{ cls: 'motorway', line: [[2, 6], [18, 6]] }, { cls: 'primary', line: [[2, 14], [18, 14]] }];
  const levels = { motorway: 2, trunk: 0, primary: -0.8 };
  const tris = core.roadTriangles(roads, flatGround(n, 1), n, { widthMm, mmPerMetre: 0.001, levels });
  assert.ok(core.isClosed(tris));
  near(Math.max(...tris.map((p) => p[2])), 3, 1e-9);
  assert.ok(tris.every((p) => p[1] < 10)); // the primary is left to carveRoads
});

test('a sunk road is a groove its depth under the ground along it, and leaves the water alone', () => {
  const n = 21, widthMm = 20;
  const zMm = flatGround(n, 3);
  const skip = new Uint8Array(n * n);
  skip[10 * n + 15] = 1; // a bridge over a river
  const roads = [{ cls: 'trunk', line: [[2, 10], [18, 10]] }, { cls: 'motorway', line: [[10, 2], [10, 6]] }];
  const { mm, mask } = core.carveRoads(zMm, roads, n, { widthMm, mmPerMetre: 0.001, levels: { motorway: 1.2, trunk: -0.8, primary: 0 }, skip });
  near(mm[10 * n + 5], 2.2, 1e-9);
  assert.equal(mask[10 * n + 5], 1);
  near(mm[10 * n + 15], 3, 1e-9);
  near(mm[16 * n + 10], 3, 1e-9); // the raised motorway isn't cut
  near(mm[5 * n + 5], 3, 1e-9);
});

test('a sunk road keeps the model under it', () => {
  const n = 21, widthMm = 20;
  const { mm } = core.carveRoads(flatGround(n, 1), [{ cls: 'primary', line: [[2, 10], [18, 10]] }], n,
    { widthMm, mmPerMetre: 0.001, levels: { motorway: 0, trunk: 0, primary: -2 } });
  near(mm[10 * n + 10], 0.6, 1e-9);
});

test('a KML from before each road class had its own level raises the main ones as they were', () => {
  const centre = { name: 'Chicago Loop', lat: 41.88, lon: -87.63 };
  const set = { sideKm: 10, widthMm: 120, cells: 201, exaggeration: 1, baseMm: 3, roadMm: core.NO_ROADS, waterMm: core.NO_WATER };
  const kml = core.printKml({ centre, set }).replace(/ *<Data name="(motorway|trunk|primary|secondary)Mm">[\s\S]*?<\/Data>\n/g, '')
    .replace('</ExtendedData>', '<Data name="roads"><value>1</value></Data></ExtendedData>');
  assert.deepEqual(core.parsePrintKml(kml).set.roadMm, { ...core.ROAD_LEVELS, secondary: 0 });
});

test('a KML from before secondary roads has none, and one with them keeps their level', () => {
  const centre = { name: 'Chicago Loop', lat: 41.88, lon: -87.63 };
  const set = { sideKm: 10, widthMm: 120, cells: 201, exaggeration: 1, baseMm: 3, roadMm: core.ROAD_LEVELS, waterMm: core.NO_WATER };
  const kml = core.printKml({ centre, set });
  assert.equal(core.parsePrintKml(kml).set.roadMm.secondary, core.ROAD_CLASSES.secondary.liftMm);
  const before = kml.replace(/ *<Data name="secondaryMm">[\s\S]*?<\/Data>\n/, '');
  assert.deepEqual(core.parsePrintKml(before).set.roadMm, { ...core.ROAD_LEVELS, secondary: 0 });
});
