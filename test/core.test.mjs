import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

const boston = { lat: 42.3601, lon: -71.0589 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('haversine: Boston to New York is about 306 km', () => {
  near(core.haversineKm(boston, { lat: 40.7128, lon: -74.006 }), 306, 3);
  assert.equal(core.haversineKm(boston, boston), 0);
});

test('tile maths round-trips', () => {
  for (const z of [3, 8, 12]) {
    const t = core.lonLatToTile(boston.lon, boston.lat, z);
    const back = core.tileToLonLat(t.x, t.y, z);
    near(back.lon, boston.lon, 1e-9);
    near(back.lat, boston.lat, 1e-9);
  }
  const origin = core.lonLatToTile(0, 0, 1);
  assert.deepEqual([origin.x, origin.y], [1, 1]);
});

test('tiles for a radius cover the circle and wrap the date line', () => {
  const tiles = core.tilesForRadius(boston, 100, 8);
  const centre = core.lonLatToTile(boston.lon, boston.lat, 8);
  assert.ok(tiles.some((t) => t.x === Math.floor(centre.x) && t.y === Math.floor(centre.y)));
  const fiji = core.tilesForRadius({ lat: -17.7, lon: 179.9 }, 200, 6);
  assert.ok(fiji.some((t) => t.x === 0) && fiji.some((t) => t.x === 63));
  assert.equal(new Set(fiji.map((t) => `${t.x},${t.y}`)).size, fiji.length);
});

test('pickZoom is as detailed as the tile budget allows', () => {
  const z = core.pickZoom(boston, 300, 120);
  assert.ok(core.tilesForRadius(boston, 300, z).length <= 120);
  assert.ok(core.tilesForRadius(boston, 300, z + 1).length > 120);
  assert.ok(core.pickZoom(boston, 50) > core.pickZoom(boston, 1000));
});

test('terrarium decoding', () => {
  assert.equal(core.terrariumElevation(128, 0, 0), 0);
  assert.equal(core.terrariumElevation(135, 125, 0), 7 * 256 + 125); // 1917 m, Mt Washington
  assert.equal(core.terrariumElevation(127, 255, 128), -0.5);
});

test('profile keeps the running maximum and where it is', () => {
  const p = core.makeProfile(boston, 100, 10);
  const east = (km) => ({ lon: boston.lon + km / core.kmPerDegree(boston.lat).lon, lat: boston.lat });
  const add = (km, m) => { const q = east(km); core.addSample(p, q.lon, q.lat, m); };
  add(5, 20); add(35, 300); add(55, 100); add(95, 900); add(150, 5000);
  const pts = core.finishProfile(p);
  assert.equal(pts.length, 10);
  assert.equal(pts[0].max, 20);
  assert.equal(pts[3].max, 300);
  assert.equal(pts[5].max, 300);
  assert.equal(pts[5].ring, 100);
  assert.equal(pts[9].max, 900);
  near(pts[9].at.km, 95, 0.5);
  assert.equal(core.distanceToReach(pts, 250), 40);
  assert.equal(core.distanceToReach(pts, 1000), null);
  assert.equal(core.summitWithin(pts, 50).metres, 300);
});

test('a profile with nothing in a ring leaves it empty', () => {
  const p = core.makeProfile(boston, 10, 2);
  const pts = core.finishProfile(p);
  assert.equal(pts[0].max, null);
  assert.equal(pts[0].ring, null);
});

test('grid points are spaced evenly with north at row 0', () => {
  const g = core.makeGrid(boston, 100, 5);
  assert.equal(g.points.length, 25);
  assert.equal(g.step, 50);
  const centre = g.points[12];
  near(centre.lat, boston.lat, 1e-9);
  near(centre.lon, boston.lon, 1e-9);
  assert.ok(g.points[0].lat > g.points[24].lat);
  assert.ok(g.points[0].lon < g.points[4].lon);
  near(core.haversineKm(centre, g.points[13]), 50, 0.5);
});

test('gridToLonLat maps pixel centres back onto sample points', () => {
  const g = core.makeGrid(boston, 100, 5);
  const [lon, lat] = core.gridToLonLat(g, 2.5, 2.5);
  near(lon, boston.lon, 1e-9);
  near(lat, boston.lat, 1e-9);
  const [lon0, lat0] = core.gridToLonLat(g, 0.5, 0.5);
  near(lon0, g.points[0].lon, 1e-9);
  near(lat0, g.points[0].lat, 1e-9);
});

test('durations: nulls and far snaps become unreachable', () => {
  const h = core.cleanDurations([3600, null, 7200, 1800], [100, 0, 30000, 4000], 5);
  assert.deepEqual(h, [1, Infinity, Infinity, 0.5]);
  assert.deepEqual(core.contourValues([1, Infinity]), [1, core.UNREACHABLE]);
});

test('chunk splits into runs', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(core.chunk([], 3), []);
});

