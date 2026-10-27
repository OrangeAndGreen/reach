import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Bins cut down into the top, to stand things in.

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
const stlTris = (buf) => core.readStl(buf).flatMap((t) => t.v);

/** A square print with bins: the cells round them left open and binTriangles closing them. */
function squareWithBins(zMm, n, w, bins, { from = 'low', cornerMm = 0, ground = zMm } = {}) {
  const step = w / (n - 1);
  const rings = bins.map((b) => core.binRing(b, { origin: [w / 2, w / 2], step }));
  const fit = core.binCells(rings, n, w, { cornerMm });
  const placed = fit.placed.map((k) => ({ ring: rings[k], ...core.binFloor(rings[k], ground, n, w, bins[k].from || from, bins[k].depthMm) }));
  const extra = core.binTriangles(zMm, n, w, fit.cells, placed);
  return { fit, placed, tris: stlTris(core.terrainStl(zMm, n, w, extra, null, cornerMm, null, fit.cells)) };
}

const sd = { shape: 'rect', lengthMm: 10, widthMm: 5, depthMm: 4, x: 0, y: 0, turn: 0 };

test('a bin in flat ground takes out its own volume and leaves the print closed', () => {
  const n = 101, w = 50;
  const { fit, placed, tris } = squareWithBins(new Array(n * n).fill(10), n, w, [sd]);
  assert.deepEqual(fit.placed, [0]);
  near(placed[0].floorMm, 6, 1e-9);
  assert.ok(core.isClosed(tris));
  // 10.4 x 5.4 with the clearance, 4 deep
  near(volume(tris), 50 * 50 * 10 - 10.4 * 5.4 * 4, 0.05);
});

test('a turned bin and a round one, side by side, stay closed', () => {
  const n = 121, w = 60;
  const z = Array.from({ length: n * n }, (_, k) => 8 + 3 * Math.sin((k % n) / 9) + 2 * Math.cos(Math.floor(k / n) / 7));
  const bins = [
    { ...sd, x: -12, y: 5, turn: 33 },
    { shape: 'circle', lengthMm: 14.5, widthMm: 14.5, depthMm: 5, x: 12, y: -6, turn: 0 },
  ];
  const { fit, tris } = squareWithBins(z, n, w, bins);
  assert.deepEqual(fit.placed, [0, 1]);
  assert.ok(core.isClosed(tris));
  assert.ok(volume(tris) > 0);
});

test('an oval bin takes out an ellipse, turned, and leaves the print closed', () => {
  const n = 121, w = 60;
  const oval = { shape: 'oval', lengthMm: 30, widthMm: 12, depthMm: 5, x: 0, y: 0, turn: 40 };
  const { fit, tris } = squareWithBins(new Array(n * n).fill(10), n, w, [oval]);
  assert.deepEqual(fit.placed, [0]);
  assert.ok(core.isClosed(tris));
  // 30.4 x 12.4 with the clearance, 5 deep; the ring's chords lose a sliver
  near(volume(tris), 60 * 60 * 10 - Math.PI * 15.2 * 6.2 * 5, 3);
  const ring = core.binRing(oval, { origin: [0, 0], step: 1 });
  const far = Math.max(...ring.map(([x, y]) => Math.hypot(x, y))), close = Math.min(...ring.map(([x, y]) => Math.hypot(x, y)));
  near(far, 15.2, 1e-9);
  near(close, 6.2, 0.01);
});

test('two bins close enough to share the ground between them stay closed', () => {
  const n = 101, w = 50;
  const bins = [{ ...sd, y: -2 }, { ...sd, y: 4 }];
  const { fit, tris } = squareWithBins(new Array(n * n).fill(10), n, w, bins);
  assert.deepEqual(fit.placed, [0, 1]);
  assert.ok(core.isClosed(tris));
  near(volume(tris), 50 * 50 * 10 - 2 * 10.4 * 5.4 * 4, 0.05);
});

test('the depth is measured from the lowest, average or highest ground under the bin', () => {
  const n = 101, w = 50, step = w / (n - 1);
  // a slope rising 1 mm per mm eastward, from 10 at the centre
  const z = Array.from({ length: n * n }, (_, k) => 10 + (k % n) * step - w / 2);
  const ring = core.binRing({ ...sd, lengthMm: 9.4 }, { origin: [w / 2, w / 2], step }); // 9.8 mm across, 4.9 either side
  near(core.binFloor(ring, z, n, w, 'low', 4).floorMm, 10 - 4.9 - 4, 1e-9);
  near(core.binFloor(ring, z, n, w, 'mid', 4).floorMm, 10 - 4, 1e-9);
  near(core.binFloor(ring, z, n, w, 'high', 4).floorMm, 10 + 4.9 - 4, 1e-9);
  assert.equal(core.binFloor(ring, z, n, w, 'low', 4).open, false);
  // from the highest ground, 4 deep on a 10 mm rise, the low side is open
  assert.equal(core.binFloor(ring, z, n, w, 'high', 4).open, true);
});

test('a bin open on its low side still makes a closed print', () => {
  const n = 101, w = 50, step = w / (n - 1);
  const z = Array.from({ length: n * n }, (_, k) => 30 + (k % n) * step - w / 2);
  const { placed, tris } = squareWithBins(z, n, w, [{ ...sd, from: 'high' }]);
  assert.equal(placed[0].open, true);
  assert.ok(core.isClosed(tris));
  assert.ok(volume(tris) > 0);
});

