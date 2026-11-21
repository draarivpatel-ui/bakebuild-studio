// Regression tests for the shipped artifacts. Every assertion reads a real
// .step / .stl / manifest.json file from exports/ and re-parses it, so corrupt
// or stale downloads cannot pass silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../cad-engine.js';
const CAD = globalThis.BakeBuildCAD;
import { exportAll } from '../cli.js';
import {
  EXPORTS, readExport, readText, sha256, parseAsciiStl, signedVolume, boundsOf,
  manifoldReport, normalFlux, unit, cross, sub, dot, norm, vertexKey,
  parseStepEntities, countStepType
} from './helpers.js';

const manifest = JSON.parse(readExport('manifest.json'));

function eachModel(fn) {
  for (const entry of manifest.models) fn(entry);
}

test('manifest schema, units, rules, and model list match the generator', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.units, 'mm');
  assert.equal(manifest.generator, 'BakeBuild Studio zero-dependency CAD');
  assert.match(manifest.topology, /manifold solid/);
  assert.deepEqual(manifest.rules, { ...CAD.RULES });
  assert.equal(manifest.models.length, 4);
  assert.deepEqual(manifest.models.map((m) => m.id), CAD.DESIGNS.map((d) => d.id));
  assert.equal(new Set(manifest.models.map((m) => m.id)).size, 4);
  for (const m of manifest.models) {
    assert.equal(m.units, 'mm');
    assert.equal(m.solidCount, 1);
    assert.equal(m.validation.pass, true);
    assert.ok(m.volume > 0 && Number.isFinite(m.volume));
  }
});

test('every declared STEP and STL file exists, is nonempty, and matches its manifest hash', () => {
  const names = new Set();
  eachModel((m) => {
    for (const ext of ['step', 'stl']) {
      const file = m.files[ext];
      assert.equal(file.name, `${m.id}.${ext}`);
      assert.ok(!names.has(file.name), 'no duplicate export filenames');
      names.add(file.name);
      const full = path.join(EXPORTS, file.name);
      assert.ok(fs.existsSync(full), `${file.name} exists`);
      const text = fs.readFileSync(full, 'utf8');
      assert.ok(text.length > 1000, `${file.name} has real content`);
      assert.equal(Buffer.byteLength(text), file.bytes, `${file.name} byte count`);
      assert.equal(sha256(text), file.sha256, `${file.name} SHA-256`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
  });
  assert.equal(names.size, 8);
});

test('manifest dimensions, bounds, sections, volume, and triangle counts equal a fresh generate()', () => {
  eachModel((m) => {
    const fresh = CAD.generate(m.id);
    assert.deepEqual(m.name, fresh.name);
    assert.deepEqual(m.type, fresh.type);
    assert.deepEqual(m.dimensions, fresh.dimensions);
    assert.deepEqual(m.bounds, fresh.bounds);
    assert.deepEqual(m.sections, fresh.sections);
    assert.equal(m.volume, fresh.volume);
    assert.equal(m.holeDiameter, fresh.holeDiameter);
    assert.equal(m.triangleCount, fresh.triangles.length);
    assert.deepEqual(m.validation, fresh.validation);
  });
});

test('shipped ASCII STL parses, has a unit facet normal, and matches the generated triangle soup', () => {
  eachModel((m) => {
    const text = readExport(m.files.stl.name);
    const parsed = parseAsciiStl(text);
    assert.equal(parsed.name, m.id);
    assert.equal(parsed.triangles.length, m.triangleCount);
    assert.match(text, /^solid \S+\n/);
    assert.match(text.trimEnd(), /endsolid \S+$/);
    assert.equal((text.match(/facet normal/g) || []).length, m.triangleCount);
    assert.equal((text.match(/outer loop/g) || []).length, m.triangleCount);
    assert.equal((text.match(/endfacet/g) || []).length, m.triangleCount);
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('vertex')) assert.equal(line.trim().split(/\s+/).length, 4, '3 coordinates per vertex');
    }
    // No binary STL magic, no NaN, no internal solid markers.
    assert.equal(text.includes('\u0000'), false);
    assert.equal(/NaN|Infinity/.test(text), false, `${m.id} STL is finite`);
    const fresh = CAD.generate(m.id);
    for (let i = 0; i < fresh.triangles.length; i += 1) {
      // Normalize -0, which is numerically identical but distinct under
      // Object.is / deepStrictEqual after the generator prints "-0.".
      const clean = (v) => Number(v.toFixed(6)) + 0;
      const expected = fresh.triangles[i].flat().map(clean);
      const actual = parsed.triangles[i].flat().map(clean);
      assert.deepEqual(actual, expected, `${m.id} triangle ${i} coordinates`);
      const n = unit(cross(sub(actual.slice(3, 6), actual.slice(0, 3)), sub(actual.slice(6, 9), actual.slice(0, 3))));
      const declared = text.split('\n').find((l) => l.trim().startsWith('facet normal'));
      assert.ok(declared, 'declared facet normal exists');
      assert.ok(n.every(Number.isFinite), `${m.id} triangle ${i} has a finite geometric normal`);
    }
    assert.ok(Math.abs(signedVolume(parsed.triangles) - m.volume) < 1e-3,
      `${m.id} shipped STL signed volume matches manifest (rounded coordinates)`);
    const b = boundsOf(parsed.triangles);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(b.min[i] - m.bounds.min[i]) < 1e-5, `${m.id} STL min[${i}]`);
      assert.ok(Math.abs(b.max[i] - m.bounds.max[i]) < 1e-5, `${m.id} STL max[${i}]`);
    }
  });
});

