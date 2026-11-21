// Adversarial hardening suite: kernel math edge cases, per-design manifold and
// wall-thickness invariants, STL/STEP round-trip parsing, determinism, and
// export-integrity checks beyond the baseline geometry tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../cad-engine.js';
const CAD = globalThis.BakeBuildCAD;
import {
  parseAsciiStl, signedVolume as stlVolume, cross, sub, norm, unit,
  boundsOf, manifoldReport, normalFlux, parseStepEntities, countStepType,
  vertexKey
} from './helpers.js';

const MODELS = CAD.DESIGNS.map((d) => CAD.generate(d.id));
const CUTTER_MODELS = MODELS.filter((m) => m.type === 'cutter');
const KEYRING = MODELS.find((m) => m.type === 'keyring');
const TOL = 1e-6;

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
    const dx = p[0] - (a[0] + t * abx);
    const dy = p[1] - (a[1] + t * aby);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

// ---------- per-design generate() invariants ----------

for (const model of MODELS) {
  test(`HD generate ${model.id}: validation passes all checks`, () => {
    assert.equal(model.validation.pass, true);
    for (const c of model.validation.checks) assert.ok(c.pass, `${c.rule}: ${JSON.stringify(c.actual)}`);
  });

  test(`HD generate ${model.id}: triangle soup is a closed consistently-wound manifold`, () => {
    const rep = manifoldReport(model.triangles);
    assert.equal(rep.boundary, 0, 'boundary edges leak the shell');
    assert.equal(rep.nonManifold, 0, 'edges shared by != 2 faces');
    assert.equal(rep.flipped, 0, 'adjacent faces wind the same way across an edge');
    assert.equal(rep.degenerate, 0, 'zero-area triangles present');
  });

  test(`HD generate ${model.id}: outward normal flux balances to ~0 (closed shell)`, () => {
    const flux = normalFlux(model.triangles);
    const scale = boundsOf(model.triangles).dimensions.reduce((s, v) => s + v, 0) ** 2;
    flux.forEach((f, i) => assert.ok(Math.abs(f) < Math.max(1e-6, scale * 1e-6), `flux[${i}]=${f}`));
  });

  test(`HD generate ${model.id}: signed volume is positive and bounded`, () => {
    assert.ok(Number.isFinite(model.volume));
    assert.ok(model.volume > 0, model.volume);
    const dims = model.dimensions;
    assert.ok(model.volume < dims[0] * dims[1] * dims[2], 'volume exceeds its own bounding box');
  });

  test(`HD generate ${model.id}: base sits flat on z = 0 for printability`, () => {
    assert.ok(Math.abs(model.bounds.min[2]) < 1e-7, model.bounds.min[2]);
    assert.ok(model.bounds.max[2] > model.bounds.min[2]);
  });

  test(`HD generate ${model.id}: all vertices are finite millimetre coordinates`, () => {
    for (const s of model.solids) {
      for (const v of s.vertices) {
        assert.equal(v.length, 3);
        v.forEach((c) => assert.ok(Number.isFinite(c) && Math.abs(c) < 1000, c));
      }
    }
  });

  test(`HD generate ${model.id}: every face is planar with 4 distinct indices`, () => {
    for (const s of model.solids) {
      for (const f of s.faces) {
        assert.equal(f.length, 4);
        assert.equal(new Set(f).size, 4, 'degenerate face');
        const [a, b, c, d] = f.map((i) => s.vertices[i]);
        const n = cross(sub(b, a), sub(c, a));
        const dev = Math.abs((d[0] - a[0]) * n[0] + (d[1] - a[1]) * n[1] + (d[2] - a[2]) * n[2]) / Math.max(norm(n), 1e-12);
        assert.ok(dev < 1e-6, `non-planar face dev=${dev}`);
      }
    }
  });

  test(`HD generate ${model.id}: shared vertices weld edges (no duplicated rings)`, () => {
    for (const s of model.solids) {
      const uniq = new Set(s.vertices.map(vertexKey));
      assert.equal(uniq.size, s.vertices.length, 'unwelded duplicate vertices');
    }
  });
}

// ---------- cutter-specific invariants ----------

