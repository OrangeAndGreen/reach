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

test('map image: the square fits the pixel budget and its tiles cover it', () => {
  const b = core.squareBounds(boston, 10);
  const z = core.mapImageZoom(b, 17);
  const box = core.pixelBox(b, z);
  assert.ok(box.width <= 2048 && core.pixelBox(b, z + 1).width > 2048, `zoom ${z} is not the finest that fits`);
  near(box.width / box.height, 1, 0.01); // a km square is square on a mercator map
  const left = Math.min(...box.tiles.map((t) => t.left)), top = Math.min(...box.tiles.map((t) => t.top));
  const right = Math.max(...box.tiles.map((t) => t.left + 256)), bottom = Math.max(...box.tiles.map((t) => t.top + 256));
  assert.ok(left <= box.left && top <= box.top && right >= box.left + box.width && bottom >= box.top + box.height);
  assert.ok(right - (box.left + box.width) < 256 && box.left - left < 256, 'no spare column of tiles');
  assert.equal(core.mapImageZoom(core.squareBounds(boston, 2), 12), 12); // capped by the layer's zoom
});

test('map image: a square across the date line wraps its tile numbers', () => {
  const box = core.pixelBox(core.squareBounds({ lat: -17, lon: 179.99 }, 20), 8);
  const xs = new Set(box.tiles.map((t) => t.x));
  assert.ok(xs.has(255) && xs.has(0));
  assert.ok(box.tiles.every((t) => t.x >= 0 && t.x < 256));
});

