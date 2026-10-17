import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Shaped and turned prints.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const ringAreaMm2 = (ring) => Math.abs(core.ringArea2(ring)) / 2;

/** The volume a closed mesh holds, by the divergence theorem: negative if it is inside out. */
const volume = (tris) => {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
};

test('a turned frame puts the model top on the bearing, and comes back', () => {
  const centre = { lat: 40.78, lon: -73.97 };
  const f = core.printFrame(centre, 4, 120, 29);
  const top = f.toLonLat(60, 120); // the middle of the top edge, 2 km from the centre
  near(core.haversineKm(centre, top), 2, 0.01);
  const deg = core.kmPerDegree(centre.lat);
  near((Math.atan2((top.lon - centre.lon) * deg.lon, (top.lat - centre.lat) * deg.lat) * 180) / Math.PI, 29, 1e-6);
  const [x, y] = f.toMm(top.lon, top.lat);
  near(x, 60, 1e-6);
  near(y, 120, 1e-6);
  // north up, it is squareBounds
  const flat = core.printFrame(centre, 4, 120).bounds, square = core.squareBounds(centre, 4);
  for (const k of ['west', 'east', 'south', 'north']) near(flat[k], square[k], 1e-9);
  // turned, the box grows to hold the corners
  assert.ok(f.bounds.north > square.north && f.bounds.east > square.east);
});

test('shape outlines are centred, counter-clockwise and the right size', () => {
  const w = 120;
  for (const shape of core.PRINT_SHAPES) {
    const { ring, pieces } = core.shapeOutline(shape, w, { aspect: 3 });
    assert.ok(core.ringArea2(ring) > 0, `${shape} runs clockwise`);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    assert.ok(Math.min(...xs) >= -1e-9 && Math.max(...xs) <= w + 1e-9 && Math.min(...ys) >= -1e-9 && Math.max(...ys) <= w + 1e-9, shape);
    near((Math.min(...xs) + Math.max(...xs)) / 2, w / 2, 1e-9);
    near(pieces.reduce((a, p) => a + ringAreaMm2(p), 0), ringAreaMm2(ring), 1e-6);
    for (const p of pieces) assert.ok(core.ringArea2(p) > 0, `a piece of the ${shape} runs clockwise`);
  }
  near(ringAreaMm2(core.shapeOutline('circle', w).ring), Math.PI * 60 * 60, 1);
  near(ringAreaMm2(core.shapeOutline('rectangle', w, { aspect: 5 }).ring), (w * w) / 5, 1e-6);
  near(ringAreaMm2(core.shapeOutline('triangle', w).ring), (Math.sqrt(3) / 4) * w * w, 1e-6);
  near(ringAreaMm2(core.shapeOutline('hexagon', w).ring), ((3 * Math.sqrt(3)) / 2) * 60 * 60, 1e-6);
  // rounding cuts a square's corners by (4 - pi) r², and leaves a circle alone
  near(ringAreaMm2(core.shapeOutline('rectangle', w, { aspect: 1, cornerMm: 10 }).ring), w * w - (4 - Math.PI) * 100, 1);
  assert.equal(core.shapeOutline('circle', w, { cornerMm: 10 }).ring.length, 720);
  // a star's points round, its five inner corners stay sharp
  const star = core.shapeOutline('star', w, { cornerMm: 5 }).ring;
  assert.equal(star.filter((p) => Math.abs(Math.hypot(p[0] - 60, p[1] - 60) - 30) < 1e-9).length, 5);
  assert.ok(star.every((p) => Math.hypot(p[0] - 60, p[1] - 60) < 60 - 1));
});

test('every shape prints as one closed solid, as big as the shape times its height', () => {
  const n = 61, w = 120;
  for (const shape of core.PRINT_SHAPES.slice(1)) {
    for (const cornerMm of [0, 5]) {
      const outline = core.shapeOutline(shape, w, { aspect: 5, cornerMm });
      const grid = core.shapeCells(outline.ring, n, w);
      const { tris, top } = core.shapeMesh(new Array(n * n).fill(4), grid);
      assert.ok(core.isClosed(tris), `${shape} at ${cornerMm} mm is open`);
      near(volume(tris), ringAreaMm2(grid.ring) * 4, 1e-3);
      // the top comes first
      for (let t = 0; t < top * 3; t++) near(tris[t][2], 4, 1e-9);
      // and ground that isn't flat still closes
      const bumpy = Array.from({ length: n * n }, (_, k) => 3 + (k % 7) * 0.4 + Math.floor(k / n) * 0.05);
      const rough = core.shapeMesh(bumpy, grid).tris;
      assert.ok(core.isClosed(rough), `bumpy ${shape} is open`);
      assert.ok(volume(rough) > ringAreaMm2(grid.ring) * 3);
    }
  }
});

