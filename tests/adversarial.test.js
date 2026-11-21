// Regression tests for the pass-2 adversarial audit findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../cad-engine.js';
const CAD = globalThis.BakeBuildCAD;
const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Mirrors app.js transform(): orthographic camera, larger z is nearer the viewer.
function cameraSpace(model, yaw, pitch) {
  const center = model.bounds.min.map((v, i) => (v + model.bounds.max[i]) / 2);
  return model.triangles.map((t) => t.map((p) => {
    const [x, y, z] = p.map((v, i) => v - center[i]);
    const a = x*Math.cos(yaw) - y*Math.sin(yaw), b = x*Math.sin(yaw) + y*Math.cos(yaw);
    return [a, b*Math.cos(pitch) - z*Math.sin(pitch), b*Math.sin(pitch) + z*Math.cos(pitch)];
  }));
}
function barycentric(px, py, t) {
  const det = (t[1][1]-t[2][1])*(t[0][0]-t[2][0])+(t[2][0]-t[1][0])*(t[0][1]-t[2][1]);
  if (Math.abs(det) < 1e-12) return null;
  const l1 = ((t[1][1]-t[2][1])*(px-t[2][0])+(t[2][0]-t[1][0])*(py-t[2][1]))/det;
  const l2 = ((t[2][1]-t[0][1])*(px-t[2][0])+(t[0][0]-t[2][0])*(py-t[2][1]))/det;
  return [l1, l2, 1-l1-l2];
}
// Counts sample points where the last-drawn covering triangle is not the nearest.
function occlusions(ordered) {
  const boxes = ordered.map((t) => ({
    xmin: Math.min(t[0][0], t[1][0], t[2][0]), xmax: Math.max(t[0][0], t[1][0], t[2][0]),
    ymin: Math.min(t[0][1], t[1][1], t[2][1]), ymax: Math.max(t[0][1], t[1][1], t[2][1]),
  }));
  let wrong = 0;
  for (let k = 0; k < ordered.length; k++) {
    const t = ordered[k];
    for (const l1 of [0.2, 0.4, 0.6, 0.8]) for (const l2 of [0.2, 0.4, 0.6, 0.8]) {
      const l3 = 1-l1-l2;
      if (l3 < 0.15) continue;
      const px = l1*t[0][0]+l2*t[1][0]+l3*t[2][0], py = l1*t[0][1]+l2*t[1][1]+l3*t[2][1];
      let lastDrawn = -1, nearestZ = -Infinity, lastDrawnZ = -Infinity;
      for (let j = 0; j < ordered.length; j++) {
        const b = boxes[j];
        if (px < b.xmin || px > b.xmax || py < b.ymin || py > b.ymax) continue;
        const w = barycentric(px, py, ordered[j]);
        if (!w || Math.min(...w) < -1e-9) continue;
        const z = w[0]*ordered[j][0][2]+w[1]*ordered[j][1][2]+w[2]*ordered[j][2][2];
        if (z > nearestZ) nearestZ = z;
        if (j > lastDrawn) { lastDrawn = j; lastDrawnZ = z; }
      }
      if (lastDrawn >= 0 && lastDrawnZ < nearestZ - 1e-6) wrong++;
    }
  }
  return wrong;
}
const CAMERAS = [[-0.55, -0.75], [0, -0.9], [1.2, -0.3], [-2.1, -1.1]];

test('ADV-1 depthSort yields zero inverted pixels for every design and camera', () => {
  for (const d of CAD.DESIGNS) {
    const model = CAD.generate(d.id);
    for (const [yaw, pitch] of CAMERAS) {
      const tris = cameraSpace(model, yaw, pitch);
      const wrong = occlusions(CAD.depthSort(tris));
      assert.equal(wrong, 0, `${d.id} at yaw=${yaw} pitch=${pitch}: ${wrong} inverted sample points`);
    }
  }
});
test('ADV-1b the old centroid sort really did invert pixels (defect reproduced then fixed)', () => {
  const model = CAD.generate('orpheus_circuit_crest_cutter');
  const tris = cameraSpace(model, -0.55, -0.75);
  const centroidOrder = tris.slice().sort((a, b) =>
    a.reduce((s, p) => s+p[2], 0) - b.reduce((s, p) => s+p[2], 0));
  assert.ok(occlusions(centroidOrder) > 0, 'centroid sort must still show the reproduced defect');
});
test('ADV-1c depthSort returns every triangle exactly once and is deterministic', () => {
  const model = CAD.generate('hex_gear_logic_gate_cutter');
  const tris = cameraSpace(model, 0.7, -0.6);
  const a = CAD.depthSort(tris), b = CAD.depthSort(tris);
  assert.equal(a.length, tris.length);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, tris.length);
});