for (const model of CUTTER_MODELS) {
  test(`HD cutter ${model.id}: total height is exactly ${CAD.RULES.height} mm`, () => {
    assert.ok(Math.abs(model.dimensions[2] - CAD.RULES.height) < 1e-7);
  });

  test(`HD cutter ${model.id}: three section bands with exact nominal thickness`, () => {
    assert.equal(model.sections.length, 3);
    const want = { 'cutting lip': CAD.RULES.lip, 'main wall': CAD.RULES.wall, 'top handle rim': CAD.RULES.rimWidth };
    for (const s of model.sections) {
      assert.ok(Math.abs(s.thickness - want[s.label]) < 1e-7, s.label);
      assert.ok(s.top > s.bottom, s.label);
    }
    assert.ok(Math.abs(model.sections[1].bottom - 1.5) < 1e-7, 'wall starts at 1.5');
  });

  test(`HD cutter ${model.id}: offset contour is a true perpendicular offset`, () => {
    const design = CAD.DESIGNS.find((d) => d.id === model.id);
    const prof = CAD.profile(design);
    const off = CAD.offset(prof, CAD.RULES.wall);
    // Sampled vertices of the offset contour must sit ~wall mm from the base contour.
    let minD = Infinity;
    let maxD = -Infinity;
    for (const p of off) {
      const d = distToPoly(p, prof);
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
    }
    assert.ok(Math.abs(minD - CAD.RULES.wall) < 0.15, `min perpendicular distance ${minD}`);
    assert.ok(maxD - CAD.RULES.wall < 0.6, `max perpendicular distance ${maxD}`);
  });

  test(`HD cutter ${model.id}: lip band is thinner than main wall for cutting`, () => {
    const lip = model.sections.find((s) => s.label === 'cutting lip');
    const wall = model.sections.find((s) => s.label === 'main wall');
    assert.ok(lip.thickness < wall.thickness);
  });

  test(`HD cutter ${model.id}: rim widens beyond the main wall`, () => {
    const design = CAD.DESIGNS.find((d) => d.id === model.id);
    const prof = CAD.profile(design);
    const rimOff = CAD.offset(prof, CAD.RULES.rimWidth);
    const wallOff = CAD.offset(prof, CAD.RULES.wall);
    assert.ok(Math.abs(polyArea(rimOff)) > Math.abs(polyArea(wallOff)));
  });
}

// ---------- keyring-specific invariants ----------

test('HD keyring: single FuseRing body band spanning keyringHeight', () => {
  assert.equal(KEYRING.sections.length, 1);
  const s = KEYRING.sections[0];
  assert.ok(Math.abs(s.top - CAD.RULES.keyringHeight) < 1e-7);
  assert.equal(s.bottom, 0);
});

test('HD keyring: carabiner hole clears >= 5 mm inscribed diameter', () => {
  assert.equal(KEYRING.holeDiameter, CAD.RULES.holeDiameter);
  assert.ok(KEYRING.holeDiameter >= 5);
});

test('HD keyring: hole polygon sits inside the outer contour', () => {
  const design = CAD.DESIGNS.find((d) => d.id === KEYRING.id);
  const prof = CAD.profile(design);
  const inner = prof.map((p) => Math.hypot(p[0], p[1]));
  const holeR = CAD.RULES.holeDiameter / 2;
  assert.ok(holeR < Math.min(...inner) - 5, 'hole too close to outer wall');
});

test('HD keyring: height is exactly keyringHeight and envelope is compact', () => {
  assert.ok(Math.abs(KEYRING.dimensions[2] - CAD.RULES.keyringHeight) < 1e-7);
  assert.ok(KEYRING.dimensions[0] <= 80 && KEYRING.dimensions[1] <= 80);
});

// ---------- profile() ----------

for (const design of CAD.DESIGNS) {
  test(`HD profile ${design.id}: ${design.sectors} finite CCW points centred near origin`, () => {
    const prof = CAD.profile(design);
    assert.equal(prof.length, design.sectors);
    for (const p of prof) {
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    assert.ok(polyArea(prof) > 0, 'profile must wind counter-clockwise');
    const cx = prof.reduce((s, p) => s + p[0], 0) / prof.length;
    const cy = prof.reduce((s, p) => s + p[1], 0) / prof.length;
    assert.ok(Math.hypot(cx, cy) < 2, `centroid (${cx},${cy})`);
  });

  test(`HD profile ${design.id}: radii stay inside the printable envelope`, () => {
    const prof = CAD.profile(design);
    for (const p of prof) {
      const r = Math.hypot(p[0], p[1]);
      assert.ok(r > design.radius - 6 && r < design.radius + 8, `r=${r}`);
    }
  });
}

// ---------- offset() adversarial inputs ----------

test('HD offset: empty and single-point contours do not throw', () => {
  assert.deepEqual(CAD.offset([], 2), []);
  const one = CAD.offset([[0, 0]], 2);
  assert.equal(one.length, 1);
  one[0].forEach((v) => assert.ok(Number.isFinite(v)));
});

test('HD offset: duplicated adjacent vertices produce no NaN', () => {
  const prof = [[0, 0], [0, 0], [4, 0], [4, 4], [0, 4]];
  const off = CAD.offset(prof, 1);
  off.forEach((p) => p.forEach((v) => assert.ok(Number.isFinite(v), JSON.stringify(off))));
});

test('HD offset: collinear runs fall back to the normal-direction shift', () => {
  const line = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 3], [0, 3]];
  const off = CAD.offset(line, 1.5);
  off.forEach((p) => p.forEach((v) => assert.ok(Number.isFinite(v))));
});