test('a fine grid closes too, and its STL reads back', () => {
  const n = 200, w = 120;
  const outline = core.shapeOutline('circle', w);
  const grid = core.shapeCells(outline.ring, n, w);
  const { tris } = core.shapeMesh(Array.from({ length: n * n }, (_, k) => 3 + Math.sin(k / 50)), grid);
  assert.ok(core.isClosed(tris));
  assert.equal(core.readStl(core.writeStl(tris)).length, tris.length / 3);
});

test('shape cells keep clear of the outline and mark the points the print reads', () => {
  const n = 41, w = 120, step = w / (n - 1), m = n - 1;
  const { ring } = core.shapeOutline('triangle', w);
  const grid = core.shapeCells(ring, n, w);
  let count = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (!grid.cells[j * m + i]) continue;
      count++;
      const mid = [(i + 0.5) * step, (m - j - 0.5) * step];
      assert.ok(core.inRing(mid, ring));
      assert.ok(core.distanceToRing(mid, ring) > step * (0.75 + Math.SQRT1_2) - 1e-9);
    }
  }
  assert.ok(count > 0.6 * m * m * (Math.sqrt(3) / 4));
  // the square's corners, outside the triangle, are not read
  assert.equal(grid.used[0], 0);
  assert.equal(grid.used[n * n - 1], 0);
  assert.equal(grid.used[Math.floor(n / 2) * n + Math.floor(n / 2)], 1);
  // so a low point out there doesn't set the base
  const heights = new Array(n * n).fill(100);
  heights[0] = -50;
  assert.equal(core.printHeights(heights, { sideKm: 10, widthMm: w }, grid.used).lowM, 100);
});

test('a labelled shape is still closed, its label inside the outline', () => {
  const n = 61, w = 120;
  const zMm = new Array(n * n).fill(3);
  const lines = ['40.7812°N 73.9665°W', '4 × 0.8 KM', 'VERTICAL ×3', 'TOP FACES 29°'];
  for (const shape of ['circle', 'hexagon', 'triangle', 'star', 'rectangle']) {
    const outline = core.shapeOutline(shape, w, { aspect: 2, cornerMm: 5 });
    const lab = core.bottomLabel(lines, zMm, n, w, outline);
    assert.ok(!lab.why, `${shape}: ${lab.why}`);
    const hw = (lab.w / 2) * lab.cellMm, hh = (lab.h / 2) * lab.cellMm;
    for (const p of [[lab.mid - hw, lab.midY - hh], [lab.mid + hw, lab.midY + hh], [lab.mid - hw, lab.midY + hh], [lab.mid + hw, lab.midY - hh]]) {
      assert.ok(core.inRing(p, outline.ring), shape);
    }
    const { tris } = core.shapeMesh(zMm, core.shapeCells(outline.ring, n, w), [], lab);
    assert.ok(core.isClosed(tris), `labelled ${shape} is open`);
  }
  // a 5:1 strip 80 mm long is too narrow for letters that print
  assert.match(core.bottomLabel(lines, zMm, n, 80, core.shapeOutline('rectangle', 80, { aspect: 5 })).why, /too small/);
});

test('the label names the shape and the turn', () => {
  const centre = { lat: 40.7812, lon: -73.9665 };
  const set = { sideKm: 4, exaggeration: 3, seaFloorM: 0, depthStretch: 3, label: true };
  assert.deepEqual(core.labelLines(centre, { ...set, shape: 'rectangle', aspect: 5, bearing: 29 }).lines.slice(1), ['4 × 0.8 KM', 'VERTICAL ×3', 'TOP FACES 29°']);
  assert.equal(core.labelLines(centre, { ...set, shape: 'circle' }).lines[1], '4 KM CIRCLE');
  assert.equal(core.labelLines(centre, { ...set, bearing: -29 }).lines.at(-1), 'TOP FACES 331°');
});