test('table rings: one radius per height reached, one summit per distinct point', () => {
  const p = core.makeProfile(boston, 100, 10);
  const east = (km) => ({ lon: boston.lon + km / core.kmPerDegree(boston.lat).lon, lat: boston.lat });
  const add = (km, m) => { const q = east(km); core.addSample(p, q.lon, q.lat, m); };
  add(5, 20); add(35, 300); add(95, 900);
  const pts = core.finishProfile(p);
  // 100 and 250 m are both first reached by the 300 m point at 40 km; 2000 m never is.
  const { radii, summits } = core.tableRings(pts, [10, 100, 250, 800, 2000], 100);
  assert.deepEqual(radii, [10, 40, 100]);
  assert.deepEqual(summits.map((s) => [s.metres, s.minKm, s.maxKm]), [[20, 10, 10], [300, 40, 40], [900, 100, 100]]);
  // The 900 m point is the highest both at 100 km (reaching 800 m) and over the whole radius.
  const wide = core.tableRings(pts, [300, 800], 150);
  assert.deepEqual(wide.radii, [40, 100, 150]);
  assert.deepEqual(wide.summits.map((s) => [s.metres, s.minKm, s.maxKm]), [[300, 40, 40], [900, 100, 150]]);
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

test('edge skew grows with the square and the latitude', () => {
  near(core.edgeSkew({ lat: 45, lon: 0 }, 500), 0.075, 0.005);
  near(core.edgeSkew({ lat: 45, lon: 0 }, 200), 0.031, 0.003);
  assert.ok(core.edgeSkew({ lat: 60, lon: 0 }, 500) > core.edgeSkew({ lat: 45, lon: 0 }, 500));
  near(core.edgeSkew({ lat: -45, lon: 0 }, 500), 0.075, 0.005);
  assert.ok(core.edgeSkew({ lat: 0, lon: 0 }, 500) < 0.002); // both edges barely off the equator
});

test('a square side reads in metres or feet when small', () => {
  assert.equal(core.formatSide(0.25, 'metric'), '250 m');
  assert.equal(core.formatSide(0.1, 'metric'), '100 m');
  assert.equal(core.formatSide(20, 'metric'), '20 km');
  assert.equal(core.formatSide(0.25, 'imperial'), '820 ft');
  assert.equal(core.formatSide(500, 'imperial'), '311 mi');
});

test('a side typed by hand reads in any unit, bare numbers in the units on show', () => {
  assert.deepEqual(core.parseSide('3.5', 'metric'), { km: 3.5, label: '3.5 km' });
  assert.deepEqual(core.parseSide(' 800 m ', 'metric'), { km: 0.8, label: '800 m' });
  assert.deepEqual(core.parseSide('12.5KM', 'imperial'), { km: 12.5, label: '12.5 km' });
  near(core.parseSide('2', 'imperial').km, 3.218688, 1e-9);
  assert.equal(core.parseSide('2', 'imperial').label, '2 mi');
  near(core.parseSide('1,500 ft', 'metric').km, 0.4572, 1e-9);
  assert.equal(core.parseSide('1,500 ft', 'metric').label, '1,500 ft');
  assert.equal(core.parseSide('.5', 'metric').km, 0.5);
});

test('a side typed by hand is refused when it does not read or is out of range', () => {
  for (const text of ['', 'abc', '-3', '3 yd', '1e3', '3 km 2']) assert.equal(core.parseSide(text, 'metric'), null, text);
  assert.equal(core.parseSide('40 m', 'metric'), null);
  assert.equal(core.parseSide('501', 'metric'), null);
  assert.equal(core.parseSide('500', 'imperial'), null); // 805 km
  assert.equal(core.parseSide('0', 'metric'), null);
  assert.equal(core.parseSide('500', 'metric').km, 500);
});

test('stretch stops run from x1 to x50 and take in a saved value', () => {
  assert.equal(core.STRETCH_STOPS[0], 1);
  assert.equal(core.STRETCH_STOPS.at(-1), 50);
  assert.ok(core.STRETCH_STOPS.includes(1.5) && core.STRETCH_STOPS.includes(9.75) && core.STRETCH_STOPS.includes(27.5));
  assert.ok(core.STRETCH_STOPS.every((v, i, a) => i === 0 || v > a[i - 1]));
  assert.equal(core.withStop(core.STRETCH_STOPS, 2), core.STRETCH_STOPS);
  const more = core.withStop(core.STRETCH_STOPS, 12.5);
  assert.equal(more[more.indexOf(12.5) - 1], 12);
  assert.equal(core.withStop(core.STRETCH_STOPS, 80).at(-1), 80);
});

test('detail is a pitch, so wider models get more grid points', () => {
  assert.equal(core.gridCells(120, 0.4), 301);
  assert.equal(core.gridCells(120, 0.6), 201);
  assert.equal(core.gridCells(250, 0.4), 626);
  assert.equal(core.gridCells(80, 1), 81);
  // a count from an old file comes back as itself
  assert.equal(core.gridCells(120, 120 / 299), 300);
  assert.equal(core.gridCells(10000, 0.01), core.MAX_CELLS);
});

test('the finest grid on the widest model gets its zoom within the tile budget', () => {
  for (let lat = 0; lat <= 70; lat += 5) {
    for (let side = 1; side <= 500; side *= 1.07) {
      const c = { lat, lon: 10.3 }, n = core.gridCells(250, 0.4);
      const z = core.printZoom(c, side, n);
      assert.ok(z === 14 || core.pixelMetres(lat, z) <= (side * 1000) / n, `${lat}° ${side.toFixed(1)} km`);
    }
  }
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

test('print heights: the sea floor goes down to its limit, with its own stretch', () => {
  const set = { sideKm: 10, widthMm: 100, exaggeration: 2, baseMm: 3, seaFloorM: 200, depthStretch: 5 };
  const p = core.printHeights([-500, -100, 0, 1000], set);
  assert.equal(p.lowM, -200);
  assert.equal(p.highM, 1000);
  // 0.01 mm per m: 200 m of depth at x5 is 10 mm, 1000 m of height at x2 is 20 mm
  assert.deepEqual(p.mm.map((v) => +v.toFixed(9)), [3, 8, 13, 33]);
  near(p.reliefMm, 30, 1e-9);
  near(p.seaMm, 13, 1e-9);
  assert.equal(core.printHeights([0, 50], set).seaMm, null);
});

test('suggested stretch grows as the ground flattens, by its square root, on a stop', () => {
  assert.equal(core.suggestStretch(1600, 20), 1.5); // Mt Washington
  assert.equal(core.suggestStretch(100, 20), 6); // 25 times flatter, 4 times the stretch
  assert.equal(core.suggestStretch(3500, 100), 2.25); // the Alps
  assert.ok(core.STRETCH_STOPS.includes(core.suggestStretch(237, 13)));
});

test('suggested stretch stays within x1 to x20, and needs land relief', () => {
  assert.equal(core.suggestStretch(2000, 1), 1);
  assert.equal(core.suggestStretch(5, 100), 20);
  assert.equal(core.suggestStretch(0, 10), null);
  assert.equal(core.suggestStretch(-50, 10), null);
});

test('print heights: depth stretch follows the height stretch unless given', () => {
  const p = core.printHeights([-100, 100], { sideKm: 10, widthMm: 100, exaggeration: 3, baseMm: 0, seaFloorM: 11000 });
  near(p.reliefMm, 6, 1e-9);
});

test('the sea floor fills in under sea level, and land keeps its detail', () => {
  const fine = [120, 0, 0, -4, 0];
  const coarse = [80, -30, 15, -2, -657];
  // land, sea, the coarse blend at a coast (stays 0), a polder deeper than its blend, canyon
  assert.deepEqual(core.withSeaFloor(fine, coarse), [120, -30, 0, -4, -657]);
});

test('the shoreline is the land beside the sea, and small dips below sea level are not sea', () => {
  const n = 6;
  // west half land, east half sea, and one lone point below sea level inland
  const h = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h.push(i < 3 ? 50 : (i === 3 ? 0 : -20));
  h[1 * n + 0] = -3;
  const shore = core.shorePoints(h, n);
  for (let j = 0; j < n; j++) {
    assert.deepEqual([...shore.slice(j * n, j * n + n)], [0, 0, 1, 0, 0, 0], `row ${j}`);
  }
  // with no size limit the lone dip draws a ring around it
  const all = core.shorePoints(h, n, 1);
  assert.equal(all[0 * n + 0], 1);
  assert.equal(all[1 * n + 1], 1);
  assert.equal(core.shorePoints(new Array(n * n).fill(10), n).includes(1), false);
});

test('the shoreline groove cuts down, and never through the model', () => {
  const shore = Uint8Array.from([0, 1, 1, 1]);
  assert.deepEqual(core.markShore([5, 5, 1, 0.4], shore, 0.8).map((v) => +v.toFixed(9)), [5, 4.2, 0.6, 0.4]);
});

test('the shoreline ridge stands up from the shore alone', () => {
  const shore = Uint8Array.from([0, 1, 1]);
  assert.deepEqual(core.markShore([5, 5, 0.4], shore, 0.8, true).map((v) => +v.toFixed(9)), [5, 5.8, 1.2]);
});

test('a print KML carries the shoreline line and its style, and older files have none', () => {
  const set = { sideKm: 5, widthMm: 80, cells: 120, exaggeration: 2, baseMm: 2, shoreMm: 0.4, shoreRidge: true };
  const kml = core.printKml({ centre: { name: 'a', lat: 1, lon: 2 }, set });
  assert.equal(core.parsePrintKml(kml).set.shoreMm, 0.4);
  assert.equal(core.parsePrintKml(kml).set.shoreRidge, true);
  const old = kml.replace(/\s*<Data name="shore(Mm|Ridge)">.*?<\/Data>/g, '');
  assert.equal(core.parsePrintKml(old).set.shoreMm, 0);
  assert.equal(core.parsePrintKml(old).set.shoreRidge, false);
});

test('despike fills a lone pit where the sources meet, and keeps a real basin', () => {
  const size = 5;
  const beach = new Float32Array(size * size).fill(4);
  beach[2 * size + 2] = -4348; // seen at Monterey, zoom 11
  assert.ok(core.despike(beach, size)[2 * size + 2] > 0);

  const basin = Float32Array.from([
    -100, -200, -300, -200, -100,
    -200, -400, -600, -400, -200,
    -300, -600, -900, -600, -300,
    -200, -400, -600, -400, -200,
    -100, -200, -300, -200, -100,
  ]);
  assert.deepEqual(Array.from(core.despike(basin, size)), Array.from(basin));
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

test('a print KML carries the square, the settings and the model figures', () => {
  const centre = { name: 'Mount Washington, New Hampshire', lat: 44.2706, lon: -71.3033 };
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1.5, baseMm: 3, seaFloorM: 0, depthStretch: 1.5, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, cols: 1, rows: 1 };
  const model = { zoom: 12, pixelM: 27.8, lowM: 410, highM: 1916, reliefMm: 13.55, triangles: 81590 };
  const kml = core.printKml({ centre, set, model, stlFile: 'reach-mount-washington-20km.stl', made: new Date('2026-10-15T12:00:00Z') });
  assert.match(kml, /<Data name="heightStretch"><displayName>Height stretch \(x\)<\/displayName><value>1.5<\/value><\/Data>/);
  assert.match(kml, /<Data name="metresPerPixel">.*<value>28<\/value>/);
  assert.match(kml, /<Data name="modelHeightMm">.*<value>16.55<\/value>/);
  assert.match(kml, /<Data name="mapScale">.*<value>1:166667<\/value>/);
  assert.match(kml, /<Data name="stlFile">.*<value>reach-mount-washington-20km.stl<\/value>/);
  assert.equal((kml.match(/<Placemark/g) || []).length, 2);
  // the polygon closes on its first corner
  const coords = kml.match(/<coordinates>([^<]+)<\/coordinates>/)[1].trim().split(' ');
  assert.equal(coords.length, 5);
  assert.equal(coords[0], coords[4]);

  assert.deepEqual(core.parsePrintKml(kml), {
    centre: { name: centre.name, lat: 44.2706, lon: -71.3033 },
    set,
  });
});

test('a print KML round-trips awkward names, and works without a model', () => {
  const centre = { name: 'Rock & "Roll" <Hills>', lat: -33.9, lon: 18.4 };
  const set = { sideKm: 5, widthMm: 80, cells: 81, pitchMm: 1, exaggeration: 10, baseMm: 2, seaFloorM: 1000, depthStretch: 4, shoreMm: 0.8, shoreRidge: false, label: false, labelText: '', cornerMm: 0, shape: 'rectangle', aspect: 5, bearing: 29, buildings: false, buildingDefaultM: 7, cols: 1, rows: 1 };
  const kml = core.printKml({ centre, set });
  assert.match(kml, /Rock &amp; &quot;Roll&quot; &lt;Hills&gt;/);
  assert.doesNotMatch(kml, /metresPerPixel/);
  assert.deepEqual(core.parsePrintKml(kml), { centre, set });
  // a file from before detail was a pitch keeps its count
  const old = kml.replace(/<Data name="gridPitchMm">[\s\S]*?<\/Data>/, '').replace(/(name="gridCells">.*?<value>)81/, '$1120');
  assert.equal(core.parsePrintKml(old).set.cells, 120);
  assert.equal(core.gridCells(80, core.parsePrintKml(old).set.pitchMm), 120);
});

test('parsePrintKml refuses other KML and bad values', () => {
  const drive = core.driveKml({ name: 'x', origin: { name: 'o', lat: 0, lon: 0 }, bands: [] });
  assert.throws(() => core.parsePrintKml(drive), /not saved from Reach/);
  const good = core.printKml({ centre: { name: 'a', lat: 1, lon: 2 }, set: { sideKm: 5, widthMm: 80, cells: 120, exaggeration: 2, baseMm: 2 } });
  assert.throws(() => core.parsePrintKml(good.replace('<value>120</value>', '<value>lots</value>')), /gridCells/);
});

test('a print KML from before the sea floor opens as cut at sea level', () => {
  const kml = core.printKml({ centre: { name: 'a', lat: 1, lon: 2 }, set: { sideKm: 5, widthMm: 80, cells: 120, exaggeration: 2, baseMm: 2 } })
    .replace(/<Data name="seaFloorM">.*?<\/Data>/, '<Data name="seaCutToZero"><displayName>Sea floor cut to sea level</displayName><value>yes</value></Data>')
    .replace(/\s*<Data name="depthStretch">.*?<\/Data>/, '');
  assert.doesNotMatch(kml, /seaFloorM/);
  const { set } = core.parsePrintKml(kml);
  assert.equal(set.seaFloorM, 0);
  assert.equal(set.depthStretch, 2);
});

test('a print KML records where the sea floor was read', () => {
  const set = { sideKm: 20, widthMm: 120, cells: 200, exaggeration: 1.5, baseMm: 3, seaFloorM: 200, depthStretch: 3 };
  const model = { zoom: 12, pixelM: 27.8, seaZoom: 10, seaPixelM: 111.2, lowM: -200, highM: 300, reliefMm: 4.5, triangles: 100 };
  const kml = core.printKml({ centre: { name: 'Monterey', lat: 36.6, lon: -121.9 }, set, model });
  assert.match(kml, /<Data name="seaFloorZoom">.*<value>10<\/value>/);
  assert.match(kml, /<Data name="seaFloorMetresPerPixel">.*<value>111<\/value>/);
  assert.match(kml, /<Data name="seaFloorM">.*<value>200<\/value>/);
});

// ---------- buildings ----------

const closedEdges = (tris) => {
  const key = (p) => p.map((v) => v.toFixed(3)).join(',');
  const edges = new Map();
  const directed = new Set();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = key(t[k]), b = key(t[(k + 1) % 3]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) || 0) + 1);
      directed.add(`${a}>${b}`);
    }
  }
  return [...edges.values()].every((c) => c === 2) && directed.size === tris.length * 3;
};
const triples = (flat) => Array.from({ length: flat.length / 3 }, (_, t) => flat.slice(t * 3, t * 3 + 3));

test('OSM heights: metres, feet, floors, and nothing', () => {
  assert.equal(core.parseMetres('12'), 12);
  assert.equal(core.parseMetres('12.5 m'), 12.5);
  assert.equal(core.parseMetres('7,5'), 7.5);
  near(core.parseMetres('100 ft'), 30.48, 1e-9);
  near(core.parseMetres("40'"), 12.192, 1e-9);
  near(core.parseMetres('12\'6"'), 3.81, 1e-9);
  assert.equal(core.parseMetres('tall'), null);
  assert.equal(core.buildingHeight({ height: '25', 'building:levels': '3' }), 25);
  assert.equal(core.buildingHeight({ 'building:levels': '4' }), 12);
  assert.equal(core.buildingHeight({ 'building:levels': '4', 'roof:levels': '1' }), 15);
  assert.equal(core.buildingHeight({ height: 'unknown', 'building:levels': '2' }), 6);
  assert.equal(core.buildingHeight({ building: 'yes' }), null);
});

test('joinRings closes a multipolygon outline drawn in pieces, either way round', () => {
  const rings = core.joinRings([[[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 1]], [[5, 5], [6, 5]]]);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0], [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
});

test('clipToSquare cuts a ring at the square and keeps one inside whole', () => {
  const across = core.clipToSquare([[-5, 2], [5, 2], [5, 4], [-5, 4]], 10);
  assert.equal(Math.abs(core.ringArea2(across)) / 2, 10);
  assert.ok(across.every(([x]) => x >= 0));
  const inside = [[1, 1], [2, 1], [2, 2]];
  assert.deepEqual(core.clipToSquare(inside, 10), inside);
  assert.equal(core.clipToSquare([[20, 20], [21, 20], [21, 21]], 10), null);
});

test('building footprints: model millimetres, wound for the mesh, junk left out', () => {
  const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
  const way = (tags, pts) => ({ type: 'way', tags, geometry: [...pts, pts[0]].map(([lon, lat]) => ({ lon, lat })) });
  const square = (x, y, s) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y]]; // clockwise, as OSM often has it
  const osm = { elements: [
    way({ building: 'yes', height: '30' }, square(0.002, 0.002, 0.002)),
    way({ building: 'roof' }, square(0.005, 0.005, 0.002)),
    way({ building: 'yes' }, square(0.008, 0.008, 0.00001)), // a few cm across
    way({ building: 'house', 'building:levels': '2' }, square(0.009, 0.004, 0.002)), // over the east edge
    { type: 'relation', tags: { building: 'yes', type: 'multipolygon' }, members: [
      { type: 'way', role: 'outer', geometry: [[0.0001, 0.006], [0.004, 0.006], [0.004, 0.0099]].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'way', role: 'outer', geometry: [[0.004, 0.0099], [0.0001, 0.0099], [0.0001, 0.006]].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'way', role: 'inner', geometry: [...square(0.001, 0.007, 0.001), [0.001, 0.007]].map(([lon, lat]) => ({ lon, lat })) },
    ] },
  ] };
  const fps = core.buildingFootprints(osm, bounds, 100);
  assert.equal(fps.length, 3);
  const [tower, edge, court] = fps;
  assert.equal(tower.heightM, 30);
  near(Math.abs(core.ringArea2(tower.rings[0])) / 2, 400, 1e-6); // 20 x 20 mm
  assert.ok(fps.every((f) => core.ringArea2(f.rings[0]) > 0));
  assert.ok(edge.rings[0].every(([x]) => x <= 100 + 1e-9));
  near(Math.abs(core.ringArea2(edge.rings[0])) / 2, 200, 1e-6); // half of it
  assert.equal(edge.heightM, 6);
  assert.equal(court.heightM, null);
  assert.equal(court.rings.length, 2);
  assert.ok(core.ringArea2(court.rings[1]) < 0);
});

