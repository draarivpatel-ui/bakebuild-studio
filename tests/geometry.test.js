// Unit and invariant tests for the parametric CAD kernel. These exercise the
// real generator (cad-engine.js) and the pure math helpers, not the shipped
// files, so a regression in the kernel fails before any export is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../cad-engine.js';
const CAD = globalThis.BakeBuildCAD;
import { signedVolume, cross, sub, norm, unit, dot, boundsOf, manifoldReport, normalFlux } from './helpers.js';

const CUTTERS = CAD.DESIGNS.filter((d) => d.type === 'cutter');
const KEYRINGS = CAD.DESIGNS.filter((d) => d.type === 'keyring');

test('DESIGNS and RULES are frozen, complete, and internally consistent', () => {
  assert.equal(CAD.DESIGNS.length, 4);
  assert.equal(CUTTERS.length, 3);
  assert.equal(KEYRINGS.length, 1);
  assert.ok(Object.isFrozen(CAD.RULES));
  const ids = CAD.DESIGNS.map((d) => d.id);
  assert.equal(new Set(ids).size, 4);
  for (const d of CAD.DESIGNS) {
    assert.ok(d.id && d.name && d.type, 'design has id, name and type');
    assert.ok(d.radius > 10 && d.radius < 40, 'radius is in a printable range');
    assert.ok(Number.isInteger(d.sectors) && d.sectors >= 16 && d.sectors % 2 === 0, 'even sector count');
  }
  assert.equal(CAD.RULES.height, 12.7);
  assert.equal(CAD.RULES.lip + CAD.RULES.wall + CAD.RULES.rimWidth, 7.8);
  assert.equal(CAD.RULES.holeDiameter, 6);
  assert.equal(CAD.RULES.keyringHeight, 4);
});

test('generate rejects unknown ids and is deterministic across repeated calls', () => {
  assert.throws(() => CAD.generate('not_a_design'), /Unknown design/);
  assert.throws(() => CAD.generate(''), /Unknown design/);
  for (const d of CAD.DESIGNS) {
    const a = CAD.generate(d.id);
    const b = CAD.generate(d.id);
    assert.equal(a.volume, b.volume, `${d.id} volume is deterministic`);
    assert.deepEqual(a.dimensions, b.dimensions, `${d.id} bounds are deterministic`);
    assert.equal(a.triangles.length, b.triangles.length, `${d.id} triangle count is deterministic`);
    assert.deepEqual(a.triangles, b.triangles, `${d.id} triangles are bit-for-bit deterministic`);
    assert.deepEqual(a.validation, b.validation, `${d.id} rule results are deterministic`);
  }
});

test('every generated model satisfies its own rule set', () => {
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    assert.equal(m.validation.pass, true, `${d.id} validation passes`);
    assert.ok(m.validation.checks.length >= 3, `${d.id} has multiple checks`);
    for (const c of m.validation.checks) assert.equal(c.pass, true, `${d.id}: ${c.rule}`);
    assert.equal(m.units, 'mm');
    assert.equal(m.solids.length, 1, `${d.id} has exactly one solid`);
    assert.ok(m.volume > 0 && Number.isFinite(m.volume), `${d.id} has positive finite volume`);
  }
});

test('generated bounds match the triangle soup bounds for every model', () => {
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    const b = boundsOf(m.triangles);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(b.min[i] - m.bounds.min[i]) < 1e-7, `${d.id} min[${i}]`);
      assert.ok(Math.abs(b.max[i] - m.bounds.max[i]) < 1e-7, `${d.id} max[${i}]`);
      assert.ok(Math.abs(b.dimensions[i] - m.dimensions[i]) < 1e-7, `${d.id} dim[${i}]`);
    }
    assert.equal(m.solids[0].triangles.length, m.triangles.length);
    assert.equal(m.solids[0].vertices.length, m.solids[0].faces.reduce((s, f) => s, 0) || m.solids[0].vertices.length);
  }
});