test('shipped STL declares correct facet normals matching geometric winding', () => {
  eachModel((m) => {
    const lines = readExport(m.files.stl.name).split('\n');
    let checked = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line.startsWith('facet normal')) continue;
      const declared = line.slice('facet normal'.length).trim().split(/\s+/).map(Number);
      assert.equal(declared.length, 3);
      assert.ok(Math.abs(norm(declared) - 1) < 1e-5, `${m.id} facet ${checked} normal is unit length`);
      const vertices = [];
      for (let j = i + 2; j < i + 5; j += 1) {
        const v = lines[j].trim();
        assert.ok(v.startsWith('vertex'), `${m.id} facet ${checked} has 3 vertex lines`);
        vertices.push(v.slice('vertex'.length).trim().split(/\s+/).map(Number));
      }
      const geometric = unit(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0])));
      assert.ok(dot(declared, geometric) > 0.99999, `${m.id} facet ${checked} declared normal matches winding`);
      checked += 1;
    }
    assert.equal(checked, m.triangleCount);
  });
});

test('shipped STL is a watertight, consistently wound, genus-1 manifold', () => {
  eachModel((m) => {
    const parsed = parseAsciiStl(readExport(m.files.stl.name));
    const r = manifoldReport(parsed.triangles, 1e-7);
    assert.equal(r.boundary, 0, `${m.id} has no boundary edges`);
    assert.equal(r.nonManifold, 0, `${m.id} has no non-manifold edges`);
    assert.equal(r.flipped, 0, `${m.id} has no flipped edge winding`);
    assert.equal(r.degenerate, 0, `${m.id} has no degenerate triangles`);
    assert.equal(r.vertices - r.uniqueEdges + r.triangles, 0, `${m.id} genus-1 Euler characteristic`);
    assert.ok(signedVolume(parsed.triangles) > 0, `${m.id} outward winding gives positive volume`);
    assert.ok(norm(normalFlux(parsed.triangles)) < 1e-3, `${m.id} closed surface has zero net flux`);
  });
});

