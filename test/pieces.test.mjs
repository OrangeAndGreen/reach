import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Prints split into pieces that sit edge to edge.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const centre = { name: 'Mount Washington', lat: 44.2706, lon: -71.3033 };

test('pieces are named from the top left and know their outside corners', () => {
  const plan = core.piecePlan(centre, { sideKm: 30, widthMm: 100, cols: 3, rows: 2, bearing: 0 });
  assert.deepEqual(plan.pieces.map((p) => p.name), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(plan.acrossMm, 300);
  assert.equal(plan.downMm, 200);
  assert.equal(plan.pieceKm, 10);
  const corners = Object.fromEntries(plan.pieces.map((p) => [p.name, p.corners]));
  assert.deepEqual(corners.A1, [false, false, false, true]); // north-west
  assert.deepEqual(corners.A2, [false, false, false, false]);
  assert.deepEqual(corners.B3, [false, true, false, false]); // south-east
  // A1 is north-west of the centre, B3 south-east
  assert.ok(plan.pieces[0].centre.lat > centre.lat && plan.pieces[0].centre.lon < centre.lon);
  assert.ok(plan.pieces[5].centre.lat < centre.lat && plan.pieces[5].centre.lon > centre.lon);
});

test('two pieces read a side they share as the same ground, turned or not', () => {
  for (const bearing of [0, 29, -75]) {
    const plan = core.piecePlan(centre, { sideKm: 60, widthMm: 250, cols: 2, rows: 2, bearing });
    const [a1, a2, b1] = plan.pieces;
    for (const t of [0, 0.37, 1]) {
      // A1's east side is A2's west side; A1's south side is B1's north side
      assert.deepEqual(a1.frame.toLonLat(250, t * 250), a2.frame.toLonLat(0, t * 250));
      assert.deepEqual(a1.frame.toLonLat(t * 250, 0), b1.frame.toLonLat(t * 250, 250));
    }
    const [x, y] = a2.frame.toMm(a1.frame.toLonLat(250, 100).lon, a1.frame.toLonLat(250, 100).lat);
    near(x, 0, 1e-6);
    near(y, 100, 1e-6);
  }
});

test('one piece is the print as it always was', () => {
  const set = { sideKm: 20, widthMm: 120, bearing: 17 };
  const [only] = core.piecePlan(centre, set).pieces;
  const frame = core.printFrame(centre, 20, 120, 17);
  assert.deepEqual(only.frame.toLonLat(33, 101), frame.toLonLat(33, 101));
  assert.deepEqual(only.frame.bounds, frame.bounds);
  assert.deepEqual(only.corners, [true, true, true, true]);
});

test('pieces scaled from a shared lowest point meet at the same height', () => {
  const set = { sideKm: 10, widthMm: 100, exaggeration: 2, baseMm: 3 };
  const slope = [400, 600, 800, 1000], peak = [1000, 1200, 1500, 1100];
  // on their own, the two sides of the seam (1000 m) sit at different heights
  assert.notEqual(core.printHeights(slope, set).toMm(1000), core.printHeights(peak, set).toMm(1000));
  const lowM = Math.min(core.printHeights(slope, set).lowM, core.printHeights(peak, set).lowM);
  const a = core.printHeights(slope, { ...set, lowM }), b = core.printHeights(peak, { ...set, lowM });
  assert.equal(a.toMm(1000), b.toMm(1000));
  assert.equal(b.mm[0], a.mm[3]);
  assert.equal(b.mm.reduce((m, v) => Math.min(m, v)), 3 + 600 * 0.01 * 2); // the peak piece stands on a thicker base
  assert.equal(b.lowM, 400);
  assert.equal(b.highM, 1500);
});

test('rounding only some corners keeps the others square and the mesh closed', () => {
  const r = 5, w = 50;
  assert.deepEqual(core.roundCorner([0, 0, 1], w, r, [false, false, true, false]), [0, 0, 1]);
  assert.notDeepEqual(core.roundCorner([w, w, 1], w, r, [false, false, true, false]), [w, w, 1]);
  assert.notDeepEqual(core.roundCorner([0, 0, 1], w, r), [0, 0, 1]);
  const n = 21;
  const tris = core.readStl(core.terrainStl(new Array(n * n).fill(4), n, w, [], null, r, [false, false, false, true]));
  const xy = tris.flatMap((t) => t.v);
  // the north-west corner is cut, the other three are still there
  assert.ok(!xy.some(([x, y]) => x === 0 && y === w));
  for (const [cx, cy] of [[0, 0], [w, 0], [w, w]]) assert.ok(xy.some(([x, y]) => x === cx && y === cy));
  const edges = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const key = [t.v[k], t.v[(k + 1) % 3]].map((p) => p.join(',')).sort().join('|');
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((c) => c === 2));
});

test("a piece's label says where it goes, before the rest", () => {
  const set = { sideKm: 20, widthMm: 120, cols: 2, rows: 1, exaggeration: 2, label: true, labelText: 'Presidentials', shape: 'square' };
  const { lines, wrap } = core.labelLines(centre, set, 'A2');
  assert.equal(lines[0], 'A2 OF 2 × 1');
  assert.equal(lines[1], 'PRESIDENTIALS');
  assert.equal(lines[wrap], '44.2706°N 71.3033°W');
  assert.ok(lines.includes('20 × 10 KM'));
  assert.deepEqual(core.labelLines(centre, { ...set, label: false, labelText: '' }, 'B1').lines, ['B1 OF 2 × 1']);
});