test('a courtyard cut by the square is filled in, so the solid stays closed', () => {
  const bounds = { west: 0, east: 0.01, south: 0, north: 0.01 };
  const ring = (pts) => [...pts, pts[0]].map(([lon, lat]) => ({ lon, lat }));
  const osm = { elements: [{ type: 'relation', tags: { building: 'yes', type: 'multipolygon' }, members: [
    { type: 'way', role: 'outer', geometry: ring([[-0.002, 0.002], [0.003, 0.002], [0.003, 0.006], [-0.002, 0.006]]) },
    { type: 'way', role: 'inner', geometry: ring([[-0.001, 0.003], [-0.001, 0.005], [0.001, 0.005], [0.001, 0.003]]) },
  ] }] };
  const [fp] = core.buildingFootprints(osm, bounds, 100);
  assert.equal(fp.rings.length, 1);
  const tris = triples(core.buildingTriangles([{ ...fp, heightM: 10, groundM: 0 }], new Array(121).fill(3), 11,
    { widthMm: 100, toMm: () => 3, mmPerMetre: 0.1, exaggeration: 1 }));
  assert.ok(closedEdges(tris));
});

test('convex hull, and a closed check that catches a gap', () => {
  assert.deepEqual(core.convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0]]), [[0, 0], [2, 0], [2, 2], [0, 2]]);
  const box = core.buildingTriangles([{ rings: [[[0, 0], [2, 0], [2, 2], [0, 2]]], heightM: 10, groundM: 0 }], [3, 3, 3, 3], 2,
    { widthMm: 10, toMm: () => 3, mmPerMetre: 0.1, exaggeration: 1 });
  assert.ok(core.isClosed(box));
  assert.ok(!core.isClosed(box.slice(3)));
});

