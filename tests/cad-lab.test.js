// Audit-lab suite: SHA-256, topology comparator, nozzle wall sweeps, the
// strict #bbs= bookmark codec, digest-stamped exports, tamper detection,
// hostile input handling, and the in-page self-test battery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import '../cad-engine.js';
import '../cad-lab.js';
const CAD = globalThis.BakeBuildCAD;
const LAB = globalThis.BakeBuildLab;
import { signedVolume, manifoldReport, vertexKey } from './helpers.js';
import { readText } from './helpers.js';

const CUTTER_IDS = CAD.DESIGNS.filter((d) => d.type === 'cutter').map((d) => d.id);
const KEYRING_ID = CAD.DESIGNS.find((d) => d.type === 'keyring').id;
const labSource = readText('cad-lab.js');

/* ------------------------------------------------------------ module */

test('LAB: cad-lab.js is a UMD classic script with the full API surface', () => {
  assert.match(labSource, /module\.exports ?= ?api/);
  assert.match(labSource, /root\.BakeBuildLab ?= ?api/);
  assert.doesNotMatch(labSource, /^export\s/m, 'top-level export breaks classic <script> loading');
  for (const name of ['sha256Hex', 'compareModels', 'lipSweep', 'holeSweep', 'sweepForModel', 'probeResult',
    'contourData', 'canonicalState', 'encodeHash', 'decodeHash', 'auditPayload', 'auditDigest',
    'verifyDigest', 'tamperPayload', 'exportJSON', 'exportCSV', 'exportMarkdown', 'csvCell',
    'runSelfTests', 'eulerReport', 'modelReport', 'filamentGrams', 'stableStringify', 'byteLen',
    'normalizeProbe', 'defaultProbe', 'sweepOffsets', 'surfaceArea', 'polyArea', 'distToPoly', 'pointInPoly']) {
    assert.equal(typeof LAB[name], 'function', `missing ${name}`);
  }
});

test('LAB: MATERIALS, NOZZLES, sweep ranges, and wall ratio constant are frozen and sane', () => {
  assert.ok(Object.isFrozen(LAB.MATERIALS));
  assert.deepEqual(Object.keys(LAB.MATERIALS), ['PLA', 'PETG', 'ABS']);
  for (const m of Object.values(LAB.MATERIALS)) assert.ok(m.density > 0 && m.density < 3);
  assert.deepEqual([...LAB.NOZZLES], [0.4, 0.6]);
  assert.equal(LAB.MIN_WALL_RATIO, 2);
  assert.equal(LAB.LIP_SWEEP.length, 13);
  assert.equal(LAB.LIP_SWEEP[0], 0.4);
  assert.equal(LAB.LIP_SWEEP.at(-1), 1.6);
  assert.deepEqual([...LAB.HOLE_SWEEP], [4, 5, 6, 7, 8, 9, 10]);
});

test('LAB: utf8 byte length matches Buffer.byteLength on ASCII, multibyte, and emoji input', () => {
  for (const s of ['', 'abc', 'Orpheus × Badge', 'ümläut', 'sha256', '\u{1f600}emoji', 'line\nbreak']) {
    assert.equal(LAB.byteLen(s), Buffer.byteLength(s), JSON.stringify(s));
  }
});

