import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// City prints: water of your own from KML polygons, and bridges as open spans over sunk water.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

const kml = (placemarks) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}</Document></kml>`;

test('parseWaterKml reads each placemark with polygons as an area of water, holes and all', () => {
  const waters = core.parseWaterKml(kml(`
    <Placemark><name>Fort Point Channel</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      -71.05,42.35,0 -71.04,42.35,0 -71.04,42.36,0 -71.05,42.36,0 -71.05,42.35,0
    </coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>
      -71.046,42.354 -71.044,42.354 -71.044,42.356 -71.046,42.354
    </coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
    <Placemark><name>A walk</name><LineString><coordinates>-71,42 -71.1,42.1</coordinates></LineString></Placemark>
    <Placemark><MultiGeometry>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>-71,42 -70.9,42 -70.9,42.1</coordinates></LinearRing></outerBoundaryIs></Polygon>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>-71,42 junk -70.9,42</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </MultiGeometry></Placemark>`), 'harbour');
  assert.equal(waters.length, 2);
  // the repeated last point is dropped
  assert.deepEqual(waters[0].rings[0], [[-71.05, 42.35], [-71.04, 42.35], [-71.04, 42.36], [-71.05, 42.36]]);
  assert.equal(waters[0].rings.length, 2);
  assert.equal(waters[0].levelMm, undefined);
  // a ring of fewer than three good points is no water; an unnamed placemark takes the file's name
  assert.deepEqual(waters[1], { name: 'harbour', rings: [[[-71, 42], [-70.9, 42], [-70.9, 42.1]]], levelMm: undefined });
  assert.deepEqual(core.parseWaterKml(kml('<Placemark><Point><coordinates>-71,42</coordinates></Point></Placemark>')), []);
});

test('waterKm2 is the area inside the rings, a ring inside another a hole', () => {
  // about 1.11 km a side at the equator
  const square = (d, lon = 0) => [[lon, 0], [lon + d, 0], [lon + d, d], [lon, d]];
  near(core.waterKm2({ rings: [square(0.01)] }), 1.236, 0.01);
  // a hole a quarter the area, drawn the same way round as the outline
  const hole = square(0.005).map(([lon, lat]) => [lon + 0.0025, lat + 0.0025]);
  near(core.waterKm2({ rings: [square(0.01), hole] }), 1.236 * 0.75, 0.01);
  // two separate areas add up
  near(core.waterKm2({ rings: [square(0.01), square(0.01, 1)] }), 2.472, 0.02);
});

test('a print KML keeps each area of water, its rings in full and its level, and leaves out its own outline', () => {
  const centre = { name: 'Boston', lat: 42.355, lon: -71.045 };
  const waters = [
    { name: 'Channel & basin', rings: [[[-71.0512345, 42.3512345], [-71.04, 42.35], [-71.04, 42.36]], [[-71.045, 42.352], [-71.042, 42.352], [-71.042, 42.355]]], levelMm: -0.6 },
    { name: 'Pond', rings: [[[-71.06, 42.35], [-71.055, 42.35], [-71.055, 42.355]]], levelMm: 1 },
  ];
  const set = { sideKm: 2, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 3, baseMm: 3, seaFloorM: 0, depthStretch: 3, shoreMm: 0, shoreRidge: false, label: false, labelText: '', balance: false, infillPercent: 15, cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: core.NO_ROADS, waterMm: core.NO_WATER, cols: 2, rows: 1, tracks: [], waters, bins: [], binClearMm: 0.4 };
  const text = core.printKml({ centre, set });
  assert.match(text, /<Style id="water">/);
  assert.match(text, /<Data name="waters">.*<value>2<\/value>/);
  assert.deepEqual(core.parsePrintKml(text).set, set);
  // imported, the file is its two areas of water, not the print's outline or pieces
  assert.deepEqual(core.parseWaterKml(text).map((w) => w.name), ['Channel & basin', 'Pond']);
  // a file from before water of your own has none
  const old = core.printKml({ centre, set: { ...set, waters: [] } }).replace(/\s*<Data name="waters">.*<\/Data>/, '');
  assert.deepEqual(core.parsePrintKml(old).set.waters, []);
  assert.throws(() => core.parsePrintKml(text.replace('<value>-0.6</value>', '<value>-40</value>')), /Channel/);
});

test('kmlWaterPoints finds each printed area on the grid, and leaves out one at 0', () => {
  const centre = { lat: 42.355, lon: -71.045 };
  const frame = core.printFrame(centre, 2, 100, 0);
  const n = 101, heights = new Array(n * n).fill(10);
  // a box over the middle third of the print
  const a = frame.toLonLat(33, 33), b = frame.toLonLat(67, 67);
  const rings = [[[a.lon, a.lat], [b.lon, a.lat], [b.lon, b.lat], [a.lon, b.lat]]];
  const found = core.kmlWaterPoints([{ rings, levelMm: 0 }, { rings, levelMm: -0.6 }], heights, n, 100, frame);
  assert.equal(found.length, 1);
  assert.equal(found[0].water, 1);
  assert.equal(found[0].levelMm, -0.6);
  assert.equal(found[0].points[50 * n + 50], 1);
  assert.equal(found[0].points[10 * n + 10], 0);
  near(found[0].points.reduce((s, v) => s + v, 0), 34 * 34, 2 * 35);
  // under sea level it is the sea's, as OpenStreetMap's water is
  const sea = core.kmlWaterPoints([{ rings, levelMm: -0.6 }], new Array(n * n).fill(-1), n, 100, frame);
  assert.equal(sea[0].points.reduce((s, v) => s + v, 0), 0);
});

// A flat 5 mm bank either side of a river sunk to 4.4 mm, running north to south down the middle.
function river(n, fromX, toX) {
  const zMm = new Array(n * n).fill(5), water = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = fromX; i <= toX; i++) { zMm[j * n + i] = 4.4; water[j * n + i] = 1; }
  }
  return { zMm, water };
}
const floorAt = (tris, x, tol = 0.01) => Math.min(...tris.filter((p) => Math.abs(p[0] - x) < tol).map((p) => p[2]));
const topAt = (tris, x, tol = 0.01) => Math.max(...tris.filter((p) => Math.abs(p[0] - x) < tol).map((p) => p[2]));

test('a road over sunk water is a level deck with the water open under it', () => {
  const n = 41, widthMm = 40;
  const { zMm, water } = river(n, 15, 25);
  const way = [{ cls: 'motorway', line: [[2, 20.2], [38, 20.2]] }];
  const opts = { widthMm, mmPerMetre: 0.001 };
  // without the water: a dam, its floor down in the river and its top dipping over it
  const dam = core.roadTriangles(way, zMm, n, opts);
  near(floorAt(dam, 20), 4.2, 1e-9);
  assert.ok(topAt(dam, 20) < 5 + 1.2 - 0.1, `the dam's top is ${topAt(dam, 20)}`);
  // with it: a bridge, its deck level with the banks' road and its floor the deck's thickness under it
  const bridge = core.roadTriangles(way, zMm, n, { ...opts, water });
  assert.ok(core.isClosed(bridge));
  near(topAt(bridge, 20), 6.2, 1e-9);
  near(floorAt(bridge, 20), 6.2 - core.BRIDGE_DECK_MM, 1e-9);
  // clear of the water under it
  assert.ok(floorAt(bridge, 20) > 4.4 + 1);
  // and on the bank, well clear of the river, the road is as it was
  near(floorAt(bridge, 5), 4.8, 1e-9);
  near(topAt(bridge, 5), 6.2, 1e-9);
});