test('an outline that crosses itself still prints as a closed solid', () => {
  const opts = { widthMm: 10, toMm: () => 3, mmPerMetre: 0.1, exaggeration: 1 };
  const bowtie = { rings: [[[0, 0], [2, 2], [2, 0], [0, 2]]], heightM: 10, groundM: 0 };
  const flat = core.buildingTriangles([bowtie], [3, 3, 3, 3], 2, opts);
  assert.ok(core.isClosed(flat));
  assert.ok(closedEdges(triples(flat)));
  const sliver = { rings: [[[0, 0], [1, 1], [2, 2]]], heightM: 10, groundM: 0 };
  assert.deepEqual(core.buildingTriangles([sliver], [3, 3, 3, 3], 2, opts), []);
});

test('placeBuildings flattens a tower the terrain already holds, and leaves bare ground alone', () => {
  const n = 21; // 1 mm a cell on a 20 mm model of a 200 m square: 10 m a cell
  const set = { sideKm: 0.2, widthMm: 20, padM: 15, defaultM: 7 };
  const tower = { rings: [[[8, 8], [12, 8], [12, 12], [8, 12]]], heightM: 100 };
  const house = { rings: [[[2, 2], [4, 2], [4, 4], [2, 4]]], heightM: null };
  const ground = new Array(n * n).fill(5);
  const baked = ground.map((h, k) => {
    const i = k % n, j = Math.floor(k / n);
    return i >= 8 && i <= 12 && j >= 8 && j <= 12 ? 85 : h; // row 0 north, but the tower is in the middle either way
  });
  const bare = core.placeBuildings([tower, house], ground, n, set);
  assert.deepEqual(bare.heights, ground);
  assert.deepEqual(bare.buildings.map((b) => [b.groundM, b.inData, b.tagged, b.heightM]), [[5, false, true, 100], [5, false, false, 7]]);
  const city = core.placeBuildings([tower, house], baked, n, set);
  assert.equal(city.buildings[0].inData, true);
  assert.equal(city.buildings[0].groundM, 5);
  assert.equal(city.buildings[1].inData, false);
  assert.ok(city.heights.every((h) => h === 5));
  assert.equal(baked[10 * n + 10], 85); // the input grid is left as it was
});