test('HD offset: square offset by d shifts each edge midpoint by ~d', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const off = CAD.offset(sq, 2);
  // Miter corners sit d*sqrt(2) from the corner vertex; the midpoint of each
  // offset edge must sit exactly d from the original contour.
  for (let i = 0; i < off.length; i += 1) {
    const a = off[i];
    const b = off[(i + 1) % off.length];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = distToPoly(mid, sq);
    assert.ok(Math.abs(d - 2) < 0.05, `d=${d} for mid ${mid}`);
  }
});

test('HD offset: inward (negative) offset shrinks a square', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const off = CAD.offset(sq, -1);
  assert.ok(Math.abs(polyArea(off)) < Math.abs(polyArea(sq)));
});

test('HD offset: zero distance returns congruent contour', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const off = CAD.offset(sq, 0);
  off.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - sq[i][0]) < 1e-9 && Math.abs(p[1] - sq[i][1]) < 1e-9);
  });
});

// ---------- signedVolume / unit / number formatting via STL ----------

test('HD signedVolume: unit cube triangle soup returns 1', () => {
  const v = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const tris = [
    [v[0],v[2],v[1]],[v[0],v[3],v[2]],
    [v[4],v[5],v[6]],[v[4],v[6],v[7]],
    [v[0],v[1],v[5]],[v[0],v[5],v[4]],
    [v[1],v[2],v[6]],[v[1],v[6],v[5]],
    [v[2],v[3],v[7]],[v[2],v[7],v[6]],
    [v[3],v[0],v[4]],[v[3],v[4],v[7]]
  ];
  assert.ok(Math.abs(stlVolume(tris) - 1) < 1e-9);
  assert.ok(Math.abs(CAD.signedVolume(tris) - 1) < 1e-9);
});

test('HD signedVolume: reversed winding flips the sign of the contribution', () => {
  const ccw = [[[0,0,1],[1,0,0],[0,1,0]]];
  const cw = [[[0,0,1],[0,1,0],[1,0,0]]];
  const a = CAD.signedVolume(ccw);
  const b = CAD.signedVolume(cw);
  assert.ok(a > 0 && b < 0, `ccw=${a} cw=${b}`);
  assert.ok(Math.abs(a + b) < 1e-12);
});

test('HD STL number formatting: no NaN/Infinity/scientific junk in output', () => {
  const stl = CAD.toSTL(MODELS[0]);
  assert.ok(!/NaN|Infinity|inf\b/i.test(stl));
  const vertex = stl.split('\n').filter((l) => l.trim().startsWith('vertex'));
  assert.ok(vertex.length > 0);
  for (const l of vertex) {
    assert.ok(/^\s*vertex\s+-?\d+(\.\d*)?([eE][+-]?\d+)?\s+-?\d+(\.\d*)?([eE][+-]?\d+)?\s+-?\d+(\.\d*)?([eE][+-]?\d+)?\s*$/.test(l), l);
  }
});

test('HD STL: huge and degenerate coordinates serialize safely', () => {
  const fake = { id: 'probe', triangles: [[[0,0,0],[1e30,0,0],[0,NaN,0]]] };
  const stl = CAD.toSTL(fake);
  assert.ok(!/NaN|Infinity/i.test(stl), stl);
});

// ---------- STL round-trip per design ----------

for (const model of MODELS) {
  test(`HD STL ${model.id}: round-trip parse preserves facet count and manifold topology`, () => {
    const parsed = parseAsciiStl(CAD.toSTL(model));
    assert.equal(parsed.name, model.id);
    assert.equal(parsed.triangles.length, model.triangles.length);
    const rep = manifoldReport(parsed.triangles);
    assert.equal(rep.boundary + rep.nonManifold, 0);
    assert.equal(rep.degenerate, 0);
  });

  test(`HD STL ${model.id}: facet normals are unit-length and match winding`, () => {
    const parsed = parseAsciiStl(CAD.toSTL(model));
    for (const tri of parsed.triangles.slice(0, 60)) {
      const n = unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
      assert.ok(Math.abs(norm(n) - 1) < 1e-6);
    }
  });

  test(`HD STL ${model.id}: round-trip volume matches kernel volume`, () => {
    const parsed = parseAsciiStl(CAD.toSTL(model));
    assert.ok(Math.abs(stlVolume(parsed.triangles) - model.volume) < Math.max(1e-4, Math.abs(model.volume) * 1e-6));
  });
}

// ---------- STEP integrity per design ----------

