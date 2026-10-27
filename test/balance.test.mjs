import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// A notch cut up into the underside at the centre of mass, to balance a print on a pencil.

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

/** The volume a closed mesh holds, by the divergence theorem: negative if it is inside out. */
const volume = (tris) => core.massMoments([tris]).volume;
const stlTris = (buf) => core.readStl(buf).flatMap((t) => t.v);

/** A grid sloping up to the east, from lo mm on the west edge to hi on the east. */
const ramp = (n, lo, hi) => Array.from({ length: n * n }, (_, k) => lo + ((hi - lo) * (k % n)) / (n - 1));

test('the moments of a box give its volume, centre and surface', () => {
  const n = 11, w = 20;
  const tris = stlTris(core.terrainStl(new Array(n * n).fill(5), n, w));
  const m = core.massMoments([tris]);
  near(m.volume, 20 * 20 * 5, 1e-6);
  near(m.vx / m.volume, 10, 1e-6);
  near(m.vz / m.volume, 2.5, 1e-6);
  near(m.area, 2 * 400 + 4 * 100, 1e-6);
  // solid, the centre of volume; hollow, the shell's middle, which for a box is the same
  const solid = core.centreOfMass(m, 1);
  near(solid.x, 10, 1e-6); near(solid.y, 10, 1e-6); near(solid.z, 2.5, 1e-6);
  near(core.centreOfMass(m, 0.15).z, 2.5, 1e-6);
});

test('with little infill the weight sits nearer the middle of the footprint than the volume does', () => {
  const n = 41, w = 100;
  const tris = stlTris(core.terrainStl(ramp(n, 2, 20), n, w));
  const m = core.massMoments([tris]);
  const full = core.centreOfMass(m, 1), light = core.centreOfMass(m, 0.15);
  // a wedge 2 to 20 mm: its volume centres east of the middle
  near(full.x, (100 * (2 * 50 + 18 * (2 / 3) * 50)) / (2 * 100 + 18 * 50), 0.01);
  assert.ok(light.x > 50 && light.x < full.x, `${light.x} not between 50 and ${full.x}`);
});

test('a bottom left out of the moments adds its area with withBottom', () => {
  const n = 11, w = 20;
  const z = new Array(n * n).fill(5);
  let got = null;
  core.terrainStl(z, n, w, [], (m) => { got = m; return {}; });
  const whole = core.massMoments([stlTris(core.terrainStl(z, n, w))]);
  for (const k of Object.keys(whole)) near(got[k], whole[k], 1e-6);
});

test('the notch goes as deep as the roof allows, up to 2 mm over the centre of mass', () => {
  const n = 61, w = 60, z = new Array(n * n).fill(10);
  const deep = core.balanceNotch({ x: 30, y: 30, z: 5 }, z, n, w);
  near(deep.depthMm, 7, 1e-9);
  near(deep.aboveMm, 2, 1e-9);
  near(deep.r, 7 * Math.tan((30 * Math.PI) / 180), 1e-9);
  // 6 mm thick: the tip stops 1.2 mm under the top, under the centre of mass
  const thin = core.balanceNotch({ x: 30, y: 30, z: 5 }, new Array(n * n).fill(6), n, w);
  near(thin.depthMm, 4.8, 1e-9);
  assert.ok(thin.aboveMm < 0);
  assert.match(core.balanceNotch({ x: 30, y: 30, z: 1 }, new Array(n * n).fill(3), n, w).why, /only 3.0 mm thick/);
  assert.match(core.balanceNotch({ x: 1, y: 30, z: 3 }, z, n, w).why, /too near the edge/);
  assert.match(core.balanceNotch({ x: 30, y: 30, z: 3 }, z, n, w, { ring: [[40, 40], [50, 40], [50, 50]] }).why, /off the print/);
});

test('a bin over the notch thins the roof to its floor', () => {
  const n = 61, w = 60, z = new Array(n * n).fill(10);
  const bin = { ring: [[25, 25], [35, 25], [35, 35], [25, 35]], floorMm: 5 };
  near(core.balanceNotch({ x: 30, y: 30, z: 5 }, z, n, w, { bins: [bin] }).depthMm, 3.8, 1e-9);
});

test('a notched square is closed and holds less by the cone', () => {
  const n = 41, w = 80, z = new Array(n * n).fill(10);
  const notch = core.balanceNotch({ x: 40, y: 40, z: 5 }, z, n, w);
  const tris = stlTris(core.terrainStl(z, n, w, [], () => ({ notch }), 5));
  assert.ok(core.isClosed(tris));
  // a 48-sided cone, within a percent of a round one
  const cone = (Math.PI * notch.r ** 2 * notch.depthMm) / 3;
  near(volume(stlTris(core.terrainStl(z, n, w, [], null, 5))) - volume(tris), cone, 0.01 * cone);
  // the notch's tip is the highest point on the bottom
  const bottom = tris.filter(([x, y, h]) => h < 10 && Math.hypot(x - 40, y - 40) <= notch.r + 1e-6);
  near(Math.max(...bottom.map((p) => p[2])), notch.depthMm, 1e-5);
});

test('the label moves off the notch and both cut into a closed print', () => {
  const n = 61, w = 120, z = new Array(n * n).fill(10);
  const lines = ['44.2706°N 71.3033°W', '20 × 20 KM', 'VERTICAL ×1.5'];
  const notch = core.balanceNotch({ x: 60, y: 60, z: 5 }, z, n, w);
  const lab = core.bottomLabel(lines, z, n, w, null, 0, null, notch);
  assert.ok(!lab.why, lab.why);
  const hw = (lab.w / 2) * lab.cellMm, hh = (lab.h / 2) * lab.cellMm;
  const gap = Math.hypot(Math.max(0, Math.abs(lab.mid - 60) - hw), Math.max(0, Math.abs(lab.midY - 60) - hh));
  assert.ok(gap >= notch.r, `the label is ${gap} mm from the notch's middle, inside its ${notch.r} mm rim`);
  assert.ok(lab.pxMm <= core.bottomLabel(lines, z, n, w, null, 0).pxMm);
  assert.ok(core.isClosed(stlTris(core.terrainStl(z, n, w, [], () => ({ label: lab, notch })))));
  // a shape too, notch and label both inside the outline
  for (const shape of ['circle', 'hexagon', 'triangle', 'star', 'rectangle']) {
    const outline = core.shapeOutline(shape, w, { aspect: 2, cornerMm: 5 });
    const grid = core.shapeCells(outline.ring, n, w);
    const { tris } = core.shapeMesh(z, grid, [], (m) => {
      const mass = core.centreOfMass(m, 0.15);
      const cut = core.balanceNotch(mass, z, n, w, { ring: grid.ring });
      assert.ok(!cut.why, `${shape}: ${cut.why}`);
      near(mass.x, outline.centre[0], shape === 'triangle' ? 0.5 : 0.01);
      const label = core.bottomLabel(lines.slice(0, 2), z, n, w, outline, null, null, cut);
      assert.ok(!label.why, `${shape}: ${label.why}`);
      return { label, notch: cut };
    });
    assert.ok(core.isClosed(tris), `notched ${shape} is open`);
  }
});