test('a building beside deep water stands on its own ground, and the shore is left alone', () => {
  const n = 21;
  const set = { sideKm: 0.2, widthMm: 20, padM: 15, defaultM: 7 };
  // land at 2 m in the west half, a canal 11 m deep in the east (Dubai Marina)
  const grid = Array.from({ length: n * n }, (_, k) => (k % n <= 10 ? 2 : -11));
  const quay = { rings: [[[7, 8], [10, 8], [10, 12], [7, 12]]], heightM: null };
  const placed = core.placeBuildings([quay], grid, n, set);
  assert.equal(placed.buildings[0].groundM, 2);
  assert.equal(placed.buildings[0].inData, false);
  assert.deepEqual(placed.heights, grid);
});

test('placeBuildings tells a city held as a surface model from bare earth', () => {
  const n = 41; // 1 mm a cell on a 40 mm model of a 400 m square: 10 m a cell
  const set = { sideKm: 0.4, widthMm: 40, padM: 15, defaultM: 7 };
  const block = (x, y) => ({ rings: [[[x, y], [x + 3, y], [x + 3, y + 3], [x, y + 3]]], heightM: 30 });
  const blocks = [block(4, 4), block(10, 4), block(4, 10), block(10, 10), block(16, 4), block(16, 10)];
  const bare = new Array(n * n).fill(5);
  // the data blurs the blocks into a plateau 10 m up, and the open ground east of them stays at 5 m
  const lifted = bare.map((h, k) => ((k % n) <= 22 && Math.floor(k / n) >= 24 ? 15 : h));
  near(core.placeBuildings(blocks, bare, n, set).liftM, 0, 1e-9);
  const city = core.placeBuildings(blocks, lifted, n, set);
  near(city.liftM, 10, 1e-9);
  assert.ok(city.liftM > core.LIFTED_M);
  assert.equal(core.placeBuildings(blocks.slice(0, 2), bare, n, set).liftM, null);
});

