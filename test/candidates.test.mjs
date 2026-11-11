import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// The Print candidates menu: places worth printing, each at the size it suits.

const all = Object.entries(core.PRINT_CANDIDATES);

test('the candidate list holds the four to try first, at their sizes', () => {
  const at = (name) => all.find(([, c]) => c.name.startsWith(name))?.[1];
  assert.equal(at('Meteor Crater').sideKm, 2);
  assert.equal(at('Monterey').sideKm, 80);
  assert.equal(at('Monterey').kind, 'sea');
  assert.equal(at('Pittsburgh').sideKm, 1);
  assert.equal(at('Pittsburgh').kind, 'buildings');
  assert.equal(at('Kaikoura').sideKm, 40);
});

test('every candidate is a place Print can make', () => {
  for (const [key, c] of all) {
    assert.ok(c.name && c.note, key);
    assert.ok(c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180, `${key} is on the globe`);
    assert.ok(c.sideKm >= core.SIDE_MIN_KM && c.sideKm <= core.SIDE_MAX_KM, `${key} is a size Print takes`);
    assert.ok(c.kind in core.CANDIDATE_KINDS, `${key} has a kind the menu groups`);
    if (c.stretch != null) assert.ok(core.STRETCH_STOPS.includes(c.stretch), `${key}'s stretch is a slider stop`);
    // buildings need a small print; the sea floor is zoom 10 only, so it wants 20 km and up
    if (c.kind === 'buildings') assert.ok(c.sideKm <= core.BUILDINGS_MAX_KM, `${key} is small enough for buildings`);
    if (c.kind === 'sea') assert.ok(c.sideKm >= 20, `${key} is big enough for the sea floor to show`);
  }
});

test('candidate names are distinct', () => {
  const names = all.map(([, c]) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test('a land candidate sets the centre and size, with the sea cut and no buildings', () => {
  const c = core.PRINT_CANDIDATES.meteor;
  assert.deepEqual(core.candidateSettings(c), {
    centre: { name: c.name, lat: c.lat, lon: c.lon },
    sideKm: 2,
    seaFloorM: 0,
    buildings: false,
    exaggeration: null,
  });
});

test('a sea candidate prints the sea floor to full depth', () => {
  const s = core.candidateSettings(core.PRINT_CANDIDATES.monterey);
  assert.equal(s.sideKm, 80);
  assert.equal(s.seaFloorM, core.CANDIDATE_SEA_FLOOR_M);
  assert.equal(s.buildings, false);
});

test('a buildings candidate turns buildings on', () => {
  const s = core.candidateSettings(core.PRINT_CANDIDATES.pittsburgh);
  assert.equal(s.sideKm, 1);
  assert.equal(s.buildings, true);
  assert.equal(s.seaFloorM, 0);
});

test('a candidate that names a stretch sets it, and the others leave it alone', () => {
  assert.equal(core.candidateSettings(core.PRINT_CANDIDATES.fuji).exaggeration, 1);
  assert.equal(core.candidateSettings(core.PRINT_CANDIDATES.rainier).exaggeration, null);
});

test('the centre a candidate sets is a fresh place, like a search result', () => {
  const c = core.PRINT_CANDIDATES.chicago;
  const s = core.candidateSettings(c);
  assert.deepEqual(Object.keys(s.centre), ['name', 'lat', 'lon']);
  s.centre.lat = 0;
  assert.notEqual(c.lat, 0);
});
