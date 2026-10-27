import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// Tracks of your own, imported from KML.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

const kml = (placemarks) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>${placemarks}</Document></kml>`;

test('parseTrackKml reads LineStrings, MultiGeometry and gx:Tracks, one track a placemark', () => {
  const tracks = core.parseTrackKml(kml(`
    <Placemark><name>Tuckerman &amp; Lion Head</name><LineString><coordinates>
      -71.30,44.25,600 -71.29,44.26,900
      -71.28,44.27,1400
    </coordinates></LineString></Placemark>
    <Placemark><name><![CDATA[Two days]]></name><MultiGeometry>
      <LineString><coordinates>-71.3,44.2 -71.2,44.2</coordinates></LineString>
      <LineString><coordinates>-71.2,44.2 -71.2,44.3</coordinates></LineString>
    </MultiGeometry></Placemark>
    <Placemark><name>Summit</name><Point><coordinates>-71.3033,44.2706,1916</coordinates></Point></Placemark>
    <Placemark><gx:Track><when>2026-08-01T10:00:00Z</when><gx:coord>-71.1 44.1 500</gx:coord><gx:coord>-71.0 44.0 510</gx:coord></gx:Track></Placemark>`), 'hike');
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks[0], { name: 'Tuckerman & Lion Head', lines: [[[-71.3, 44.25], [-71.29, 44.26], [-71.28, 44.27]]], levelMm: undefined });
  assert.equal(tracks[1].name, 'Two days');
  assert.equal(tracks[1].lines.length, 2);
  // the point is no track; a lone unnamed one takes the file's name
  assert.deepEqual(tracks[2], { name: 'hike', lines: [[[-71.1, 44.1], [-71.0, 44.0]]], levelMm: undefined });
});

test('parseTrackKml numbers unnamed tracks and drops bad points and short lines', () => {
  const tracks = core.parseTrackKml(kml(`
    <Placemark><LineString><coordinates>-71,44 junk -71.1,44.1 -71.2,95</coordinates></LineString></Placemark>
    <Placemark><LineString><coordinates>-71,44</coordinates></LineString></Placemark>
    <Placemark><LineString><coordinates>-72,44 -72.1,44</coordinates></LineString></Placemark>`), 'ride');
  assert.deepEqual(tracks.map((t) => t.name), ['ride 1', 'ride 2']);
  assert.deepEqual(tracks[0].lines, [[[-71, 44], [-71.1, 44.1]]]);
  assert.deepEqual(core.parseTrackKml('<kml></kml>'), []);
});

test('trackKm is the length along every line of a track', () => {
  // a degree of latitude is about 111.2 km
  near(core.trackKm({ lines: [[[0, 0], [0, 0.5]], [[1, 0], [1, 0.5]]] }), 111.2, 0.2);
});

test('a print KML keeps each track, its line in full and its level', () => {
  const centre = { name: 'Mount Washington', lat: 44.2706, lon: -71.3033 };
  const tracks = [
    { name: 'Lion Head <winter>', lines: [[[-71.2851234, 44.2591234], [-71.2950001, 44.2650002]]], levelMm: 0.8 },
    { name: 'Gulfside', lines: [[[-71.31, 44.28], [-71.3, 44.29]], [[-71.3, 44.29], [-71.29, 44.3]]], levelMm: -1.2 },
  ];
  const set = { sideKm: 20, widthMm: 120, cells: 201, pitchMm: 0.6, exaggeration: 1.5, baseMm: 3, seaFloorM: 0, depthStretch: 1.5, shoreMm: 0, shoreRidge: false, label: false, labelText: '', balance: false, infillPercent: 15, cornerMm: 5, shape: 'square', aspect: 2, bearing: 0, buildings: false, buildingDefaultM: 7, roadMm: core.NO_ROADS, waterMm: core.NO_WATER, cols: 1, rows: 1, tracks, waters: [], bins: [], binClearMm: 0.4 };
  const text = core.printKml({ centre, set });
  assert.match(text, /<Style id="track">/);
  assert.match(text, /<Data name="tracks">.*<value>2<\/value>/);
  assert.deepEqual(core.parsePrintKml(text).set, set);
  // and the same file imports as tracks, without the print's own outline
  assert.deepEqual(core.parseTrackKml(text).map((t) => t.name), ['Lion Head <winter>', 'Gulfside']);
  // a file from before tracks has none
  const old = core.printKml({ centre, set: { ...set, tracks: [], bins: [], binClearMm: 0.4 } }).replace(/\s*<Data name="tracks">.*<\/Data>/, '');
  assert.deepEqual(core.parsePrintKml(old).set.tracks, []);
  assert.throws(() => core.parsePrintKml(text.replace('<value>-1.2</value>', '<value>40</value>')), /Gulfside/);
});

test('trackLines places the printed tracks on the model and cuts them to it', () => {
  const centre = { lat: 44.27, lon: -71.3 };
  const frame = core.printFrame(centre, 10, 100, 0);
  const across = [[-71.5, 44.27], [-71.1, 44.27]]; // runs off both sides
  const tracks = [{ lines: [across], levelMm: 0.8 }, { lines: [across], levelMm: 0 }, { lines: [[[-71.3, 44.27], [-71.3, 44.28]]], levelMm: -0.6 }];
  const ways = core.trackLines(tracks, { frame, widthMm: 100 });
  assert.deepEqual(ways.map((w) => [w.track, w.levelMm, w.widthMm, w.cls]), [[0, 0.8, core.TRACK_WIDTH_MM, 'track'], [2, -0.6, core.TRACK_WIDTH_MM, 'track']]);
  const [a, b] = [ways[0].line[0], ways[0].line.at(-1)];
  near(a[0], 0, 1e-6);
  near(b[0], 100, 1e-6);
  near(a[1], 50, 0.5);
});

test('a raised track stands at its own level and width, and a sunk one is cut into the ground', () => {
  const n = 41, widthMm = 40, flat = new Array(n * n).fill(5);
  const line = [[5, 20], [35, 20]];
  const raised = core.roadTriangles([{ cls: 'track', line, levelMm: 1.6, widthMm: 2 }], flat, n, { widthMm, mmPerMetre: 0.01 });
  assert.ok(raised.length > 0);
  near(Math.max(...raised.map((p) => p[2])), 6.6, 1e-9);
  near(Math.max(...raised.map((p) => p[1])) - Math.min(...raised.map((p) => p[1])), 2, 1e-9);
  // a sunk track makes no solid, and a raised one cuts nothing
  assert.equal(core.roadTriangles([{ cls: 'track', line, levelMm: -0.8, widthMm: 2 }], flat, n, { widthMm, mmPerMetre: 0.01 }).length, 0);
  assert.equal(core.carveRoads(flat, [{ cls: 'track', line, levelMm: 0.8, widthMm: 2 }], n, { widthMm, mmPerMetre: 0.01 }).mask.reduce((s, v) => s + v, 0), 0);
  const { mm, mask } = core.carveRoads(flat, [{ cls: 'track', line, levelMm: -0.8, widthMm: 2 }], n, { widthMm, mmPerMetre: 0.01 });
  const mid = 20 * n + 20; // the grid point on the line, halfway along
  near(mm[mid], 4.2, 1e-9);
  assert.equal(mask[mid], 1);
  assert.equal(mm[10 * n + 20], 5);
});
