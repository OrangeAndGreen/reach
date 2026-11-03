import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

// The bridge test print: one bridge per span, side by side.

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

test('the bridge test has a bridge for each span, shortest first, counted by dots', () => {
  const { rungs } = core.bridgeLadder({ spansMm: [25, 10, 30, 15, 20] });
  assert.deepEqual(rungs.map((r) => r.spanMm), [10, 15, 20, 25, 30]);
  assert.deepEqual(rungs.map((r) => r.dots), [1, 2, 3, 4, 5]);
  assert.deepEqual(core.BRIDGE_LADDER_SPANS_MM, [10, 15, 20, 25, 30]);
});

test("each bridge's open span measures its length, between piers PIER_MM long", () => {
  const { solids, rungs } = core.bridgeLadder();
  for (const r of rungs) {
    near(r.x1 - r.x0, r.spanMm);
    const y = (r.y0 + r.y1) / 2;
    const z = (1 + r.underMm) / 2; // between the plate and the deck
    // just inside each end and in the middle, the span is open; just outside, it is pier
    for (const x of [r.x0 + 0.05, (r.x0 + r.x1) / 2, r.x1 - 0.05]) assert.equal(solidAt(solids, x, y, z), false, `open at ${x}`);
    for (const x of [r.x0 - 0.05, r.x0 - core.PIER_MM + 0.05, r.x1 + 0.05, r.x1 + core.PIER_MM - 0.05]) assert.equal(solidAt(solids, x, y, z), true, `pier at ${x}`);
    // and past the piers, nothing stands on the plate
    for (const x of [r.x0 - core.PIER_MM - 0.05, r.x1 + core.PIER_MM + 0.05]) assert.equal(solidAt(solids, x, y, z), false, `clear at ${x}`);
    assert.equal(solidAt(solids, r.x0 + 0.05, y, 0.5), true, 'plate under the span');
  }
});

test('the deck is BRIDGE_DECK_MM thick and the road width wide, by default', () => {
  const { solids, rungs } = core.bridgeLadder();
  for (const r of rungs) {
    near(r.topMm - r.underMm, core.BRIDGE_DECK_MM, 1e-9);
    near(r.y1 - r.y0, core.ROAD_CLASSES.motorway.widthMm);
    const mid = (r.x0 + r.x1) / 2, y = (r.y0 + r.y1) / 2;
    // up through the middle of the span: open, then deck from underMm to topMm, then open
    assert.equal(solidAt(solids, mid, y, r.underMm - 0.01), false);
    assert.equal(solidAt(solids, mid, y, r.underMm + 0.01), true);
    assert.equal(solidAt(solids, mid, y, r.topMm - 0.01), true);
    assert.equal(solidAt(solids, mid, y, r.topMm + 0.01), false);
    for (const side of [r.y0 - 0.05, r.y1 + 0.05]) assert.equal(solidAt(solids, mid, side, (r.underMm + r.topMm) / 2), false, 'nothing beside the deck');
  }
  const thick = core.bridgeLadder({ deckMm: 1, widthMm: 2 }).rungs[0];
  near(thick.topMm - thick.underMm, 1);
  near(thick.y1 - thick.y0, 2);
});

test('the bridges sit apart, inside the plate', () => {
  const { rungs, sizeMm } = core.bridgeLadder();
  for (let k = 1; k < rungs.length; k++) assert.ok(rungs[k].y0 > rungs[k - 1].y1 + 1, 'bridges apart');
  for (const r of rungs) {
    assert.ok(r.y0 > 0 && r.y1 < sizeMm[1]);
    assert.ok(r.x0 - core.PIER_MM > 0 && r.x1 + core.PIER_MM < sizeMm[0]);
  }
  near(sizeMm[2], rungs[0].topMm);
});

test('every part of the bridge test is a closed solid, right side out, and writes to an STL', () => {
  const { solids } = core.bridgeLadder();
  assert.equal(solids.length, 1 + 5 + (1 + 2 + 3 + 4 + 5)); // plate, bridges, dots
  for (const s of solids) {
    assert.ok(core.isClosed(s));
    assert.ok(volume(s) > 0);
  }
  const tris = solids.flat();
  const back = core.readStl(core.writeStl(tris));
  assert.equal(back.length, tris.length / 3);
});