test('a print KML keeps its pieces and outlines the whole set', () => {
  const set = { sideKm: 40, widthMm: 250, cells: 626, pitchMm: 0.4, exaggeration: 2, baseMm: 3, seaFloorM: 0, depthStretch: 2, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: core.NO_ROADS, waterMm: core.NO_WATER, cols: 2, rows: 1, tracks: [] };
  const kml = core.printKml({ centre, set });
  assert.match(kml, /<Data name="mapScale">.*<value>1:80000<\/value>/);
  assert.match(kml, /2 × 1 pieces of 250 mm/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
  // the outline is 40 km across and 20 km down
  const coords = kml.match(/<coordinates>([^<]+)<\/coordinates>/)[1].trim().split(' ').map((c) => c.split(',').map(Number));
  assert.equal(coords.length, 5);
  const [sw, se, ne] = coords.map(([lon, lat]) => ({ lon, lat }));
  near(core.haversineKm(sw, se), 40, 0.1);
  near(core.haversineKm(se, ne), 20, 0.1);
  // older files are one piece
  const old = kml.replace(/<Data name="pieces(Across|Down)">[\s\S]*?<\/Data>/g, '');
  assert.equal(core.parsePrintKml(old).set.cols, 1);
  assert.equal(core.parsePrintKml(old).set.rows, 1);
  assert.throws(() => core.parsePrintKml(kml.replace(/(name="piecesAcross">.*?<value>)2/, '$19')), /piecesAcross/);
});

test('crc32 matches the standard check value', () => {
  assert.equal(core.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(core.crc32(new Uint8Array(0)), 0);
});

test('a zip holds each file whole, where its directory says', () => {
  const files = [
    { name: 'reach-a1.stl', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'reach-b2.stl', data: new TextEncoder().encode('solid terrain') },
  ];
  const zip = core.zipFiles(files, new Date(2026, 9, 19, 14, 30, 10));
  const v = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  let at = v.getUint32(end + 16, true);
  for (const f of files) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const nameLen = v.getUint16(at + 28, true);
    assert.equal(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen)), f.name);
    assert.equal(v.getUint32(at + 16, true), core.crc32(f.data));
    const local = v.getUint32(at + 42, true);
    assert.equal(v.getUint32(local, true), 0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true);
    assert.deepEqual(zip.subarray(start, start + v.getUint32(local + 22, true)), f.data);
    at += 46 + nameLen;
  }
});

test('a resampled grid keeps a plane, its corners, and the side it shares', () => {
  const n = 11;
  const plane = Array.from({ length: n * n }, (_, k) => 3 + 2 * (k % n) - 0.5 * Math.floor(k / n));
  const m = 4, out = core.resampleGrid(plane, n, m);
  assert.equal(out.length, m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) near(out[j * m + i], 3 + 2 * (i * 10 / 3) - 0.5 * (j * 10 / 3), 1e-9);
  // two grids with the same east and west columns resample them alike
  const bumpy = Array.from({ length: n * n }, (_, k) => Math.sin(k * 1.7) * 100);
  const other = bumpy.map((v, k) => (k % n === 0 || k % n === n - 1 ? v : -v));
  const [ra, rb] = [bumpy, other].map((g) => core.resampleGrid(g, n, 6));
  for (let j = 0; j < 6; j++) {
    assert.equal(ra[j * 6], rb[j * 6]);
    assert.equal(ra[j * 6 + 5], rb[j * 6 + 5]);
  }
  assert.equal(core.resampleGrid(plane, n, n), plane);
});

test('a KML of pieces outlines each one, and keeps the centre to the last digit', () => {
  const exact = { name: 'Somewhere', lat: 44.27063418529731, lon: -71.30331937210984 };
  const set = { sideKm: 30, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 2, baseMm: 3, cols: 3, rows: 2, tracks: [] };
  const kml = core.printKml({ centre: exact, set });
  const names = [...kml.matchAll(/<Placemark><name>(Piece [A-C]\d)<\/name>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Piece A1', 'Piece A2', 'Piece A3', 'Piece B1', 'Piece B2', 'Piece B3']);
  assert.equal((kml.match(/<Placemark/g) || []).length, 8);
  // A1's north-west corner is the set's
  const a1 = kml.match(/<name>Piece A1<\/name>[\s\S]*?<coordinates>([^<]+)</)[1].trim().split(' ');
  const nw = core.piecePlan(exact, set).pieces[0].frame.toLonLat(0, 120);
  assert.equal(a1[3], `${nw.lon.toFixed(5)},${nw.lat.toFixed(5)},0`);
  assert.deepEqual(core.parsePrintKml(kml).centre, exact);
  // one piece has no piece outlines
  assert.doesNotMatch(core.printKml({ centre: exact, set: { ...set, cols: 1, rows: 1 } }), /<name>Piece /);
});
