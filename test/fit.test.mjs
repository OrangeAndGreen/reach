import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Fitting the print to the imported tracks.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

/** Whether every point lies inside the fitted print's outline, as the app draws it. */
function inside(fit, points, opts) {
  const frame = core.printFrame(fit.centre, fit.sideKm, opts.widthMm, opts.bearing || 0);
  const { pieces } = core.shapeOutline(opts.shape, opts.widthMm, { aspect: opts.aspect, cornerMm: opts.cornerMm || 0 });
  return points.every(([lon, lat]) => {
    const [x, y] = frame.toMm(fit.centre.lon + ((((lon - fit.centre.lon) % 360) + 540) % 360) - 180, lat);
    return pieces.some((ring) => core.inRing([x, y], ring));
  });
}

test('ceilSideKm rounds up to the drag steps, and leaves an exact step alone', () => {
  assert.equal(core.ceilSideKm(0.123), 0.13);
  assert.equal(core.ceilSideKm(0.13), 0.13);
  assert.equal(core.ceilSideKm(3.21), 3.3);
  assert.equal(core.ceilSideKm(3.3), 3.3);
  assert.equal(core.ceilSideKm(12.01), 13);
  assert.equal(core.ceilSideKm(0.1 + 0.2), 0.3);
});

test('trackPoints takes every point of tracks and of water rings', () => {
  const pts = core.trackPoints([
    { lines: [[[1, 2], [3, 4]], [[5, 6]]] },
    { rings: [[[7, 8], [9, 10], [11, 12]]] },
  ]);
  assert.deepEqual(pts, [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]);
});

test('fitPrint is null with nothing to fit', () => {
  assert.equal(core.fitPrint([]), null);
});

test('fitPrint centres a square on the tracks and sizes it to the wider span plus the margin', () => {
  // about 8 km east-west and 4.4 km north-south at 44 degrees
  const pts = [[-71.35, 44.25], [-71.25, 44.27], [-71.30, 44.29]];
  const opts = { shape: 'square', widthMm: 120 };
  const fit = core.fitPrint(pts, opts);
  near(fit.centre.lon, -71.30, 1e-6);
  near(fit.centre.lat, 44.27, 1e-6);
  const spanKm = 0.1 * core.kmPerDegree(44.27).lon;
  near(fit.needKm, spanKm * (1 + 2 * core.FIT_MARGIN), 1e-6);
  assert.equal(fit.sideKm, core.ceilSideKm(fit.needKm));
  assert.equal(fit.clamped, false);
  assert.ok(inside(fit, pts, opts));
  // a step smaller would not hold them with the margin
  assert.ok(fit.sideKm - 0.1 < fit.needKm);
});

test('fitPrint holds the tracks in a turned square, a rectangle, a circle and a star', () => {
  const pts = [[-71.35, 44.25], [-71.25, 44.27], [-71.30, 44.29], [-71.28, 44.24]];
  for (const opts of [
    { shape: 'square', widthMm: 120, bearing: 30 },
    { shape: 'rectangle', widthMm: 180, aspect: 3 },
    { shape: 'rectangle', widthMm: 180, aspect: 1.5, bearing: 90, cornerMm: 8 },
    { shape: 'circle', widthMm: 120 },
    { shape: 'hexagon', widthMm: 120, cornerMm: 5 },
    { shape: 'triangle', widthMm: 120 },
    { shape: 'star', widthMm: 120 },
  ]) {
    const fit = core.fitPrint(pts, opts);
    assert.ok(inside(fit, pts, opts), `${opts.shape} holds the tracks`);
    // and without the margin, a bit smaller, they would not all fit
    const tight = core.fitPrint(pts, { ...opts, margin: 0 });
    assert.ok(!inside({ ...tight, sideKm: tight.needKm * 0.98 }, pts, opts), `${opts.shape} is no bigger than it needs`);
  }
  // a rectangle three times as wide as tall has to be wider than a square for the same north-south span
  const tall = [[-71.3, 44.2], [-71.3, 44.3]];
  const sq = core.fitPrint(tall, { shape: 'square', widthMm: 120 });
  const rect = core.fitPrint(tall, { shape: 'rectangle', widthMm: 120, aspect: 3 });
  near(rect.needKm, sq.needKm * 3, 1e-6);
});

test('fitPrint takes the short way across the antimeridian', () => {
  // Taveuni, Fiji: a track either side of 180
  const pts = [[179.9, -16.8], [-179.9, -16.9], [179.95, -16.85]];
  const fit = core.fitPrint(pts, { shape: 'square', widthMm: 120 });
  near(Math.abs(fit.centre.lon), 180, 1e-6);
  near(fit.centre.lat, -16.85, 1e-6);
  // 0.2 degrees across, not 359.8
  const spanKm = 0.2 * core.kmPerDegree(-16.85).lon;
  near(fit.needKm, spanKm * (1 + 2 * core.FIT_MARGIN), 1e-3);
  assert.equal(fit.clamped, false);
  assert.ok(inside(fit, pts, { shape: 'square', widthMm: 120 }));
  // a centre just off the line lands either side, within -180 to 180
  const off = core.fitPrint([[179.8, 0], [-179.9, 0]], { shape: 'square', widthMm: 120 });
  near(off.centre.lon, 179.95, 1e-6);
});

test('fitPrint clamps tracks bigger than the largest print, and says so', () => {
  const pts = [[-76, 39], [-70, 44]]; // about 510 km by 555 km, over 500 even without the margin
  const fit = core.fitPrint(pts, { shape: 'square', widthMm: 120 });
  assert.equal(fit.sideKm, core.SIDE_MAX_KM);
  assert.equal(fit.clamped, true);
  assert.ok(fit.needKm > core.SIDE_MAX_KM);
  near(fit.centre.lon, -73, 0.05);
  near(fit.centre.lat, 41.5, 0.05);
});

test('fitPrint gives a single point the smallest print', () => {
  const fit = core.fitPrint([[10, 50], [10, 50]], { shape: 'square', widthMm: 120 });
  assert.equal(fit.sideKm, core.SIDE_MIN_KM);
  assert.equal(fit.clamped, false);
  assert.deepEqual(fit.centre, { lat: 50, lon: 10 });
});