test('a bridge runs straight from one bank to the other when they stand at different heights', () => {
  const n = 41, widthMm = 40;
  const { zMm, water } = river(n, 15, 25);
  for (let j = 0; j < n; j++) for (let i = 26; i < n; i++) zMm[j * n + i] = 7; // the east bank 2 mm higher
  const tris = core.roadTriangles([{ cls: 'primary', line: [[2, 20.2], [38, 20.2]] }], zMm, n, { widthMm, mmPerMetre: 0.001, water });
  assert.ok(core.isClosed(tris));
  const [west, mid, east] = [16, 20, 24].map((x) => topAt(tris, x));
  assert.ok(west < mid && mid < east, `${west}, ${mid}, ${east}`);
  near(mid - west, east - mid, 0.05);
});

test('a long crossing stands on piers no more than a span apart', () => {
  const n = 201, widthMm = 100; // half a mm a grid step
  const { zMm, water } = river(n, 22, 174); // 76 mm of water: four spans
  const tris = core.roadTriangles([{ cls: 'trunk', line: [[2, 50.1], [98, 50.1]] }], zMm, n, { widthMm, mmPerMetre: 0.001, water });
  assert.ok(core.isClosed(tris));
  // the floor along the road, sampled every half mm over the water: down at the piers, up under the deck between
  const down = [];
  for (let x = 12; x <= 86; x += 0.25) if (floorAt(tris, x, 0.13) < 5) down.push(x);
  const piers = down.filter((x, k) => !k || x - down[k - 1] > 2);
  assert.equal(piers.length, 3);
  const gaps = [piers[0] - 11, piers[1] - piers[0], piers[2] - piers[1], 87 - piers[2]];
  for (const g of gaps) assert.ok(g <= core.BRIDGE_SPAN_MM + 1, `a span of ${g} mm`);
  // a short crossing has none
  const short = river(41, 18, 22);
  const small = core.roadTriangles([{ cls: 'trunk', line: [[2, 20.2], [38, 20.2]] }], short.zMm, 41, { widthMm: 40, mmPerMetre: 0.001, water: short.water });
  assert.ok(floorAt(small, 20) > 5);
});

test('a bridge that runs off the print keeps its one bank\'s level', () => {
  const n = 41, widthMm = 40;
  const { zMm, water } = river(n, 20, 40);
  const tris = core.roadTriangles([{ cls: 'motorway', line: [[2, 20.2], [40, 20.2]] }], zMm, n, { widthMm, mmPerMetre: 0.001, water });
  assert.ok(core.isClosed(tris));
  near(topAt(tris, 35), 6.2, 1e-9);
  near(floorAt(tris, 35), 6.2 - core.BRIDGE_DECK_MM, 1e-9);
});