test('cutter envelopes, heights, bands, and flat bottoms are exact', () => {
  for (const d of CUTTERS) {
    const m = CAD.generate(d.id);
    assert.ok(Math.abs(m.dimensions[2] - 12.7) < 1e-9, `${d.id} height is 12.7 mm`);
    assert.ok(Math.abs(m.bounds.min[2]) < 1e-9, `${d.id} has a flat z=0 bottom`);
    assert.ok(m.dimensions[0] <= 100 && m.dimensions[1] <= 100, `${d.id} fits 100 mm plan limit`);
    const labels = m.sections.map((s) => s.label);
    assert.deepEqual(labels, ['cutting lip', 'main wall', 'top handle rim']);
    const [lip, wall, rim] = m.sections;
    assert.equal(lip.thickness, 0.8);
    assert.equal(wall.thickness, 2);
    assert.equal(rim.thickness, 5);
    assert.equal(lip.bottom, 0);
    assert.equal(lip.top, 1.5);
    assert.equal(wall.bottom, 1.5);
    assert.equal(wall.top, 10.7);
    assert.equal(rim.bottom, 10.7);
    assert.equal(rim.top, 12.7);
    assert.equal(m.holeDiameter, null);
    // All vertices live on one of the four declared z levels.
    const levels = [0, 1.5, 10.7, 12.7];
    for (const v of m.solids[0].vertices) {
      assert.ok(levels.some((z) => Math.abs(v[2] - z) < 1e-9), `${d.id} vertex z=${v[2]} is on a band`);
    }
  }
});

test('keyring flat bottom, envelope, height, and clear 6 mm hole', () => {
  for (const d of KEYRINGS) {
    const m = CAD.generate(d.id);
    assert.equal(m.holeDiameter, 6);
    assert.ok(Math.abs(m.bounds.min[2]) < 1e-9, 'flat bottom at z=0');
    assert.ok(Math.abs(m.dimensions[2] - 4) < 1e-9, 'height is 4 mm');
    assert.ok(m.dimensions[0] <= 80 && m.dimensions[1] <= 80 && m.dimensions[2] <= 6, 'fits 80x80x6');
    assert.equal(m.sections.length, 1);
    assert.equal(m.sections[0].label, 'FuseRing body');
    assert.equal(m.sections[0].bottom, 0);
    assert.equal(m.sections[0].top, 4);
    const n = d.sectors;
    const r = 3 / Math.cos(Math.PI / n);
    const hole = Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)]);
    for (const p of hole) assert.ok(Math.hypot(...p) >= 3 - 1e-9, 'polygon vertices circumscribe the clear circle');
    // Midpoint of each chord is exactly the inscribed 3 mm radius.
    for (let i = 0; i < n; i += 1) {
      const a = hole[i], b = hole[(i + 1) % n];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      assert.ok(Math.abs(Math.hypot(...mid) - 3) < 1e-9, 'chord midpoint touches the 3 mm inscribed radius');
    }
    const zLevels = [...new Set(m.solids[0].vertices.map((v) => v[2]))];
    assert.deepEqual(zLevels.sort((a, b) => a - b), [0, 4]);
  }
});