test('each building is a closed solid standing on the terrain, courtyards and all', () => {
  const n = 11;
  const zMm = Array.from({ length: n * n }, (_, k) => 3 + (k % n) * 0.1); // rising to the east
  const scale = { widthMm: 10, toMm: (m) => 3 + m * 0.01, mmPerMetre: 0.01, exaggeration: 2 };
  const court = { rings: [[[1, 1], [6, 1], [6, 6], [1, 6]], [[2, 2], [2, 5], [5, 5], [5, 2]]], heightM: 50, groundM: 10 };
  const lshape = { rings: [[[7, 1], [9, 1], [9, 4], [8, 4], [8, 2], [7, 2]]], heightM: 20, groundM: 0 };
  const flat = core.buildingTriangles([court, lshape], zMm, n, scale);
  const tris = triples(flat);
  assert.ok(closedEdges(tris));
  const zs = flat.map((p) => p[2]);
  near(Math.max(...zs), 3 + 0.1 + 1, 1e-9); // the courtyard block: ground 10 m, then 50 m at x2
  // floors sit under the lowest terrain the footprint covers
  assert.ok(tris.filter((t) => t.every((p) => p[2] < 3))[0]);
  // the whole print, terrain and buildings, is still closed
  assert.ok(closedEdges(core.readStl(core.terrainStl(zMm, n, 10, flat)).map((t) => t.v)));
  const read = core.readStl(core.terrainStl(zMm, n, 10, flat));
  const roofs = read.slice(read.length - tris.length).filter((t) => t.v.every((p) => p[2] > 3.5));
  assert.ok(roofs.length > 0 && roofs.every((t) => t.normal[2] > 0.99));
});

test('a print KML keeps the building settings and what came of them', () => {
  const centre = { name: 'Sunny Isles Beach', lat: 25.94, lon: -80.12 };
  const set = { sideKm: 1, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1, baseMm: 3, seaFloorM: 0, depthStretch: 1, shoreMm: 0, shoreRidge: false, label: false, labelText: '', cornerMm: 10, shape: 'square', aspect: 2, bearing: 0, buildings: true, buildingDefaultM: 10, cols: 1, rows: 1 };
  const model = { zoom: 14, pixelM: 8.6, lowM: 0, highM: 4, reliefMm: 0.5, triangles: 5000,
    buildings: { count: 111, tagged: 59, inData: 1, tallestM: 203.4, readAt: '2026-10-16' } };
  const kml = core.printKml({ centre, set, model });
  assert.match(kml, /<Data name="buildingCount">.*<value>111<\/value>/);
  assert.match(kml, /<Data name="tallestBuildingM">.*<value>203<\/value>/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
});

test('the label says the centre, the ground covered and the stretch, and the depth stretch when it differs', () => {
  const centre = { lat: 44.27058, lon: -71.30333 };
  const set = { sideKm: 20, exaggeration: 1.5, seaFloorM: 0, depthStretch: 1.5, label: true };
  assert.deepEqual(core.labelLines(centre, set), { lines: ['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'], wrap: 0 });
  const { lines } = core.labelLines({ lat: -33.9, lon: 18.4 }, { ...set, seaFloorM: 1000, depthStretch: 4 });
  assert.deepEqual(lines.slice(0, 1).concat(lines.slice(3)), ['33.9000°S 18.4000°E', 'DEPTH ×4']);
});

test('the font has every character a label uses, and no outline pinches to a point', () => {
  const text = ['0123456789 .-:°×', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const { ink, w, h } = core.textInk(text);
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const [a, b, d, e] = [ink[r][c], ink[r][c + 1], ink[r + 1][c], ink[r + 1][c + 1]];
      assert.ok(!(a && e && !b && !d) && !(b && d && !a && !e), `pinch at row ${r}, column ${c}`);
    }
  }
  // an unknown character prints as a space, not a gap in the font
  assert.equal(core.textInk(['A~A']).w, core.textInk(['A A']).w);
});