test('buildings are cut to the shape, and to each point of a star', () => {
  const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
  const way = (pts) => ({ type: 'way', tags: { building: 'yes' }, geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
  // a block across the whole middle of the model, west to east
  const osm = { elements: [way([[0, 0.004], [0.01, 0.004], [0.01, 0.006], [0, 0.006], [0, 0.004]])] };
  const circle = core.shapeOutline('circle', 100);
  const [fp] = core.buildingFootprints(osm, bounds, 100, { pieces: circle.pieces });
  assert.ok(fp.rings[0].every((p) => Math.hypot(p[0] - 50, p[1] - 50) <= 50 + 1e-9));
  const star = core.shapeOutline('star', 100);
  const parts = core.buildingFootprints(osm, bounds, 100, { pieces: star.pieces });
  assert.ok(parts.length >= 2);
  const total = parts.reduce((a, p) => a + ringAreaMm2(p.rings[0]), 0);
  assert.ok(total < 100 * 20 * 0.9);
  for (const p of parts) for (const q of p.rings[0]) assert.ok(core.inRing(q, star.ring) || core.distanceToRing(q, star.ring) < 1e-6);
  // a frame turned a quarter places them by its own mm: the east-west block runs up and down the model
  const frame = core.printFrame({ lat: 0.005, lon: 0.005 }, 1.112, 100, 90);
  const [turned] = core.buildingFootprints(osm, frame.bounds, 100, { frame });
  const xs = turned.rings[0].map((p) => p[0]), ys = turned.rings[0].map((p) => p[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 30 && Math.max(...ys) - Math.min(...ys) > 90);
});

test('a print KML keeps the shape and the turn, and older files are squares, north up', () => {
  const set = { sideKm: 4, widthMm: 120, cells: 200, exaggeration: 3, baseMm: 3, shape: 'star', aspect: 2, bearing: -15 };
  const kml = core.printKml({ centre: { name: 'a', lat: 40.78, lon: -73.97 }, set });
  const back = core.parsePrintKml(kml).set;
  assert.equal(back.shape, 'star');
  assert.equal(back.bearing, -15);
  const old = kml.replace(/\s*<Data name="(shape|aspect|bearingDeg)">.*?<\/Data>/g, '');
  assert.equal(core.parsePrintKml(old).set.shape, 'square');
  assert.equal(core.parsePrintKml(old).set.bearing, 0);
  assert.throws(() => core.parsePrintKml(kml.replace('<value>star</value>', '<value>blob</value>')), /shape "blob"/);
});

/** Where an ink grid's inked cells sit on average, as [column, row]. */
const inkMiddle = (ink, rows = ink.length) => {
  let sc = 0, sr = 0, count = 0;
  for (let r = 0; r < rows; r++) ink[r].forEach((v, c) => { if (v) { sc += c + 0.5; sr += r + 0.5; count++; } });
  return [sc / count, sr / count];
};

test('the north arrow points the way it is asked, with no cells meeting only at a corner', () => {
  const size = 28;
  for (const deg of [0, 29, 45, 90, -60, 180]) {
    const ink = core.arrowInk(deg, size);
    // the head is the heavy end, so the ink leans toward the tip
    const [c, r] = inkMiddle(ink);
    const lean = Math.atan2(c - size / 2, size / 2 - r) * 180 / Math.PI;
    near(((lean - deg + 540) % 360) - 180, 0, 12);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const [a, b, d, e] = [ink[y][x], ink[y][x + 1], ink[y + 1][x], ink[y + 1][x + 1]];
        assert.ok(!((a && e && !b && !d) || (b && d && !a && !e)), `${deg}°: a pinch at ${x}, ${y}`);
      }
    }
  }
});

test('on the print the arrow points north: up on a north-up print, west of the top when it faces east', () => {
  const n = 61, w = 120;
  const zMm = new Array(n * n).fill(3);
  const lines = ['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'];
  // the arrow's lean in model mm, from above: the average of its cells against its box's middle
  const lean = (north) => {
    const lab = core.bottomLabel(lines, zMm, n, w, null, north);
    const ink = core.labelInk(lab.lines, north);
    const pad = (lab.w - ink.w) / 2;
    // the arrow's box: centred across with the N beside it, at the top
    const left = pad + Math.floor((ink.w - (28 + 8 + core.textInk(['N']).w)) / 2), top = pad;
    const box = lab.ink.slice(top, top + 28).map((row) => row.slice(left, left + 28));
    const [c, r] = inkMiddle(box);
    // label cell column c lies at x = mid + (w/2 - c) cellMm: mirrored across, the right way up
    return [-(c - 14) * lab.cellMm, -(r - 14) * lab.cellMm];
  };
  const [x0, y0] = lean(0);
  assert.ok(y0 > 0.3 && Math.abs(x0) < 0.2, `north-up arrow leans ${x0}, ${y0}`);
  const [x90, y90] = lean(90);
  assert.ok(x90 < -0.3 && Math.abs(y90) < 0.2, `east-facing arrow leans ${x90}, ${y90}`);
});

test('a label with its north arrow still closes, square or shaped', () => {
  const n = 61, w = 120;
  const zMm = new Array(n * n).fill(3);
  const lines = ['40.7812°N 73.9665°W', '4 × 0.8 KM', 'VERTICAL ×3', 'TOP FACES 29°'];
  const square = core.bottomLabel(lines, zMm, n, w, null, 29);
  assert.ok(!square.why);
  const tris = core.readStl(core.terrainStl(zMm, n, w, [], square, 5)).map((t) => t.v);
  assert.ok(core.isClosed(tris.flat().map((p) => p.map((v) => +v.toFixed(4)))));
  for (const shape of ['circle', 'hexagon', 'triangle', 'star', 'rectangle']) {
    const outline = core.shapeOutline(shape, w, { aspect: 2, cornerMm: 5 });
    const lab = core.bottomLabel(lines, zMm, n, w, outline, 29);
    assert.ok(!lab.why, `${shape}: ${lab.why}`);
    assert.ok(core.isClosed(core.shapeMesh(zMm, core.shapeCells(outline.ring, n, w), [], lab).tris), `${shape} with an arrow is open`);
  }
});