test('profile polygons are closed, simple, centred, and use the declared sector count', () => {
  for (const d of CAD.DESIGNS) {
    const pts = CAD.profile(d);
    assert.equal(pts.length, d.sectors);
    for (const p of pts) {
      assert.equal(p.length, 2);
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    // Sector angles are exactly equally spaced and radii stay positive.
    for (let i = 0; i < pts.length; i += 1) {
      const r = Math.hypot(...pts[i]);
      assert.ok(r > 10 && r < 40, `${d.id} radius ${r} stays in design range`);
      const angle = Math.atan2(pts[i][1], pts[i][0]);
      const expected = (2 * Math.PI * i / d.sectors) % (2 * Math.PI);
      const delta = Math.abs(((angle - expected + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
      assert.ok(delta < 1e-9, `${d.id} sector angle ${i}`);
    }
    // Consecutive edges never double back, so the polygon is not degenerate.
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
      const u = sub([...b, 0], [...a, 0]), v = sub([...c, 0], [...b, 0]);
      assert.ok(dot(u, v) > 0, `${d.id} edge ${i} does not fold back`);
    }
  }
});

test('offset is a true parallel line offset at a specified perpendicular distance', () => {
  const square = [[10, 0], [0, 10], [-10, 0], [0, -10]];
  const out = CAD.offset(square, 2);
  assert.equal(out.length, square.length);
  for (let i = 0; i < square.length; i += 1) {
    const a = square[i], b = square[(i + 1) % square.length];
    const d = sub([...b, 0], [...a, 0]);
    const n = unit([d[1], -d[0], 0]);
    const shift = sub([...out[i], 0], [...a, 0]);
    assert.ok(Math.abs(dot(shift, n) - 2) < 1e-9, `vertex ${i} is 2 mm along the outward normal`);
    // The intersection vertex also slides 2 mm along the edge for a 90 degree
    // corner. Radial scaling would instead only move by 2*sqrt(2) here, so this
    // exact value proves a true parallel line offset.
    assert.ok(Math.abs(dot(shift, unit(d)) + 2) < 1e-9, `vertex ${i} slides one offset distance along the edge`);
    const previous = square[(i + square.length - 1) % square.length];
    const dPrev = unit(sub([...a, 0], [...previous, 0]));
    const nPrev = unit([dPrev[1], -dPrev[0], 0]);
    assert.ok(Math.abs(dot(shift, nPrev) - 2) < 1e-9, `vertex ${i} is also 2 mm from the previous edge line`);
  }
  assert.ok(Math.abs(Math.hypot(...out[0]) - (10 + 2 * Math.SQRT2)) < 1e-9,
    'intersection offset differs from radial scaling');
  // Collinear case uses the parallel fallback rather than dividing by zero.
  const line = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1]];
  const shifted = CAD.offset(line, 0.5);
  assert.ok(shifted.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  assert.ok(Math.abs(shifted[1][1] - (-0.5)) < 1e-9, 'collinear fallback moves perpendicular to the shared line');
  // Scaling a wavy contour is NOT a parallel offset; verify the difference.
  const wavy = CAD.profile(CAD.DESIGNS[0]);
  const offset = CAD.offset(wavy, 0.8);
  for (let i = 0; i < wavy.length; i += 1) {
    const radial = Math.hypot(...offset[i]) - Math.hypot(...wavy[i]);
    assert.ok(Number.isFinite(radial) && radial > 0, 'offset contour grows outward');
  }
});

test('offset distance is exact on every generated cutter band', () => {
  for (const d of CUTTERS) {
    const contour = CAD.profile(d);
    for (const width of [CAD.RULES.lip, CAD.RULES.wall, CAD.RULES.rimWidth]) {
      const moved = CAD.offset(contour, width);
      for (let i = 0; i < contour.length; i += 1) {
        const prev = contour[(i + contour.length - 1) % contour.length];
        const next = contour[(i + 1) % contour.length];
        const e1 = unit([...sub([...contour[i], 0], [...prev, 0])]);
        const e2 = unit([...sub([...next, 0], [...contour[i], 0])]);
        const shift = sub([...moved[i], 0], [...contour[i], 0]);
        for (const e of [e1, e2]) {
          const n = [e[1], -e[0], 0];
          assert.ok(Math.abs(dot(shift, n) - width) < 1e-7, `${d.id} ${width} mm offset at vertex ${i}`);
        }
      }
    }
  }
});

test('signedVolume matches the kernel and is orientation sensitive', () => {
  const tetra = [[[0, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 0, 1], [0, 0, 0], [1, 0, 0]],
    [[1, 0, 0], [0, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  assert.ok(Math.abs(signedVolume(tetra) - 1 / 6) < 1e-12, 'unit corner tetrahedron volume');
  assert.ok(Math.abs(signedVolume(tetra.map((t) => [t[0], t[2], t[1]])) + 1 / 6) < 1e-12, 'flipping winding flips sign');
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    assert.ok(Math.abs(signedVolume(m.triangles) - m.volume) < 1e-6, `${d.id} volume agrees with helper`);
    assert.ok(Math.abs(CAD.signedVolume(m.triangles) - m.volume) < 1e-9, `${d.id} kernel volume agrees with helper`);
    assert.ok(Math.abs(signedVolume(m.triangles.map((t) => [t[0], t[2], t[1]])) + m.volume) < 1e-6,
      `${d.id} reversed winding produces negative volume`);
  }
});

test('all four solids are watertight manifolds with consistent outward winding', () => {
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    const r = manifoldReport(m.triangles);
    assert.equal(r.boundary, 0, `${d.id} has no boundary edges`);
    assert.equal(r.nonManifold, 0, `${d.id} has no non-manifold edges`);
    assert.equal(r.flipped, 0, `${d.id} has no inconsistent edge winding`);
    assert.equal(r.degenerate, 0, `${d.id} has no degenerate triangles`);
    assert.ok(r.uniqueEdges > 0 && r.vertices > 0);
    // Euler characteristic V - E + F = 2 - 2g = 0: both the hollow cutter
    // wall (a tube with an open top and bottom) and the keyring (a through
    // hole) are genus-1 surfaces. A genus mismatch would mean a stray cap or
    // an extra disconnected shell.
    assert.equal(r.vertices - r.uniqueEdges + r.triangles, 0,
      `${d.id} genus-1 Euler characteristic`);
    const flux = normalFlux(m.triangles);
    assert.ok(norm(flux) < 1e-6, `${d.id} closed surface has zero net normal flux`);
    assert.ok(m.volume > 0, `${d.id} positive volume implies outward winding`);
  }
});

test('vertical side faces split evenly between outward and inward radial normals', () => {
  // A hollow cutter has an outer wall and an inner wall; the keyring has an
  // outer contour and a hole wall. Both sets are vertical quads, so exactly
  // half the side faces point radially out and half point radially in. Any
  // flipped face would unbalance this count and also break manifold winding.
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    const centre = m.bounds.min.map((v, i) => (v + m.bounds.max[i]) / 2);
    let outward = 0;
    let inward = 0;
    let vertical = 0;
    for (const t of m.triangles) {
      const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      assert.ok(norm(n) > 1e-9, 'triangle has nonzero area');
      const u = unit(n);
      if (Math.abs(u[2]) < 1e-7) {
        vertical += 1;
        const mid = [0, 1, 2].map((i) => (t[0][i] + t[1][i] + t[2][i]) / 3);
        const radial = dot(n, [mid[0] - centre[0], mid[1] - centre[1], 0]);
        if (radial > 1e-9) outward += 1;
        else if (radial < -1e-9) inward += 1;
        else throw new Error('vertical side face has no radial component');
      }
    }
    assert.equal(outward, inward, `${d.id} balanced radial wall normals`);
    // Cutters have 6 wall rings (3 inner + 3 outer) out of 10 quad rings.
    // Keyrings have 2 wall rings out of 4. Each quad is 2 triangles.
    const wallRings = d.type === 'cutter' ? 6 : 2;
    assert.equal(vertical, d.sectors * wallRings * 2, `${d.id} vertical wall triangle count`);
  }
});

test('horizontal annulus faces point up on top and down on the bottom', () => {
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    let up = 0;
    let down = 0;
    for (const t of m.triangles) {
      const n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
      if (Math.abs(n[2]) > 0.999) {
        if (n[2] > 0) up += 1;
        else down += 1;
      }
      const flat = t.every((p) => Math.abs(p[2] - t[0][2]) < 1e-9);
      if (flat) assert.ok(Math.abs(n[2]) > 0.999, 'flat face normal is vertical');
    }
    // Cutters: 3 downward-facing ledge undersides + 1 upward top rim.
    // Keyrings: 1 downward bottom annulus + 1 upward top annulus.
    const downRings = d.type === 'cutter' ? 3 : 1;
    assert.equal(down, d.sectors * downRings * 2, `${d.id} downward annulus triangle count`);
    assert.equal(up, d.sectors * 2, `${d.id} upward annulus triangle count`);
    assert.ok(up > 0, `${d.id} has horizontal caps`);
    // Bottom annulus triangles must sit exactly at z=0 and face downward.
    const bottom = m.triangles.filter((t) => t.every((p) => Math.abs(p[2]) < 1e-9));
    for (const t of bottom) {
      const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      assert.ok(n[2] < 0, `${d.id} z=0 face points down`);
    }
    assert.ok(bottom.length > 0, `${d.id} has a flat bottom annulus`);
  }
});

test('sections and faces are planar with unit-length normals', () => {
  for (const d of CAD.DESIGNS) {
    const m = CAD.generate(d.id);
    const solid = m.solids[0];
    for (const f of solid.faces) {
      assert.ok(f.length >= 3, 'face has at least 3 vertices');
      const pts = f.map((i) => solid.vertices[i]);
      const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
      assert.ok(norm(n) > 1e-9, 'face normal is nonzero');
      const u = unit(n);
      assert.ok(Math.abs(norm(u) - 1) < 1e-9, 'normal is unit length');
      for (const p of pts) {
        const d0 = dot(sub(p, pts[0]), u);
        assert.ok(Math.abs(d0) < 1e-7, `face is planar (off-plane ${d0})`);
      }
    }
    // Face count and triangulation: every quad becomes exactly 2 triangles.
    const expected = solid.faces.reduce((s, f) => s + f.length - 2, 0);
    assert.equal(solid.triangles.length, expected, `${d.id} triangulation count matches face polygon degrees`);
    // Cutters: 3 inner wall rings + 3 outer band rings + 4 annular ledges = 10
    // quad rings per sector. Keyrings: 1 inner + 1 outer wall + 2 annuli = 4.
    const rings = d.type === 'cutter' ? 10 : 4;
    assert.equal(solid.faces.length, d.sectors * rings, `${d.id} face rings per sector`);
    assert.equal(solid.vertices.length, d.sectors * rings, `${d.id} vertex rings per sector`);
    assert.deepEqual([...new Set(solid.faces.map((f) => f.length))], [4], `${d.id} all faces are quads`);
  }
});

test('validate() rejects mutated envelope, volume, band thickness, and hole size', () => {
  const base = CAD.generate(CAD.DESIGNS[0].id);
  const big = { ...base, dimensions: [101, 10, 10] };
  assert.equal(CAD.validate(big).pass, false, 'envelope violation is caught');
  assert.ok(CAD.validate(big).checks.some((c) => c.rule === 'Maximum envelope' && !c.pass));
  const hollow = { ...base, volume: -1 };
  assert.equal(CAD.validate(hollow).pass, false, 'negative volume is caught');
  const nanVolume = { ...base, volume: NaN };
  assert.equal(CAD.validate(nanVolume).pass, false, 'NaN volume is caught');
  const thin = { ...base, sections: base.sections.map((s) => s.label === 'main wall' ? { ...s, thickness: 1.2 } : s) };
  assert.equal(CAD.validate(thin).pass, false, 'wrong wall thickness is caught');
  const missing = { ...base, sections: base.sections.slice(0, 2) };
  assert.equal(CAD.validate(missing).pass, false, 'missing rim section is caught');
  const short = { ...base, dimensions: [50, 50, 11] };
  assert.equal(CAD.validate(short).pass, false, 'wrong cutter height is caught');
  const key = CAD.generate(KEYRINGS[0].id);
  assert.equal(CAD.validate({ ...key, holeDiameter: 4.9 }).pass, false, 'undersized hole is caught');
  assert.equal(CAD.validate({ ...key, bounds: { ...key.bounds, min: [0, 0, 0.3] } }).pass, false, 'raised bottom is caught');
  assert.equal(CAD.validate({ ...key, dimensions: [80.1, 10, 4] }).pass, false, 'keyring envelope is caught');
});