test('hoursAt interpolates, and falls back to the nearest sample at a coast', () => {
  const g = core.makeGrid(boston, 10, 3); // step 10 km
  const hours = [0, 1, 2, 0, 1, 2, 0, 1, Infinity];
  const deg = core.kmPerDegree(boston.lat);
  near(core.hoursAt(g, hours, boston.lon, boston.lat), 1, 1e-9);
  near(core.hoursAt(g, hours, boston.lon - 5 / deg.lon, boston.lat + 5 / deg.lat), 0.5, 1e-9);
  assert.equal(core.hoursAt(g, hours, boston.lon + 6 / deg.lon, boston.lat - 6 / deg.lat), Infinity);
  assert.equal(core.hoursAt(g, hours, boston.lon + 4 / deg.lon, boston.lat - 4 / deg.lat), 1);
  assert.equal(core.hoursAt(g, hours, boston.lon + 50, boston.lat), Infinity);
});

test('reach curve counts area and the farthest point', () => {
  const g = core.makeGrid(boston, 10, 3);
  const hours = [2, 2, 2, 1, 0, 1, 2, 2, Infinity];
  const curve = core.reachCurve(g, hours, [0.5, 1, 2]);
  assert.equal(curve[0].areaKm2, 100);
  assert.equal(curve[1].areaKm2, 300);
  assert.equal(curve[1].farthestKm, 10);
  assert.equal(curve[2].areaKm2, 800);
  near(curve[2].farthestKm, Math.hypot(10, 10), 1e-9);
});

test('drive heights keep the running maximum by quarter hour', () => {
  const acc = core.makeDriveHeights(2);
  core.addDriveSample(acc, 0.1, 0, 0, 50);
  core.addDriveSample(acc, 0.9, 1, 1, 400);
  core.addDriveSample(acc, 1.6, 2, 2, 300);
  core.addDriveSample(acc, 3, 3, 3, 9000);
  core.addDriveSample(acc, Infinity, 3, 3, 9000);
  const curve = core.finishDriveHeights(acc);
  assert.equal(curve.length, 8);
  assert.equal(core.atLimit(curve, 'hours', 0.5).max, 50);
  assert.equal(core.atLimit(curve, 'hours', 1).max, 400);
  assert.equal(core.atLimit(curve, 'hours', 2).max, 400);
  assert.equal(core.atLimit(curve, 'hours', 1).at.lon, 1);
});

test('formatting in both unit systems', () => {
  assert.equal(core.formatDistance(5.26, 'metric'), '5.3 km');
  assert.equal(core.formatDistance(1234, 'metric'), '1,234 km');
  assert.equal(core.formatDistance(100, 'imperial'), '62 mi');
  assert.equal(core.formatHeight(1917, 'metric'), '1,917 m');
  assert.equal(core.formatHeight(1917, 'imperial'), '6,289 ft');
  assert.equal(core.formatHeight(null, 'metric'), '-');
  assert.equal(core.formatArea(1000, 'imperial'), '386 sq mi');
  assert.equal(core.formatHours(4), '4 h');
  assert.equal(core.formatHours(4.5), '4 h 30');
  assert.equal(core.formatHours(0.25), '15 min');
  assert.equal(core.formatHours(1.999), '2 h');
});