test('LAB: sha256Hex rejects non-string input', () => {
  for (const bad of [undefined, null, 42, [], {}, Buffer.from('abc')]) {
    assert.throws(() => LAB.sha256Hex(bad), TypeError, JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------- SHA-256 */

const SHA_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ['The quick brown fox jumps over the lazy dog.', 'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
];
for (const [input, expected] of SHA_VECTORS) {
  test(`SHA-256 KAT: ${input.length}-byte message`, () => {
    assert.equal(LAB.sha256Hex(input), expected);
  });
}
test('SHA-256: one million a characters matches the published digest', () => {
  assert.equal(LAB.sha256Hex('a'.repeat(1e6)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
for (const s of ['bakebuild', 'orpheus_circuit_crest_cutter', 'üñíçødé', '\u{1f525}', 'a'.repeat(4096)]) {
  test(`SHA-256 parity with node:crypto for ${JSON.stringify(s.slice(0, 16))}`, () => {
    assert.equal(LAB.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  });
}
test('SHA-256 UTF-8 encoding replaces lone surrogates like TextEncoder', () => {
  for (const s of ['\ud800', '\udfff', 'a\ud800z']) {
    assert.equal(LAB.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});
test('SHA-256 is deterministic and output format is 64 lowercase hex chars', () => {
  const a = LAB.sha256Hex('bakebuild-studio audit');
  assert.equal(a, LAB.sha256Hex('bakebuild-studio audit'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

/* --------------------------------------------------------- comparator */

const REPORTS = LAB.compareModels();
test('LAB: compareModels returns one report per design in DESIGNS order', () => {
  assert.deepEqual(REPORTS.map((r) => r.id), CAD.DESIGNS.map((d) => d.id));
});
test('LAB: compareModels is deterministic across calls', () => {
  assert.deepEqual(LAB.compareModels(), REPORTS);
});
for (const r of REPORTS) {
  test(`report ${r.id}: dimensions and bounds are finite and inside the envelope`, () => {
    assert.equal(r.dimensions.length, 3);
    assert.ok(r.dimensions.every((v) => Number.isFinite(v) && v > 0));
    const limit = r.type === 'cutter' ? 100 : 80;
    assert.ok(r.dimensions.every((v) => v <= limit + 1e-6));
    for (let i = 0; i < 3; i += 1) {
      const model = CAD.generate(r.id);
      assert.ok(Math.abs(r.bounds.min[i] - model.bounds.min[i]) < 1e-6);
      assert.ok(Math.abs(r.bounds.max[i] - model.bounds.max[i]) < 1e-6);
    }
  });
  test(`report ${r.id}: signed volume positive and surface area positive`, () => {
    assert.ok(r.volume > 0 && Number.isFinite(r.volume));
    assert.ok(r.surfaceArea > 0 && Number.isFinite(r.surfaceArea));
    const model = CAD.generate(r.id);
    assert.equal(r.volume, Math.round(signedVolume(model.triangles) * 1e6) / 1e6);
  });
  test(`report ${r.id}: genus-1 Euler characteristic with a clean manifold census`, () => {
    assert.equal(r.topo.chi, 0, `chi ${r.topo.chi}`);
    assert.equal(r.topo.boundary, 0);
    assert.equal(r.topo.nonManifold, 0);
    assert.equal(r.topo.flipped, 0);
    assert.equal(r.topo.degenerate, 0);
    assert.equal(r.topo.nan, 0);
    const rep = manifoldReport(CAD.generate(r.id).triangles);
    assert.equal(r.topo.edges, rep.uniqueEdges, 'engine and parser agree on edge count');
  });
  test(`report ${r.id}: STEP entity count and byte length match the fresh serializer`, () => {
    const step = CAD.toSTEP(CAD.generate(r.id));
    assert.equal(r.step.entities, (step.match(/^#\d+=/gm) || []).length);
    assert.equal(r.step.bytes, Buffer.byteLength(step));
    assert.ok(r.step.entities > 1000, 'real B-rep entity graph');
  });
  test(`report ${r.id}: STL facet count parity and byte length`, () => {
    const model = CAD.generate(r.id);
    const stl = CAD.toSTL(model);
    assert.equal(r.stl.facets, model.triangles.length);
    assert.equal(r.stl.facets, (stl.match(/facet normal/g) || []).length);
    assert.equal(r.stl.bytes, Buffer.byteLength(stl));
  });
  test(`report ${r.id}: filament mass is positive and ordered PETG > PLA > ABS`, () => {
    for (const k of Object.keys(LAB.MATERIALS)) assert.ok(r.mass[k] > 0, `${r.id} ${k}`);
    assert.ok(r.mass.PETG > r.mass.PLA, 'PETG is densest');
    assert.ok(r.mass.PLA > r.mass.ABS, 'ABS is lightest');
  });
}
for (const k of ['PLA', 'PETG', 'ABS']) {
  test(`filament grams: ${k} equals volume/1000 x density within rounding`, () => {
    for (const r of REPORTS) {
      const expected = Math.round((r.volume / 1000) * LAB.MATERIALS[k].density * 1000) / 1000;
      assert.ok(Math.abs(r.mass[k] - expected) < 0.001, `${r.id} ${k}`);
    }
  });
}
test('LAB: filamentGrams returns null for unknown materials', () => {
  assert.equal(LAB.filamentGrams(1000, 'WOOD'), null);
  assert.equal(LAB.filamentGrams(1000, 'pla'), null, 'material ids are case sensitive');
  assert.equal(LAB.filamentGrams(1000, 'PLA'), 1.24, '1 cm^3 of PLA masses 1.24 g');
});

/* ------------------------------------------------------------ sweeps */

for (const id of CUTTER_IDS) {
  test(`lipSweep ${id}: covers 0.4 to 1.6 mm in 0.1 steps`, () => {
    const rows = LAB.lipSweep(id, 0.4);
    assert.equal(rows.length, 13);
    assert.deepEqual(rows.map((r) => r.x), LAB.LIP_SWEEP.map((w) => Math.round(w * 1e6) / 1e6));
  });
  for (const w of LAB.LIP_SWEEP) {
    test(`lipSweep ${id} w=${w}: simple contour, positive volume, correct ratio`, () => {
      const rows = LAB.lipSweep(id, 0.4);
      const row = rows.find((r) => r.x === w);
      assert.ok(row, 'row present');
      assert.equal(row.crossings, 0, 'offset contour stays simple');
      assert.ok(row.volume > 0, 'swept band volume positive');
      assert.equal(row.ratio, Math.round((w / 0.4) * 1e6) / 1e6);
      assert.equal(row.printable, w / 0.4 >= 2, 'printable only above the 2.0 wall ratio');
    });
  }
  test(`lipSweep ${id} on 0.6 mm nozzle: only lips >= 1.2 mm print`, () => {
    const rows = LAB.lipSweep(id, 0.6);
    for (const row of rows) {
      assert.equal(row.ratio, Math.round((row.width / 0.6) * 1e6) / 1e6);
      assert.equal(row.printable, row.width / 0.6 >= 2);
    }
  });
  test(`lipSweep ${id}: swept band volume grows monotonically with width`, () => {
    const rows = LAB.lipSweep(id, 0.4);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].volume > rows[i - 1].volume);
  });
}
test('lipSweep rejects unknown models, non-cutters, and bad nozzle widths', () => {
  assert.throws(() => LAB.lipSweep('ghost', 0.4), /Unknown design/);
  assert.throws(() => LAB.lipSweep(KEYRING_ID, 0.4), /cutter/);
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
    assert.throws(() => LAB.lipSweep(CUTTER_IDS[0], bad), /Nozzle/);
  }
});
test('sweepOffsets reports errors instead of throwing on invalid widths', () => {
  const contour = CAD.profile(CAD.DESIGNS[0]);
  const rows = LAB.sweepOffsets(contour, [0.8, NaN, -2, Infinity], 0.4, 1.5);
  assert.equal(rows[0].crossings, 0);
  for (const bad of rows.slice(1)) {
    assert.equal(bad.printable, false);
    assert.equal(bad.volume, null);
    assert.ok(bad.error, 'error captured');
  }
});
test('sweepOffsets marks a self-intersecting source contour unprintable', () => {
  const bowtie = [[0, 0], [4, 4], [4, 0], [0, 4]];
  const rows = LAB.sweepOffsets(bowtie, [0.4], 0.4, 1.5);
  assert.equal(rows.length, 1);
  if (rows[0].crossings !== null) {
    assert.ok(rows[0].crossings > 0 || rows[0].printable === false, 'bowtie cannot yield a clean sweep');
  }
});

test('holeSweep covers the 4 to 10 mm carabiner range', () => {
  const rows = LAB.holeSweep(0.4);
  assert.deepEqual(rows.map((r) => r.hole), [4, 5, 6, 7, 8, 9, 10]);
});
for (const d of LAB.HOLE_SWEEP) {
  test(`holeSweep d=${d}: hole fits inside the body with positive ring and volume`, () => {
    const row = LAB.holeSweep(0.4).find((r) => r.hole === d);
    assert.ok(row);
    assert.equal(row.fits, true, 'hole boundary inside the outline');
    assert.equal(row.crossings, 0, 'hole polygon is simple');
    assert.equal(row.clearDiameter, d);
    assert.ok(row.minRing > 0, `ring clearance ${row.minRing}`);
    assert.ok(row.volume > 0, 'annulus volume positive');
    assert.equal(row.ratio, Math.round((row.minRing / 0.4) * 1e6) / 1e6);
    assert.equal(row.printable, row.ratio >= 2);
  });
}
test('holeSweep ring clearance shrinks as the hole grows', () => {
  const rows = LAB.holeSweep(0.4);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].minRing < rows[i - 1].minRing, 'monotonic ring');
});
test('holeSweep on 0.6 mm nozzle recomputes ratios but keeps geometry', () => {
  const a = LAB.holeSweep(0.4), b = LAB.holeSweep(0.6);
  assert.deepEqual(a.map((r) => r.minRing), b.map((r) => r.minRing), 'same measured ring');
  for (const row of b) assert.equal(row.ratio, Math.round((row.minRing / 0.6) * 1e6) / 1e6);
});
test('holeSweep rejects bad nozzles and bad diameters', () => {
  assert.throws(() => LAB.holeSweep(0), /Nozzle/);
  assert.throws(() => LAB.holeSweep(-0.4), /Nozzle/);
  assert.throws(() => LAB.holeSweep(NaN), /Nozzle/);
  const rows = LAB.holeSweep(0.4, [6, NaN, -3]);
  assert.equal(rows[0].printable, true);
  for (const bad of rows.slice(1)) assert.equal(bad.printable, false);
});
test('sweepForModel routes cutters to lip rows and the keyring to hole rows', () => {
  for (const id of CUTTER_IDS) {
    const s = LAB.sweepForModel(id, 0.4);
    assert.equal(s.kind, 'lip');
    assert.equal(s.rows.length, 13);
  }
  const s = LAB.sweepForModel(KEYRING_ID, 0.4);
  assert.equal(s.kind, 'hole');
  assert.equal(s.rows.length, 7);
  assert.throws(() => LAB.sweepForModel('ghost', 0.4), /Unknown design/);
});

/* ------------------------------------------------------------- probes */

for (const id of CUTTER_IDS) {
  test(`probeResult ${id}: lip probe reports width, crossings, volume, ratio`, () => {
    const p = LAB.probeResult(id, 0.4, 0.9);
    assert.equal(p.kind, 'lip');
    assert.equal(p.width, 0.9);
    assert.equal(p.x, 0.9);
    assert.equal(p.crossings, 0);
    assert.ok(p.volume > 0);
    assert.equal(p.ratio, Math.round(0.9 / 0.4 * 1e6) / 1e6);
    assert.equal(p.printable, true);
  });
}
test('probeResult keyring: hole probe reports fit, ring clearance, clear diameter', () => {
  const p = LAB.probeResult(KEYRING_ID, 0.4, 8);
  assert.equal(p.kind, 'hole');
  assert.equal(p.hole, 8);
  assert.equal(p.clearDiameter, 8);
  assert.equal(p.fits, true);
  assert.ok(p.minRing > 0);
  assert.equal(p.printable, p.ratio >= 2);
});
test('probeResult rejects unknown models, bad nozzles, and hostile probes', () => {
  assert.throws(() => LAB.probeResult('ghost', 0.4, 1), /Unknown design/);
  for (const n of [0, -0.4, NaN]) assert.throws(() => LAB.probeResult(CUTTER_IDS[0], n, 1), /Nozzle/);
  for (const p of [0, -1, NaN, Infinity, 'x', null, undefined, 51]) {
    assert.throws(() => LAB.probeResult(CUTTER_IDS[0], 0.4, p), /Probe/);
  }
});
test('normalizeProbe clamps into per-type limits and defaults hostile values', () => {
  assert.equal(LAB.normalizeProbe(CUTTER_IDS[0], 99), 8);
  assert.equal(LAB.normalizeProbe(CUTTER_IDS[0], 0.01), 0.1);
  assert.equal(LAB.normalizeProbe(KEYRING_ID, 99), 20);
  assert.equal(LAB.normalizeProbe(KEYRING_ID, 0.5), 1);
  for (const bad of [NaN, -1, 0, Infinity, 'x', undefined, null]) {
    assert.equal(LAB.normalizeProbe(CUTTER_IDS[0], bad), 0.8, `cutter default for ${bad}`);
    assert.equal(LAB.normalizeProbe(KEYRING_ID, bad), 6, `keyring default for ${bad}`);
  }
});
test('defaultProbe returns the shipped lip width for cutters and the clear hole for keyrings', () => {
  for (const id of CUTTER_IDS) assert.equal(LAB.defaultProbe(id), CAD.RULES.lip);
  assert.equal(LAB.defaultProbe(KEYRING_ID), CAD.RULES.holeDiameter);
  assert.throws(() => LAB.defaultProbe('ghost'), /Unknown design/);
});
test('contourData gives cutter offsets and the keyring clear hole in raw mm', () => {
  for (const id of CUTTER_IDS) {
    const d = LAB.contourData(id);
    assert.equal(d.type, 'cutter');
    assert.equal(d.offsets.length, 3);
    assert.deepEqual(d.offsets.map((o) => o.label), ['lip', 'wall', 'rim']);
    assert.deepEqual(d.offsets.map((o) => o.width), [0.8, 2, 5]);
    assert.ok(d.extent >= Math.max(...d.offsets.at(-1).points.flat().map(Math.abs)));
    assert.equal(d.hole, null);
  }
  const d = LAB.contourData(KEYRING_ID);
  assert.equal(d.type, 'keyring');
  assert.equal(d.offsets.length, 0);
  assert.equal(d.hole.clearRadius, 3);
  assert.equal(d.hole.points.length, 64);
  for (const p of d.hole.points) assert.ok(LAB.pointInPoly(p, d.outer), 'hole vertex inside outline');
});

/* -------------------------------------------------------------- codec */

const CODEC_STATES = [
  { model: 'orpheus_circuit_crest_cutter', nozzle: 0.4, material: 'PLA', probe: 0.8 },
  { model: 'hex_gear_logic_gate_cutter', nozzle: 0.6, material: 'PETG', probe: 1.4 },
  { model: 'stepcheck_sigma_badge_cutter', nozzle: 0.6, material: 'ABS', probe: 1.6 },
  { model: 'orpheus_fusering_keyring', nozzle: 0.4, material: 'ABS', probe: 6 },
  { model: 'orpheus_fusering_keyring', nozzle: 0.6, material: 'PLA', probe: 10 },
];
for (const s of CODEC_STATES) {
  test(`codec round trip: ${s.model} n=${s.nozzle} f=${s.material} p=${s.probe}`, () => {
    const hash = LAB.encodeHash(s);
    assert.ok(hash.startsWith('#bbs='));
    assert.deepEqual(LAB.decodeHash(hash), s);
    assert.deepEqual(LAB.decodeHash(hash.slice(1)), s, 'works without the # prefix');
  });
}
test('codec emits a stable compact key order for a canonical state', () => {
  const h = LAB.encodeHash({ model: 'hex_gear_logic_gate_cutter', nozzle: 0.6, material: 'PETG', probe: 1.2 });
  assert.equal(h, '#bbs=m=hex_gear_logic_gate_cutter&n=0.6&f=PETG&p=1.2');
});
test('codec fills omitted fields with defaults instead of failing', () => {
  assert.deepEqual(LAB.decodeHash('#bbs=m=hex_gear_logic_gate_cutter'),
    { model: 'hex_gear_logic_gate_cutter', nozzle: 0.4, material: 'PLA', probe: 0.8 });
  assert.deepEqual(LAB.decodeHash('#bbs=m=orpheus_fusering_keyring'),
    { model: 'orpheus_fusering_keyring', nozzle: 0.4, material: 'PLA', probe: 6 });
});
const BAD_HASHES = [
  '', '#', 'bbs=', '#bbs=', '#bsp=m=x', '#bbs=m', '#bbs==x', '#bbs=m=x=m',
  '#bbs=m=ghost', '#bbs=m=__proto__', '#bbs=__proto__=x', '#bbs=constructor=y',
  '#bbs=m=x&constructor=y', '#bbs=x=1', '#bbs=M=orpheus_fusering_keyring',
  '#bbs=m=orpheus_fusering_keyring&m=hex_gear_logic_gate_cutter',
  '#bbs=m=hex_gear_logic_gate_cutter&n=0.5', '#bbs=n=abc', '#bbs=f=WOOD', '#bbs=f=pla',
  '#bbs=p=-1', '#bbs=p=0', '#bbs=p=NaN', '#bbs=p=abc', '#bbs=p=1e9', '#bbs=p=51',
  '#bbs=m=%zz', '#bbs=m=%', '#bbs=m=hex_gear_logic_gate_cutter&extra=1',
  '#bbs=m=hex_gear_logic_gate_cutter&n=0.4&f=PLA&p=0.8&x=',
  '#bbs=' + 'm=x&'.repeat(80), '#bbs=m=hex_gear_logic_gate_cutter;alert(1)',
  'javascript:alert(1)', '#other=1',
];
for (const bad of BAD_HASHES) {
  test(`codec rejects hostile hash ${JSON.stringify(bad.slice(0, 40))}`, () => {
    assert.equal(LAB.decodeHash(bad), null);
  });
}
for (const bad of [null, undefined, 42, [], {}, true, Symbol('x')]) {
  test(`codec rejects non-string input ${String(bad)}`, () => {
    assert.equal(LAB.decodeHash(bad), null);
  });
}
test('encodeHash returns null for states that fail normalization', () => {
  for (const bad of [null, { model: 'ghost' }, { model: 'orpheus_fusering_keyring', nozzle: 1 }, { material: 'WOOD' }, { probe: -2 }, 'x', 7]) {
    assert.equal(LAB.encodeHash(bad), null, JSON.stringify(bad));
  }
});
test('an empty state object normalizes to full defaults and still encodes', () => {
  assert.equal(LAB.encodeHash({}), '#bbs=m=orpheus_circuit_crest_cutter&n=0.4&f=PLA&p=0.8');
});
test('canonicalState reads long keys, short keys, and defaults; blocks pollution', () => {
  assert.deepEqual(
    LAB.canonicalState({ model: 'orpheus_fusering_keyring', nozzle: 0.6, material: 'PETG', probe: 5 }),
    { model: 'orpheus_fusering_keyring', nozzle: 0.6, material: 'PETG', probe: 5 });
  assert.deepEqual(
    LAB.canonicalState({ m: 'hex_gear_logic_gate_cutter', n: '0.6', f: 'ABS', p: '1.2' }),
    { model: 'hex_gear_logic_gate_cutter', nozzle: 0.6, material: 'ABS', probe: 1.2 },
    'string values normalize to numbers');
  assert.equal(LAB.canonicalState(null), null);
  assert.equal(LAB.canonicalState([1, 2]), null);
  assert.equal(LAB.canonicalState({ model: 'ghost' }), null);
  const polluted = LAB.canonicalState(JSON.parse('{"m":"hex_gear_logic_gate_cutter","__proto__":{"x":1}}'));
  assert.ok(polluted, 'decoded __proto__ own property is ignored, not read');
  assert.equal({}.x, undefined, 'no prototype pollution');
});

/* ------------------------------------------------------ digest + exports */

const STATES = {
  cutter: { model: 'orpheus_circuit_crest_cutter', nozzle: 0.4, material: 'PLA', probe: 0.8 },
  keyring: { model: 'orpheus_fusering_keyring', nozzle: 0.6, material: 'PETG', probe: 6 },
};
test('auditPayload returns one cached object per normalized state', () => {
  const a = LAB.auditPayload(STATES.cutter);
  const b = LAB.auditPayload({ ...STATES.cutter });
  const c = LAB.auditPayload(STATES.keyring);
  assert.ok(a && c);
  assert.equal(a, b, 'identical states share the cached payload');
  assert.notEqual(a, c, 'distinct states get distinct payloads');
  assert.equal(a.digest, LAB.sha256Hex(a.canonical), 'digest equals canonical SHA-256');
  assert.equal(a.canonical, LAB.stableStringify(a.payload));
});
test('auditPayload returns null for invalid states', () => {
  for (const bad of [null, { model: 'ghost' }, { nozzle: 1 }, { material: 'WOOD' }, { probe: -1 }, 'x', 7, []]) {
    assert.equal(LAB.auditPayload(bad), null, JSON.stringify(bad));
  }
});
test('auditPayload on an empty state stamps the default-state payload', () => {
  const st = LAB.auditPayload({});
  assert.ok(st, 'defaults normalize');
  assert.deepEqual(st.state, { model: CAD.DESIGNS[0].id, nozzle: 0.4, material: 'PLA', probe: CAD.RULES.lip });
});
test('stableStringify is key-order independent and handles nested arrays', () => {
  assert.equal(LAB.stableStringify({ b: 1, a: [3, { y: 2, x: 1 }] }), LAB.stableStringify({ a: [3, { x: 1, y: 2 }], b: 1 }));
  assert.equal(LAB.stableStringify(null), 'null');
  assert.equal(LAB.stableStringify('a'), '"a"');
});
for (const [label, s] of Object.entries(STATES)) {
  test(`exportJSON ${label}: integrity digest matches the stamped payload`, () => {
    const st = LAB.auditPayload(s);
    const parsed = JSON.parse(LAB.exportJSON(s));
    assert.equal(parsed.integrity.algorithm, 'SHA-256');
    assert.equal(parsed.integrity.digest, st.digest);
    assert.equal(parsed.schema, 'bakebuild-audit/1');
    assert.deepEqual(parsed.state, st.state);
    assert.equal(parsed.models.length, 4);
    assert.equal(LAB.verifyDigest(parsed.models && { ...parsed, integrity: undefined } ? st.payload : st.payload, st.digest), true);
  });
  test(`exportCSV ${label}: provenance digest, header, model rows, formula safety`, () => {
    const st = LAB.auditPayload(s);
    const text = LAB.exportCSV(s);
    const lines = text.trim().split('\n');
    assert.match(lines[0], /^# bakebuild-studio audit brief v1$/);
    assert.ok(lines[2].endsWith(st.digest));
    assert.match(lines[3], /^model,type,dim_x_mm,dim_y_mm,dim_z_mm,volume_mm3,surface_mm2,euler_chi/);
    assert.ok(lines.slice(4, 8).every((l) => l.split(',').length >= 14), 'four model rows');
    for (const line of lines) assert.ok(!/^[=+\-@\t]/.test(line), `formula-safe line: ${line.slice(0, 30)}`);
  });
  test(`exportMarkdown ${label}: comparison table plus digest footer`, () => {
    const st = LAB.auditPayload(s);
    const text = LAB.exportMarkdown(s);
    assert.match(text, /^## BakeBuild Studio audit brief/m);
    assert.ok(text.includes('| Model | Bounds (mm) |'));
    assert.ok(text.includes('SHA-256 audit digest: `' + st.digest + '`'));
    assert.equal((text.match(/^\| [A-Z]/gm) || []).length, 5, 'header plus four rows');
  });
}
test('exact SHA-256 parity across fingerprint, JSON, CSV, and Markdown for both states', () => {
  for (const s of Object.values(STATES)) {
    const st = LAB.auditPayload(s);
    const jsonDigest = JSON.parse(LAB.exportJSON(s)).integrity.digest;
    const csvDigest = /# sha256 ([0-9a-f]{64})/.exec(LAB.exportCSV(s))[1];
    const mdDigest = /SHA-256 audit digest: `([0-9a-f]{64})`/.exec(LAB.exportMarkdown(s))[1];
    assert.equal(jsonDigest, st.digest);
    assert.equal(csvDigest, st.digest);
    assert.equal(mdDigest, st.digest);
    assert.equal(LAB.auditDigest(s), st.digest);
  }
});
test('exports return null instead of throwing on invalid states', () => {
  for (const bad of [null, { model: 'ghost' }, 'x']) {
    assert.equal(LAB.exportJSON(bad), null);
    assert.equal(LAB.exportCSV(bad), null);
    assert.equal(LAB.exportMarkdown(bad), null);
    assert.equal(LAB.auditDigest(bad), null);
  }
});
const CSV_CASES = [
  ['=CMD()', "'=CMD()"], ['+1', "'+1"], ['-2', "'-2"], ['@handle', "'@handle"],
  ['\t=1+1', "'\t=1+1"], ['\r=cmd', '"\'\r=cmd"'], ['plain', 'plain'], ['1.5', '1.5'],
  ['with,comma', '"with,comma"'], ['say "hi"', '"say ""hi"""'], ['a\nb', '"a\nb"'],
];
for (const [input, expected] of CSV_CASES) {
  test(`csvCell ${JSON.stringify(input)} escapes to ${JSON.stringify(expected)}`, () => {
    assert.equal(LAB.csvCell(input), expected);
  });
}
test('verifyDigest accepts the stamped payload and rejects every tamper', () => {
  const st = LAB.auditPayload(STATES.cutter);
  assert.equal(LAB.verifyDigest(st.payload, st.digest), true);
  assert.equal(LAB.verifyDigest(LAB.tamperPayload(st.payload), st.digest), false, 'mutated volume flagged');
  const stateTamper = JSON.parse(JSON.stringify(st.payload));
  stateTamper.state.material = 'ABS';
  assert.equal(LAB.verifyDigest(stateTamper, st.digest), false, 'mutated state flagged');
  const added = JSON.parse(JSON.stringify(st.payload));
  added.injected = true;
  assert.equal(LAB.verifyDigest(added, st.digest), false, 'injected field flagged');
});
test('verifyDigest fails closed on malformed digests and payloads', () => {
  const st = LAB.auditPayload(STATES.cutter);
  for (const bad of ['', 'xyz', st.digest.toUpperCase().replace('X', 'x') + ' ', st.digest.slice(0, 63), null, 42]) {
    assert.equal(LAB.verifyDigest(st.payload, bad), false, JSON.stringify(bad).slice(0, 30));
  }
  for (const bad of [null, 'x', 42, []]) assert.equal(LAB.verifyDigest(bad, st.digest), false);
});
test('tamperPayload flips the first model volume and survives JSON cloning', () => {
  const st = LAB.auditPayload(STATES.cutter);
  const t = LAB.tamperPayload(st.payload);
  assert.notEqual(t.models[0].volume, st.payload.models[0].volume);
  assert.equal(t.models[1].volume, st.payload.models[1].volume, 'only one field mutated');
  assert.equal(LAB.verifyDigest(t, LAB.sha256Hex(LAB.stableStringify(t))), true, 'tampered copy is itself verifiable');
});
test('distinct states produce distinct digests for every changed field', () => {
  const base = LAB.auditDigest(STATES.cutter);
  const variants = [
    { ...STATES.cutter, model: 'hex_gear_logic_gate_cutter' },
    { ...STATES.cutter, nozzle: 0.6 },
    { ...STATES.cutter, material: 'ABS' },
    { ...STATES.cutter, probe: 1.6 },
  ];
  const seen = new Set([base]);
  for (const v of variants) {
    const d = LAB.auditDigest(v);
    assert.ok(d && !seen.has(d), 'digest differs per state');
    seen.add(d);
  }
});

/* ---------------------------------------------------------- self tests */

test('SELF_TESTS has at least sixteen entries with unique slug names', () => {
  assert.ok(LAB.SELF_TESTS.length >= 16, LAB.SELF_TESTS.length);
  const names = LAB.SELF_TESTS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  for (const n of names) assert.match(n, /^[a-z0-9][a-z0-9_-]*$/, `slug ${n}`);
});
test('runSelfTests passes every check deterministically', () => {
  const a = LAB.runSelfTests();
  assert.equal(a.length, LAB.SELF_TESTS.length);
  for (const r of a) {
    assert.equal(r.pass, true, `${r.name}: ${r.detail}`);
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.detail, 'string');
  }
  assert.deepEqual(LAB.runSelfTests().map((r) => r.pass), a.map((r) => r.pass), 'deterministic');
});
test('runSelfTests reports failures instead of throwing when a check breaks', () => {
  const original = LAB.SELF_TESTS.find((t) => t.name === 'sha256-kat-empty').run;
  const probe = { name: 'probe-fail', run: () => { throw new Error('boom'); } };
  const results = [probe].map((t) => {
    try { t.run(); return { name: t.name, pass: true, detail: '' }; }
    catch (e) { return { name: t.name, pass: false, detail: String(e.message) }; }
  });
  assert.equal(results[0].pass, false);
  assert.match(results[0].detail, /boom/);
  assert.equal(typeof original, 'function');
});

/* L567 regression tests: malformed physical inputs and canonical export data */
test('L567 codec rejects probe values outside the selected model type limits', () => {
  assert.equal(LAB.decodeHash('#bbs=m=hex_gear_logic_gate_cutter&n=0.4&f=PLA&p=8.1'), null, 'cutter lip probe above 8 mm');
  assert.equal(LAB.decodeHash('#bbs=m=hex_gear_logic_gate_cutter&n=0.4&f=PLA&p=0.09'), null, 'cutter lip probe below 0.1 mm');
  assert.equal(LAB.decodeHash('#bbs=m=orpheus_fusering_keyring&n=0.4&f=PLA&p=20.1'), null, 'keyring hole probe above 20 mm');
  assert.equal(LAB.decodeHash('#bbs=m=orpheus_fusering_keyring&n=0.4&f=PLA&p=0.9'), null, 'keyring hole probe below 1 mm');
  assert.ok(LAB.decodeHash('#bbs=m=hex_gear_logic_gate_cutter&n=0.4&f=PLA&p=8'));
  assert.ok(LAB.decodeHash('#bbs=m=orpheus_fusering_keyring&n=0.4&f=PLA&p=20'));
});

test('L567 stableStringify rejects non-finite numbers and cyclic structures', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => LAB.stableStringify({ v: bad }), /non-finite/);
  }
  const cyclic = { x: 1 };
  cyclic.self = cyclic;
  assert.throws(() => LAB.stableStringify(cyclic), /cyclic/);
});

test('L567 filamentGrams rejects negative and non-finite volumes', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => LAB.filamentGrams(bad, 'PLA'), /volume/i);
  }
  assert.equal(LAB.filamentGrams(0, 'PLA'), 0);
});
test('filamentGrams keeps huge finite volumes finite because unit conversion happens first', () => {
  const grams = LAB.filamentGrams(1e308, 'PLA');
  assert.ok(Number.isFinite(grams));
  assert.ok(grams > 0);
});

test('L567 csvCell quotes embedded carriage returns as well as newlines', () => {
  assert.equal(LAB.csvCell('a\rb'), '"a\rb"');
});
test('csvCell guards formula payloads hidden behind whitespace or invisible characters', () => {
  for (const input of [' =1+1', '\n+2', '\u200b@sum', '\ufeff=cmd']) {
    const escaped = LAB.csvCell(input);
    const firstContentChar = escaped.charAt(0) === '"' ? escaped.charAt(1) : escaped.charAt(0);
    assert.equal(firstContentChar, "'", input);
  }
});

test('csvCell escapes direct control prefixes and preserves negative numbers', () => {
  for (const input of ['\tx', '\rx', '\u200b=1+1', '\u061c+2']) {
    const escaped = LAB.csvCell(input);
    const first = escaped.charAt(0) === '"' ? escaped.charAt(1) : escaped.charAt(0);
    assert.equal(first, "'", input);
  }
  assert.equal(LAB.csvCell(-2), '-2');
});