test('the bottom label fits the model, mirrored to read from underneath', () => {
  const n = 21, w = 120;
  const zMm = new Array(n * n).fill(3);
  const lab = core.bottomLabel(['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'], zMm, n, w);
  assert.equal(lab.lines.length, 3);
  assert.ok(lab.pxMm >= 0.8 && lab.pxMm <= 1);
  assert.equal(lab.depthMm, core.LABEL_DEPTH_MM);
  // the box and its bed stay inside the model
  assert.ok(lab.mid - (lab.w / 2) * lab.cellMm > 0 && (lab.h / 2) * lab.cellMm < w / 2);
  // read from underneath, the text starts in the east: an L's stem is its left side, so on the model it is the east side
  const L = core.bottomLabel(['L'], zMm, n, w);
  const cellX = (c) => L.mid + (L.w / 2 - c - 0.5) * L.cellMm;
  const inked = [];
  L.ink.forEach((row, r) => row.forEach((v, c) => { if (v) inked.push({ r, c }); }));
  const stem = inked.filter((p) => p.r === inked[0].r).map((p) => cellX(p.c));
  const foot = inked.filter((p) => p.r === inked[inked.length - 1].r).map((p) => cellX(p.c));
  near(Math.max(...stem), Math.max(...foot), 1e-9); // the stem and the foot meet in the east
  assert.ok(Math.min(...foot) < Math.min(...stem)); // and the foot runs west
});

test('a label takes up to three lines of its own text, over the centre or alone', () => {
  const centre = { lat: 44.27058, lon: -71.30333 };
  const set = { sideKm: 20, exaggeration: 1.5, seaFloorM: 0, depthStretch: 1.5, label: true, labelText: '  our   first hike\r\n\nAug 2026\n' };
  assert.deepEqual(core.labelLines(centre, set), { lines: ['OUR FIRST HIKE', 'AUG 2026', '44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'], wrap: 2 });
  assert.deepEqual(core.labelLines(centre, { ...set, label: false }), { lines: ['OUR FIRST HIKE', 'AUG 2026'], wrap: null });
  assert.deepEqual(core.labelLines(centre, { ...set, label: false, labelText: '' }).lines, []);
  assert.deepEqual(core.customLines('a\nb\nc\nd'), ['A', 'B', 'C']);
  assert.equal(core.customLines('x'.repeat(40))[0].length, core.LABEL_TEXT_CHARS);
});

test('the font says which typed characters it lacks', () => {
  assert.deepEqual(core.unprintable("Dave's hike, 2026! (& more?)"), []);
  assert.deepEqual(core.unprintable('Café ~ café\n~'), ['É', '~']);
});

test('typed text keeps its lines, where the coordinates may wrap', () => {
  const n = 11, z = new Array(n * n).fill(3);
  const lines = ['SUMMIT OF MOUNT WASHINGTON', 'AUG 2026'];
  assert.deepEqual(core.bottomLabel(lines, z, n, 60, null, 0).lines, ['SUMMIT', 'OF', 'MOUNT', 'WASHINGTON', 'AUG 2026']);
  assert.deepEqual(core.bottomLabel(lines, z, n, 120, null, 0, null).lines, lines);
  // kept whole, a long line can be too long for a small model
  assert.match(core.bottomLabel(lines, z, n, 60, null, 0, null).why, /too small/);
  // under typed text, it is the coordinates that wrap
  const both = ['OUR HIKE', '44.2706°N 71.3033°W', '20 × 20 KM'];
  assert.deepEqual(core.bottomLabel(both, z, n, 60, null, 0, 1).lines, ['OUR HIKE', '44.2706°N', '71.3033°W', '20 × 20 KM']);
});

test('a small model takes the coordinates on two lines, a tiny one gets no label, nor a thin one', () => {
  const lines = ['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'];
  const n = 11;
  assert.equal(core.bottomLabel(lines, new Array(n * n).fill(3), n, 60).lines.length, 4);
  assert.match(core.bottomLabel(lines, new Array(n * n).fill(3), n, 30).why, /too small/);
  assert.match(core.bottomLabel(lines, new Array(n * n).fill(0.7), n, 120).why, /0.7 mm thick/);
  // a thinner model still takes a shallower label
  near(core.bottomLabel(lines, new Array(n * n).fill(1), n, 120).depthMm, 0.4, 1e-9);
});