test('bins too near the edge, in a rounded corner or over another are left out', () => {
  const n = 101, w = 50, step = w / (n - 1);
  const rings = [
    { ...sd },
    { ...sd, x: 1 }, // over the first
    { ...sd, x: 20 }, // its end 0.2 mm from the edge
    { ...sd, x: -15, y: -18 }, // in the south-west corner
  ].map((b) => core.binRing(b, { origin: [w / 2, w / 2], step }));
  const fit = core.binCells(rings, n, w, { cornerMm: 5 });
  assert.deepEqual(fit.placed, [0]);
  assert.deepEqual(fit.left, [{ index: 1, why: 'overlap', other: 0 }, { index: 2, why: 'edge' }, { index: 3, why: 'corner' }]);
  // without the rounding, the corner one fits
  assert.deepEqual(core.binCells([rings[3]], n, w).placed, [0]);
});

test('a shaped print with a bin stays closed', () => {
  const n = 121, w = 60;
  const outline = core.shapeOutline('hexagon', w, { cornerMm: 3 });
  const cut = core.shapeCells(outline.ring, n, w);
  const z = Array.from({ length: n * n }, (_, k) => 6 + 2 * Math.sin((k % n) / 11));
  const ring = core.binRing({ shape: 'circle', lengthMm: 18.5, depthMm: 5, x: 0, y: 0 }, { origin: [w / 2, w / 2], step: w / (n - 1) });
  const fit = core.binCells([ring], n, w, { base: cut.cells });
  assert.deepEqual(fit.placed, [0]);
  const extra = core.binTriangles(z, n, w, fit.cells, [{ ring, ...core.binFloor(ring, z, n, w, 'low', 5) }]);
  const { tris } = core.shapeMesh(z, cut, extra, null, fit.cells);
  assert.ok(core.isClosed(tris));
  // a bin past the hexagon's flat side is too near its edge
  const out = core.binRing({ ...sd, y: 25 }, { origin: [w / 2, w / 2], step: w / (n - 1) });
  assert.deepEqual(core.binCells([out], n, w, { base: cut.cells }).left, [{ index: 0, why: 'edge' }]);
});

test('roads through a bin are cut short of it, and buildings on it left out', () => {
  const ring = [[10, 10], [20, 10], [20, 20], [10, 20]];
  const ways = core.linesClearOf([{ cls: 'primary', line: [[0, 15], [30, 15]] }, { cls: 'motorway', line: [[0, 0], [30, 0]] }], [ring], 1);
  assert.equal(ways.length, 3);
  assert.deepEqual(ways.map((w) => w.cls), ['primary', 'primary', 'motorway']);
  assert.deepEqual(ways[0].line, [[0, 15], [10, 15]]);
  assert.deepEqual(ways[1].line, [[20, 15], [30, 15]]);
  // a line that bends inside keeps its outside parts
  const bent = core.linesClearOf([{ line: [[0, 12], [15, 12], [15, 30]] }], [ring]);
  assert.deepEqual(bent.map((w) => w.line), [[[0, 12], [10, 12]], [[15, 20], [15, 30]]]);
  const box = (x, y) => ({ rings: [[[x, y], [x + 2, y], [x + 2, y + 2], [x, y + 2]]] });
  assert.equal(core.buildingsClearOf([box(14, 14), box(30, 30), box(19, 5)], [ring]).length, 2);
});

test('a print KML keeps each bin, as a pin at its centre', () => {
  const centre = { name: 'Mount Washington', lat: 44.2706, lon: -71.3033 };
  const bins = [
    { name: 'SD card <1>', shape: 'rect', lengthMm: 24, widthMm: 2.1, depthMm: 16, from: 'low', x: -20.5, y: 10, turn: 15 },
    { name: 'AA battery', shape: 'circle', lengthMm: 14.5, widthMm: 14.5, depthMm: 25, from: 'mid', x: 0, y: 0, turn: 0 },
    { name: 'Drone battery', shape: 'oval', lengthMm: 40, widthMm: 22, depthMm: 15, from: 'high', x: 25, y: -20, turn: -30 },
  ];
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1.5, baseMm: 3, seaFloorM: 0, depthStretch: 1.5, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: core.NO_ROADS, waterMm: core.NO_WATER, cols: 1, rows: 1, tracks: [], bins, binClearMm: 0.3 };
  const model = { zoom: 12, pixelM: 27.8, lowM: 410, highM: 1916, reliefMm: 13.55, triangles: 81590, binRaiseMm: 2 };
  const text = core.printKml({ centre, set, model });
  assert.match(text, /<Data name="bins">.*<value>3<\/value>/);
  assert.match(text, /<Data name="modelHeightMm">.*<value>18.55<\/value>/);
  assert.match(text, /<name>Bin: AA battery<\/name>.*<coordinates>-71.3033,44.2706,0<\/coordinates>/);
  assert.deepEqual(core.parsePrintKml(text).set, set);
  assert.equal(core.parseTrackKml(text).length, 0);
  // a file from before bins has none
  const old = text.replace(/\s*<Placemark><name>Bin:.*<\/Placemark>/g, '').replace(/\s*<Data name="binClearanceMm">.*<\/Data>/, '');
  assert.deepEqual(core.parsePrintKml(old).set.bins, []);
  assert.equal(core.parsePrintKml(old).set.binClearMm, core.BIN_CLEARANCE_MM);
  assert.throws(() => core.parsePrintKml(text.replace('<value>circle</value>', '<value>star</value>')), /AA battery/);
});