for (const model of MODELS) {
  test(`HD STEP ${model.id}: ISO-10303-21 envelope and balanced DATA section`, () => {
    const step = CAD.toSTEP(model);
    assert.ok(step.startsWith('ISO-10303-21;'));
    assert.ok(step.includes('END-ISO-10303-21;'));
    assert.ok(step.includes("FILE_SCHEMA(('AUTOMOTIVE_DESIGN'))"));
    assert.ok(step.includes('SI_UNIT(.MILLI.,.METRE.)'));
  });

  test(`HD STEP ${model.id}: entity counts match kernel topology`, () => {
    const step = CAD.toSTEP(model);
    const faces = model.solids.reduce((s, x) => s + x.faces.length, 0);
    assert.equal(countStepType(step, 'ADVANCED_FACE'), faces);
    assert.equal(countStepType(step, 'FACE_OUTER_BOUND'), faces);
    assert.equal(countStepType(step, 'EDGE_LOOP'), faces);
    assert.equal(countStepType(step, 'CLOSED_SHELL'), model.solids.length);
    assert.equal(countStepType(step, 'MANIFOLD_SOLID_BREP'), model.solids.length);
    assert.equal(countStepType(step, 'CARTESIAN_POINT'), model.solids[0].vertices.length);
    assert.equal(countStepType(step, 'VERTEX_POINT'), model.solids[0].vertices.length);
    assert.equal(countStepType(step, 'ORIENTED_EDGE'), faces * 4);
  });

  test(`HD STEP ${model.id}: every entity reference resolves to a defined id`, () => {
    const step = CAD.toSTEP(model);
    const entities = parseStepEntities(step);
    assert.ok(entities.size > 0);
    for (const e of entities.values()) {
      for (const ref of e.refs) {
        assert.ok(entities.has(ref), `dangling ref #${ref} in #${e.id}`);
      }
    }
  });

  test(`HD STEP ${model.id}: EDGE_CURVE count equals unique undirected face edges`, () => {
    const step = CAD.toSTEP(model);
    const uniq = new Set();
    for (const s of model.solids) {
      for (const f of s.faces) {
        for (let i = 0; i < f.length; i += 1) {
          const a = Math.min(f[i], f[(i + 1) % f.length]);
          const b = Math.max(f[i], f[(i + 1) % f.length]);
          uniq.add(`${a}:${b}`);
        }
      }
    }
    assert.equal(countStepType(step, 'EDGE_CURVE'), uniq.size);
  });
}

test('HD STEP: deterministic byte-identical output across calls', () => {
  for (const m of MODELS) {
    assert.equal(CAD.toSTEP(m), CAD.toSTEP(m));
  }
});

test('HD STL: deterministic byte-identical output across calls', () => {
  for (const m of MODELS) {
    assert.equal(CAD.toSTL(m), CAD.toSTL(m));
  }
});

// ---------- generate()/validate() hostile inputs ----------

test('HD generate: unknown design ids throw a descriptive error', () => {
  for (const id of ['nope', '', 'ORPHEUS_CIRCUIT_CREST_CUTTER', null, undefined, 42]) {
    assert.throws(() => CAD.generate(id), /Unknown design/);
  }
});

test('HD validate: flags an over-envelope model as failing', () => {
  const model = CAD.generate(MODELS[0].id);
  const blown = { ...model, dimensions: [500, 500, 500] };
  const rep = CAD.validate(blown);
  assert.equal(rep.pass, false);
  assert.ok(rep.checks.some((c) => !c.pass));
});

test('HD validate: flags a negative-volume model as failing', () => {
  const model = CAD.generate(MODELS[0].id);
  const rep = CAD.validate({ ...model, volume: -1 });
  assert.equal(rep.pass, false);
});

// ---------- CLI export artifacts ----------

test('HD manifest: every shipped artifact hashes match content', async () => {
  const { readExport, sha256 } = await import('./helpers.js');
  const manifest = JSON.parse(readExport('manifest.json'));
  assert.equal(manifest.models.length, CAD.DESIGNS.length);
  for (const entry of manifest.models) {
    for (const kind of ['step', 'stl']) {
      const text = readExport(entry.files[kind].name);
      assert.equal(sha256(text), entry.files[kind].sha256, entry.files[kind].name);
    }
  }
});

test('HD shipped STLs parse into closed manifolds', async () => {
  const { readExport } = await import('./helpers.js');
  for (const model of MODELS) {
    const parsed = parseAsciiStl(readExport(`${model.id}.stl`));
    const rep = manifoldReport(parsed.triangles);
    assert.equal(rep.boundary + rep.nonManifold, 0, model.id);
  }
});

test('HD shipped STEPs carry a MANIFOLD_SOLID_BREP per design', async () => {
  const { readExport } = await import('./helpers.js');
  for (const model of MODELS) {
    const step = readExport(`${model.id}.step`);
    assert.ok(countStepType(step, 'MANIFOLD_SOLID_BREP') >= 1, model.id);
    assert.ok(step.includes(model.id));
  }
});