test('ADV-2 validate() inspects geometry instead of trusting reported scalars', () => {
  const m = CAD.generate('orpheus_circuit_crest_cutter');
  assert.equal(CAD.validate({ ...m, solids: [], triangles: [] }).pass, false);
  assert.equal(CAD.validate({ ...m, triangles: m.triangles.filter((_, i) => i % 2) }).pass, false);
  const flipped = m.triangles.map((t, i) => i % 2 ? [t[0], t[2], t[1]] : t);
  const flippedResult = CAD.validate({ ...m, triangles: flipped });
  assert.equal(flippedResult.pass, false);
  assert.equal(flippedResult.checks.find((c) => c.rule === 'Consistent triangle winding').pass, false);
  const nanModel = { ...m, triangles: m.triangles.map((t, i) => i ? t : [[NaN, 0, 0], t[1], t[2]]) };
  assert.equal(CAD.validate(nanModel).pass, false);
  assert.equal(CAD.validate(m).pass, true);
  const rules = m.validation.checks.map((c) => c.rule);
  for (const r of ['Triangulated surface present', 'Closed manifold surface', 'Consistent triangle winding', 'No degenerate facets', 'Reported volume matches mesh', 'Solid bodies present', 'Contours are simple polygons'])
    assert.ok(rules.includes(r), `missing check: ${r}`);
});
test('ADV-2b manifoldReport detects boundary, non-manifold, flipped, degenerate, NaN', () => {
  const m = CAD.generate('stepcheck_sigma_badge_cutter');
  const clean = CAD.manifoldReport(m.triangles);
  assert.deepEqual({ ...clean, edges: 0 }, { edges: 0, boundary: 0, nonManifold: 0, flipped: 0, degenerate: 0, nan: 0 });
  const half = CAD.manifoldReport(m.triangles.filter((_, i) => i % 2));
  assert.ok(half.boundary > 0);
  const tee = CAD.manifoldReport([...m.triangles, [m.triangles[0][0], m.triangles[0][1], [0, 0, 999]]]);
  assert.ok(tee.nonManifold > 0 || tee.boundary > 0);
  assert.ok(CAD.manifoldReport(m.triangles.map((t, i) => i % 2 ? [t[0], t[2], t[1]] : t)).flipped > 0);
  assert.equal(CAD.manifoldReport(m.triangles.map((t) => [t[0], t[2], t[1]])).flipped, 0, 'uniformly reversed mesh is consistent, just inside-out');
  assert.ok(CAD.manifoldReport([[[0, 0, 0], [1, 1, 1], [2, 2, 2]]]).degenerate === 1);
  assert.ok(CAD.manifoldReport([[[NaN, 0, 0], [0, 0, 0], [0, 0, 1]]]).nan === 1);
});

test('ADV-3 polygonSelfIntersections catches crossings, shipped contours stay simple', () => {
  assert.equal(CAD.polygonSelfIntersections([[0, 0], [2, 2], [2, 0], [0, 2]]), 1, 'bowtie crosses once');
  assert.equal(CAD.polygonSelfIntersections([[0, 0], [1, 0], [1, 1], [0, 1]]), 0, 'square is simple');
  assert.equal(CAD.polygonSelfIntersections([[0, 0], [2, 0], [0.5, 0.5], [2, 1], [0, 1]]), 0, 'concave polygon is simple');
  for (const d of CAD.DESIGNS) {
    const contour = CAD.profile(d);
    assert.equal(CAD.polygonSelfIntersections(contour), 0, `${d.id} profile simple`);
    if (d.type === 'cutter') for (const w of [CAD.RULES.lip, CAD.RULES.wall, CAD.RULES.rimWidth])
      assert.equal(CAD.polygonSelfIntersections(CAD.offset(contour, w)), 0, `${d.id} offset ${w}mm simple`);
  }
  const rules = CAD.generate('orpheus_circuit_crest_cutter').validation.checks;
  assert.ok(rules.find((c) => c.rule === 'Contours are simple polygons').pass);
});

test('ADV-4 cad-engine.mjs restores the documented ES-module API', async () => {
  const mod = await import('../cad-engine.mjs');
  assert.equal(mod.default, CAD);
  for (const name of ['generate', 'validate', 'toSTEP', 'toSTL', 'profile', 'offset', 'signedVolume', 'depthSort', 'manifoldReport', 'polygonSelfIntersections', 'DESIGNS', 'RULES'])
    assert.equal(mod[name], CAD[name], `named export ${name}`);
  assert.equal(mod.generate('orpheus_fusering_keyring').validation.pass, true);
});

test('ADV-5 interactive canvas carries an application role so its label is announced', () => {
  const tag = /<canvas id="preview"[^>]*>/.exec(html)[0];
  assert.match(tag, /role="application"/);
  assert.match(tag, /aria-label="[^"]+"/);
});

test('ADV-6 docs match reality: no stale test counts or ESM/file:// claims', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const devpost = fs.readFileSync(path.join(root, 'DEVPOST_UPGRADE.md'), 'utf8');
  assert.doesNotMatch(readme, /51[- ]test|ES modules require HTTP/i);
  assert.doesNotMatch(devpost, /51 tests|51 automated checks|51 checks|UMD plus ES-module/i);
});

test('ADV-7 cli.js is executable so its shebang works', () => {
  assert.notEqual(fs.statSync(path.join(root, 'cli.js')).mode & 0o111, 0);
});

test('ADV-8 STEP/STL number formatting uses uppercase E for huge exponents', () => {
  const model = { id: 'probe', name: 'probe', triangles: [[[1e21, 0, 0], [0, 0, 0], [0, 0, 1]]], solids: [{ vertices: [[1e21, 0, 0], [0, 0, 0], [0, 0, 1]], faces: [[0, 1, 2]] }] };
  for (const out of [CAD.toSTL(model), CAD.toSTEP(model)]) {
    assert.match(out, /1\.000000E\+21/);
    assert.doesNotMatch(out, /\de[+-]\d/);
  }
});