test('a labelled print is still one closed solid, the letters cut up into its bottom', () => {
  const n = 9, w = 120;
  const zMm = Array.from({ length: n * n }, (_, k) => 3 + (k % 5) * 0.3);
  const lab = core.bottomLabel(['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5', 'DEPTH ×4'], zMm, n, w);
  const tris = core.readStl(core.terrainStl(zMm, n, w, [], lab));
  assert.ok(closedEdges(tris.map((t) => t.v)));
  // the pocket ceilings face down, at the label's depth
  const ceilings = tris.filter((t) => t.v.every((p) => Math.abs(p[2] - lab.depthMm) < 1e-6));
  assert.ok(ceilings.length > 0 && ceilings.every((t) => t.normal[2] < -0.99));
  assert.ok(tris.filter((t) => t.v.every((p) => p[2] === 0)).every((t) => t.normal[2] < -0.99));
  // and the bottom still covers the whole square: its area, less the letters, plus their ceilings
  const area = (t) => Math.abs((t.v[1][0] - t.v[0][0]) * (t.v[2][1] - t.v[0][1]) - (t.v[2][0] - t.v[0][0]) * (t.v[1][1] - t.v[0][1])) / 2;
  const flatDown = tris.filter((t) => t.normal[2] < -0.99).reduce((a, t) => a + area(t), 0);
  near(flatDown, w * w, 1e-2);
});

test('a print KML keeps the label setting and what was cut', () => {
  const centre = { name: 'Mount Washington', lat: 44.2706, lon: -71.3033 };
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1.5, baseMm: 3, seaFloorM: 0, depthStretch: 1.5, shoreMm: 0, shoreRidge: false, label: true, labelText: 'Our first hike\nAugust 2026 & <3', cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, cols: 1, rows: 1 };
  const label = { lines: ['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'], pxMm: 0.9, depthMm: 0.6 };
  const kml = core.printKml({ centre, set, model: { zoom: 12, pixelM: 27.8, lowM: 410, highM: 1916, reliefMm: 13.55, triangles: 1, label } });
  assert.match(kml, /<Data name="labelText">.*<value>44.2706°N 71.3033°W \/ 20 × 20 KM \/ VERTICAL ×1.5<\/value>/);
  assert.match(kml, /<Data name="labelLetterMm">.*<value>6.3<\/value>/);
  assert.deepEqual(core.parsePrintKml(kml).set, set);
});

test('roundCorner moves only the corner boxes, onto the arc', () => {
  const w = 100, r = 10;
  // the corner itself lands on the arc's middle
  const c = core.roundCorner([0, 0, 4], w, r);
  near(Math.hypot(c[0] - r, c[1] - r), r, 1e-9);
  near(c[0], c[1], 1e-9);
  assert.equal(c[2], 4);
  // every point of a box's outer sides lands on the arc, in every corner
  for (const [x, y] of [[0, 3], [7, 0], [100, 2], [95, 100], [0, 96]]) {
    const p = core.roundCorner([x, y, 0], w, r);
    const cx = x < r ? r : w - r, cy = y < r ? r : w - r;
    near(Math.hypot(p[0] - cx, p[1] - cy), r, 1e-9);
  }
  // the box's inner sides, and everything outside the boxes, stay put
  for (const p of [[10, 4, 1], [4, 10, 1], [50, 0, 1], [0, 50, 1], [50, 50, 1], [10, 10, 1]]) {
    assert.deepEqual(core.roundCorner(p, w, r), p);
  }
  // a point halfway along a ray moves half as far as the corner does
  const half = core.roundCorner([5, 5, 0], w, r);
  near(Math.hypot(half[0] - r, half[1] - r), r / 2, 1e-9);
});

test('a print with rounded corners is still one closed solid, inside the rounded square', () => {
  const n = 41, w = 120, r = 5;
  const zMm = Array.from({ length: n * n }, (_, k) => 3 + (k % 5) * 0.3);
  const lab = core.bottomLabel(['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'], zMm, n, w);
  const tris = core.readStl(core.terrainStl(zMm, n, w, [], lab, r));
  assert.ok(closedEdges(tris.map((t) => t.v)));
  // no point sticks out past an arc
  for (const t of tris) {
    for (const [x, y] of t.v) {
      const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), w - r);
      assert.ok(Math.hypot(x - cx, y - cy) <= r + 1e-4, `${x}, ${y} is outside the rounded square`);
    }
  }
  // the walls stay upright, and the bottom covers the square less its corners: a little less, as each
  // arc is a few chords at this grid, but well short of the square's 21.5 mm² more
  const walls = tris.filter((t) => Math.abs(t.normal[2]) < 1e-6);
  assert.ok(walls.length > 0);
  const area = (t) => Math.abs((t.v[1][0] - t.v[0][0]) * (t.v[2][1] - t.v[0][1]) - (t.v[2][0] - t.v[0][0]) * (t.v[1][1] - t.v[0][1])) / 2;
  const flatDown = tris.filter((t) => t.normal[2] < -0.99).reduce((a, t) => a + area(t), 0);
  near(flatDown, w * w - (4 - Math.PI) * r * r, 5);
  assert.ok(tris.filter((t) => t.v.every((p) => p[2] === 0)).every((t) => t.normal[2] < -0.99));
});

test('a print KML keeps the corner radius, and older files are square', () => {
  const set = { sideKm: 5, widthMm: 80, cells: 120, exaggeration: 2, baseMm: 2, cornerMm: 10 };
  const kml = core.printKml({ centre: { name: 'a', lat: 1, lon: 2 }, set });
  assert.equal(core.parsePrintKml(kml).set.cornerMm, 10);
  const old = kml.replace(/\s*<Data name="cornerMm">.*?<\/Data>/g, '');
  assert.equal(core.parsePrintKml(old).set.cornerMm, 0);
});
