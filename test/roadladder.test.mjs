import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// The road width test print: one raised line per road class, side by side.

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

/** The volume a closed mesh holds: negative if it is inside out. */
const volume = (tris) => core.massMoments([tris]).volume;

/** The flat faces of tris over x, y: where a probe straight up or down meets them (every face here is flat or upright). */
const facesAt = (tris, x, y) => {
  const zs = [];
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    if (a[2] !== b[2] || b[2] !== c[2]) continue;
    const s = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) zs.push(a[2]);
  }
  return [...new Set(zs)];
};

/** Whether x, y, z is inside any of the solids: a ray straight up crosses an odd number of a solid's faces. */
const solidAt = (solids, x, y, z) => solids.some((tris) => facesAt(tris, x, y).filter((f) => f > z).length % 2 === 1);

const classes = Object.keys(core.ROAD_CLASSES);

test('the road width test has a line for each road class, narrowest first, counted by dots', () => {
  const { rungs } = core.roadLadder();
  assert.equal(rungs.length, classes.length);
  assert.deepEqual([...rungs.map((r) => r.cls)].sort(), [...classes].sort());
  for (let k = 1; k < rungs.length; k++) assert.ok(rungs[k].widthMm >= rungs[k - 1].widthMm, 'narrow to wide');
  assert.deepEqual(rungs.map((r) => r.dots), rungs.map((_, k) => k + 1));
  // with today's classes: secondary, primary, trunk, motorway
  assert.deepEqual(rungs.map((r) => r.cls), ['secondary', 'primary', 'trunk', 'motorway']);
});

test("each line is its road class's width and lift, read from ROAD_CLASSES", () => {
  const { solids, rungs } = core.roadLadder();
  for (const r of rungs) {
    const c = core.ROAD_CLASSES[r.cls];
    near(r.y1 - r.y0, c.widthMm);
    near(r.topMm - 1, c.liftMm); // over the 1 mm plate
    assert.equal(r.widthMm, c.widthMm);
    assert.equal(r.liftMm, c.liftMm);
    const x = (r.x0 + r.x1) / 2, y = (r.y0 + r.y1) / 2;
    // up through the middle of the line: solid to its top, open above
    assert.equal(solidAt(solids, x, y, r.topMm - 0.01), true);
    assert.equal(solidAt(solids, x, y, r.topMm + 0.01), false);
    // just beside it, only the plate
    for (const side of [r.y0 - 0.05, r.y1 + 0.05]) {
      assert.equal(solidAt(solids, x, side, 1.05), false, `nothing beside the ${r.cls} line`);
      assert.equal(solidAt(solids, x, side, 0.5), true, 'plate beside the line');
    }
    // and past its ends
    for (const end of [r.x0 - 0.05, r.x1 + 0.05]) assert.equal(solidAt(solids, end, y, 1.05), false, 'nothing past the ends');
  }
});

test('the lines follow other classes given in', () => {
  const { rungs } = core.roadLadder({ classes: { b: { widthMm: 2, liftMm: 1 }, a: { widthMm: 0.4, liftMm: 0.2 } }, lengthMm: 10 });
  assert.deepEqual(rungs.map((r) => r.cls), ['a', 'b']);
  near(rungs[0].y1 - rungs[0].y0, 0.4);
  near(rungs[1].topMm, 2);
  near(rungs[0].x1 - rungs[0].x0, 10);
});

test('the lines sit apart, inside the plate', () => {
  const { rungs, sizeMm } = core.roadLadder();
  for (let k = 1; k < rungs.length; k++) assert.ok(rungs[k].y0 > rungs[k - 1].y1 + 1, 'lines apart');
  for (const r of rungs) {
    assert.ok(r.y0 > 0 && r.y1 < sizeMm[1]);
    assert.ok(r.x0 > 0 && r.x1 < sizeMm[0]);
  }
  near(sizeMm[2], Math.max(...rungs.map((r) => r.topMm)));
});

test('every part of the road width test is a closed solid, right side out, and writes to an STL', () => {
  const { solids } = core.roadLadder();
  const n = classes.length;
  assert.equal(solids.length, 1 + n + (n * (n + 1)) / 2); // plate, lines, dots
  for (const s of solids) {
    assert.ok(core.isClosed(s));
    assert.ok(volume(s) > 0);
  }
  const tris = solids.flat();
  const back = core.readStl(core.writeStl(tris));
  assert.equal(back.length, tris.length / 3);
});