test('KML colours are aabbggrr', () => {
  assert.equal(core.kmlColor('#2a78d6', 1), 'ffd6782a');
  assert.equal(core.kmlColor('#2a78d6', 0.25), '40d6782a');
});

test('drive KML has a band per limit, holes and pins, escaped', () => {
  const kml = core.driveKml({
    name: 'Boston & around',
    origin: { name: 'Home', lon: -71, lat: 42 },
    bands: [{
      label: '4 h',
      color: '#2a78d6',
      polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5], [0.2, 0.2]]]],
    }],
    placemarks: [{ name: 'Highest within 4 h', lon: -71.3, lat: 44.27, description: '1,917 m' }],
  });
  assert.match(kml, /<name>Boston &amp; around<\/name>/);
  assert.match(kml, /<innerBoundaryIs>/);
  assert.equal((kml.match(/<Placemark>/g) || []).length, 3);
  assert.match(kml, /-71\.30000,44\.27000,0/);
});

test('profiles CSV lines places up by distance', () => {
  const pts = [{ km: 1, max: 10, ring: 10 }, { km: 2, max: 30.25, ring: null }];
  const csv = core.profilesCsv([{ name: 'Cape Town, ZA', points: pts }]).trim().split('\n');
  assert.equal(csv[0], 'km,"Cape Town, ZA max m","Cape Town, ZA ring m"');
  assert.equal(csv[2], '2.00,30.3,');
});

test('despike removes lone glitches and keeps real peaks', () => {
  const size = 5;
  const flat = new Float32Array(size * size).fill(5);
  flat[2 * size + 2] = 2375; // the glitch seen off Cuba
  flat[1 * size + 2] = 268;  // and its smaller neighbour
  flat[4 * size + 0] = 123;  // a Florida-sized blip
  const clean = core.despike(flat, size);
  assert.ok(clean[2 * size + 2] < 20);
  assert.ok(clean[1 * size + 2] < 20);
  assert.ok(clean[4 * size + 0] < 20);

  const mountain = Float32Array.from([
    900, 1200, 1300, 1100, 800,
    1100, 1500, 1700, 1400, 1000,
    1200, 1650, 1917, 1600, 1100,
    1000, 1400, 1550, 1300, 900,
    800, 1000, 1100, 1000, 700,
  ]);
  assert.deepEqual(Array.from(core.despike(mountain, size)), Array.from(mountain));
});

test('impossible heights decode as missing', () => {
  assert.ok(Number.isNaN(core.terrariumElevation(255, 255, 255))); // white: 32,767 m
  assert.ok(Number.isNaN(core.terrariumElevation(0, 0, 0)));       // black: -32,768 m
  assert.equal(core.terrariumElevation(162, 145, 0), 8849);         // Everest still counts
});

test('despike flattens a one-pixel streak', () => {
  // The Port Everglades column, as read from the zoom-12 tile.
  const streak = Float32Array.from([
    1, 11, -50, 99, 5,
    1, 9, -50, 103, 6,
    19, 9, -80, 151, 6,
    0, 10, -86, 181, 7,
    18, 10, -55, 149, 6,
  ]);
  const clean = core.despike(streak, 5);
  for (let y = 0; y < 5; y++) assert.ok(clean[y * 5 + 3] < 20, `row ${y}: ${clean[y * 5 + 3]}`);

  // A sharp alpine ridge, one pixel wide, survives.
  const ridge = new Float32Array(25).fill(3800);
  for (let y = 0; y < 5; y++) ridge[y * 5 + 2] = 4100;
  assert.deepEqual(Array.from(core.despike(ridge, 5)), Array.from(ridge));
});