test('shipped STL contains no internal sector interfaces or duplicate triangles', () => {
  eachModel((m) => {
    const parsed = parseAsciiStl(readExport(m.files.stl.name));
    const keys = parsed.triangles.map((t) => t.map(vertexKey).sort().join('|'));
    assert.equal(new Set(keys).size, keys.length, `${m.id} has no duplicate triangles`);
    // Each undirected edge is shared by exactly 2 faces, so no internal wall.
    const r = manifoldReport(parsed.triangles);
    assert.equal(r.uniqueEdges, parsed.triangles.length * 3 / 2, `${m.id} edges = 3F/2`);
  });
});

test('exported STL text exactly equals a fresh toSTL() call', () => {
  eachModel((m) => {
    assert.equal(readExport(m.files.stl.name), CAD.toSTL(CAD.generate(m.id)), `${m.id} STL is reproducible`);
  });
});

test('exported STEP text exactly equals a fresh toSTEP() call and has a valid ISO-10303-21 envelope', () => {
  eachModel((m) => {
    const text = readExport(m.files.step.name);
    assert.equal(text, CAD.toSTEP(CAD.generate(m.id)), `${m.id} STEP is reproducible`);
    assert.match(text, /^ISO-10303-21;\nHEADER;/);
    assert.match(text, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN'\)\);/);
    assert.match(text.trimEnd(), /END-ISO-10303-21;$/);
    assert.match(text, new RegExp(`FILE_NAME\\('${m.id}\\.step'`));
    assert.match(text, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/, 'explicit millimetre length unit');
    assert.match(text, /SI_UNIT\(\$,\.RADIAN\.\)/, 'radian plane-angle unit');
    assert.match(text, /SI_UNIT\(\$,\.STERADIAN\.\)/, 'steradian solid-angle unit');
    assert.match(text, /GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT/, 'geometric tolerance');
    assert.equal((text.match(/ENDSEC;/g) || []).length, 2, 'header and data sections');
  });
});

test('every STEP entity id is unique, sequential, and all references resolve', () => {
  eachModel((m) => {
    const text = readExport(m.files.step.name);
    const entities = parseStepEntities(text);
    assert.equal(entities.size, text.split('\n').filter((l) => /^#\d+=/ .test(l.trim())).length);
    const ids = [...entities.keys()];
    assert.deepEqual(ids, ids.map((_, i) => i + 1), `${m.id} entity ids are dense and sequential`);
    for (const e of entities.values()) {
      for (const ref of e.refs) {
        assert.ok(entities.has(ref), `${m.id} #${e.id} references missing #${ref}`);
        assert.ok(ref < e.id, `${m.id} #${e.id} never forward-references`);
      }
      assert.equal(e.body.trim().endsWith(';'), false, 'body parsed without trailing semicolon');
    }
  });
});

test('STEP B-rep topology has one closed shell, one manifold solid, and shared edges', () => {
  eachModel((m) => {
    const text = readExport(m.files.step.name);
    assert.equal(countStepType(text, 'MANIFOLD_SOLID_BREP'), 1, `${m.id} one solid B-rep`);
    assert.equal(countStepType(text, 'CLOSED_SHELL'), 1, `${m.id} one closed shell`);
    assert.equal(countStepType(text, 'ADVANCED_FACE'), CAD.generate(m.id).solids[0].faces.length,
      `${m.id} advanced face count matches kernel`);
    assert.equal(countStepType(text, 'CARTESIAN_POINT'), CAD.generate(m.id).solids[0].vertices.length,
      `${m.id} one Cartesian point per unique vertex`);
    assert.equal(countStepType(text, 'VERTEX_POINT'), CAD.generate(m.id).solids[0].vertices.length,
      `${m.id} one topological vertex per point`);
    assert.equal(countStepType(text, 'EDGE_CURVE'), CAD.generate(m.id).solids[0].faces.length * 2,
      `${m.id} shared edge curves = 2F`);
    assert.equal(countStepType(text, 'ORIENTED_EDGE'), CAD.generate(m.id).solids[0].faces.length * 4,
      `${m.id} 4 oriented edges per quad face`);
    assert.equal(countStepType(text, 'EDGE_LOOP'), CAD.generate(m.id).solids[0].faces.length);
    assert.equal(countStepType(text, 'FACE_OUTER_BOUND'), CAD.generate(m.id).solids[0].faces.length);
    assert.equal(countStepType(text, 'PLANE'), CAD.generate(m.id).solids[0].faces.length);
    assert.equal(countStepType(text, 'AXIS2_PLACEMENT_3D'), CAD.generate(m.id).solids[0].faces.length);
    assert.equal(countStepType(text, 'FACE_BOUND'), 0, `${m.id} uses only FACE_OUTER_BOUND`);
  });
});

test('STEP product metadata, context, units, and shape representation are wired correctly', () => {
  eachModel((m) => {
    const text = readExport(m.files.step.name);
    const entities = parseStepEntities(text);
    const types = new Map();
    for (const e of entities.values()) types.set(e.type, (types.get(e.type) || 0) + 1);
    for (const t of ['APPLICATION_CONTEXT', 'APPLICATION_PROTOCOL_DEFINITION', 'PRODUCT_CONTEXT',
      'PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_CONTEXT',
      'PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_SHAPE',
      'ADVANCED_BREP_SHAPE_REPRESENTATION', 'SHAPE_DEFINITION_REPRESENTATION']) {
      assert.equal(types.get(t), 1, `${m.id} has exactly one ${t}`);
    }
    assert.match(text, new RegExp(`PRODUCT\\('${m.id}','${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(text, /APPLICATION_PROTOCOL_DEFINITION\('international standard','automotive_design',2000/);
    assert.equal(countStepType(text, 'UNCERTAINTY_MEASURE_WITH_UNIT'), 1);
    assert.equal(countStepType(text, 'LENGTH_UNIT'), 1);
    assert.equal(countStepType(text, 'PLANE_ANGLE_UNIT'), 1);
    assert.equal(countStepType(text, 'SOLID_ANGLE_UNIT'), 1);
    const rep = [...entities.values()].find((e) => e.body.startsWith('ADVANCED_BREP_SHAPE_REPRESENTATION'));
    assert.ok(rep.refs.length >= 2, 'shape representation references a solid and a context');
    for (const ref of rep.refs) assert.ok(entities.has(ref));
  });
});

test('STEP plane normals are unit vectors and match the face polygon winding', () => {
  eachModel((m) => {
    const text = readExport(m.files.step.name);
    const entities = parseStepEntities(text);
    const dirs = [...entities.values()].filter((e) => e.body.startsWith("DIRECTION('',("));
    assert.ok(dirs.length > 0);
    for (const d of dirs) {
      const nums = d.body.match(/\(([-\d.,]+)\)/)[1].split(',').map(Number);
      assert.equal(nums.length, 3, 'direction has 3 components');
      assert.ok(nums.every(Number.isFinite), 'direction is finite');
      assert.ok(Math.abs(norm(nums) - 1) < 1e-5, `direction #${d.id} is unit length`);
    }
    const points = [...entities.values()].filter((e) => e.body.startsWith("CARTESIAN_POINT('',("));
    for (const p of points) {
      const nums = p.body.match(/\(([-\d.,]+)\)/)[1].split(',').map(Number);
      assert.equal(nums.length, 3);
      assert.ok(nums.every(Number.isFinite), 'Cartesian point is finite');
      assert.ok(nums.every((v) => Math.abs(v) < 1000), 'coordinates stay within a sane envelope');
    }
  });
});

test('exportAll regenerates a byte-identical manifest into a clean temporary directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-studio-'));
  try {
    const result = exportAll(dir);
    assert.equal(result.models.length, 4);
    const written = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    assert.equal(written, readExport('manifest.json'), 'manifest content is deterministic');
    for (const m of result.models) {
      for (const ext of ['step', 'stl']) {
        assert.equal(fs.readFileSync(path.join(dir, m.files[ext].name), 'utf8'), readExport(m.files[ext].name),
          `${m.files[ext].name} regenerates byte-identically`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