test('despike fills a patch of missing pixels from its neighbours', () => {
  const size = 5;
  const tile = new Float32Array(size * size).fill(3);
  for (const k of [6, 7, 8, 11, 12, 13]) tile[k] = NaN; // a 3x2 no-data patch near Miami
  const clean = core.despike(tile, size);
  assert.ok(clean.every((v) => Number.isFinite(v) && v <= 3));
  assert.deepEqual(Array.from(core.despike(new Float32Array(9).fill(NaN), 3)), new Array(9).fill(0));
});

test('a close-up reading replaces a coarse glitch', () => {
  const centre = { lon: 0, lat: 0 };
  const profile = core.makeProfile(centre, 100, 100);
  core.addSample(profile, 0.1, 0, 40);   // real ground, 11 km out
  core.addSample(profile, 0.5, 0, 1304); // a glitch patch, 56 km out
  const glitch = core.finishProfile(profile).at(-1).at;
  assert.equal(core.finishProfile(profile).at(-1).max, 1304);
  core.replacePeak(profile, glitch, { lon: 0.5, lat: 0, metres: 12 });
  assert.equal(core.finishProfile(profile).at(-1).max, 40);

  // and a real summit reads higher up close
  core.addSample(profile, 0.7, 0, 900);
  const coarse = core.finishProfile(profile).at(-1).at;
  core.replacePeak(profile, coarse, { lon: 0.7001, lat: 0, metres: 965 });
  assert.equal(core.finishProfile(profile).at(-1).max, 965);
});

test('square bounds are sideKm across', () => {
  const b = core.squareBounds(boston, 20);
  near(core.haversineKm({ lat: boston.lat, lon: b.west }, { lat: boston.lat, lon: b.east }), 20, 0.1);
  near(core.haversineKm({ lat: b.south, lon: boston.lon }, { lat: b.north, lon: boston.lon }), 20, 0.1);
});

test('print zoom is fine enough for the grid and within budget', () => {
  const z = core.printZoom(boston, 20, 200);
  assert.ok(core.pixelMetres(boston.lat, z) <= 200);
  assert.ok(core.tilesForRadius(boston, 20 * 0.71, z).length <= 64);
  assert.ok(core.printZoom(boston, 200, 200) < z);
});

test('print heights scale to millimetres over a base', () => {
  const p = core.printHeights([-20, 0, 500, 1000], { sideKm: 10, widthMm: 100, exaggeration: 2, baseMm: 3 });
  assert.equal(p.lowM, 0);
  assert.equal(p.highM, 1000);
  assert.deepEqual(p.mm, [3, 3, 13, 23]); // 100 mm / 10 km = 0.01 mm per m, doubled
  near(p.reliefMm, 20, 1e-9);
});

test('terrain STL is closed: every edge shared by exactly two triangles', () => {
  const n = 5;
  const z = Array.from({ length: n * n }, (_, k) => 3 + (k % 7));
  const tris = core.readStl(core.terrainStl(z, n, 50));
  assert.equal(tris.length, 2 * (n - 1) ** 2 + 3 * 4 * (n - 1));
  const edges = new Map();
  const key = (p) => p.map((v) => v.toFixed(3)).join(',');
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = key(t.v[k]), b = key(t.v[(k + 1) % 3]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((c) => c === 2));
  // and consistently wound: each directed edge appears once
  const directed = new Set();
  for (const t of tris) for (let k = 0; k < 3; k++) directed.add(`${key(t.v[k])}>${key(t.v[(k + 1) % 3])}`);
  assert.equal(directed.size, tris.length * 3);
});

test('terrain STL faces outward: top normals point up, bottom down', () => {
  const n = 3;
  const tris = core.readStl(core.terrainStl(new Array(n * n).fill(5), n, 10));
  assert.ok(tris.slice(0, 8).every((t) => t.normal[2] > 0.99));
  assert.ok(tris.filter((t) => t.v.every((p) => p[2] === 0)).every((t) => t.normal[2] < -0.99));
});
