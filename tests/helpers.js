// Shared verification helpers for the BakeBuild Studio test suite.
// Pure Node, zero dependencies. Every parser below reads the actual shipped
// file text, so the tests exercise real artifacts rather than reusing the
// generator's in-memory objects.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXPORTS = path.join(ROOT, 'exports');

export function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

export function readExport(name) {
  return fs.readFileSync(path.join(EXPORTS, name), 'utf8');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Quantize coordinates so the same geometric vertex compares equal. */
export function vertexKey(p) {
  return p.map((v) => Math.round(v * 1e5) / 1e5).join(',');
}

/** Parse the shipped ASCII STL into triangles of [x,y,z] points. */
export function parseAsciiStl(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== lines[0].trim()) throw new Error('unexpected leading whitespace');
  const header = lines[0].trim();
  if (!/^solid\s+\S/.test(header)) throw new Error('missing solid header');
  const facets = [];
  let current = null;
  let stage = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('facet normal')) {
      if (current) throw new Error('nested facet');
      current = { normal: line.slice('facet normal'.length).trim().split(/\s+/).map(Number), vertices: [] };
      stage = 'facet';
    } else if (line === 'outer loop') {
      stage = 'loop';
    } else if (line.startsWith('vertex')) {
      if (stage !== 'loop') throw new Error(`vertex outside loop at line ${i + 1}`);
      current.vertices.push(line.slice('vertex'.length).trim().split(/\s+/).map(Number));
    } else if (line === 'endloop') {
      stage = 'facet';
    } else if (line === 'endfacet') {
      if (current.vertices.length !== 3) throw new Error('facet without 3 vertices');
      if (current.normal.length !== 3 || current.normal.some((v) => !Number.isFinite(v))) {
        throw new Error('invalid facet normal');
      }
      current.normal.forEach((v) => { if (!Number.isFinite(v)) throw new Error('NaN normal'); });
      facets.push(current);
      current = null;
      stage = null;
    } else if (line.startsWith('endsolid')) {
      if (current) throw new Error('unterminated facet');
      if (line.slice('endsolid'.length).trim() !== header.slice('solid'.length).trim()) {
        throw new Error('solid name mismatch');
      }
    } else if (line !== '') {
      throw new Error(`unexpected STL token at line ${i + 1}: ${line}`);
    }
  }
  if (current) throw new Error('missing endfacet');
  return { name: header.slice('solid'.length).trim(), triangles: facets.map((f) => f.vertices) };
}

/** Signed volume of a closed triangle soup: sum of scalar triple products / 6. */
export function signedVolume(triangles) {
  return triangles.reduce((sum, t) => {
    const [a, b, c] = t;
    return sum + (a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }, 0);
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function sub(a, b) {
  return a.map((v, i) => v - b[i]);
}

export function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

export function norm(a) {
  return Math.hypot(...a);
}

export function unit(a) {
  const n = norm(a);
  return a.map((v) => v / n);
}

export function boundsOf(triangles) {
  const pts = triangles.flat();
  const min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
  const max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
  return { min, max, dimensions: max.map((v, i) => v - min[i]) };
}

/**
 * Edge manifold check on a triangle soup. Each undirected edge must be used
 * exactly twice, and the two uses must traverse it in opposite directions so
 * adjacent faces have consistent winding. Empty or degenerate triangles are
 * rejected. Returns incidence statistics for further assertions.
 */
export function manifoldReport(triangles, tolerance = 1e-5) {
  const edges = new Map();
  let degenerate = 0;
  for (const t of triangles) {
    const n = norm(cross(sub(t[1], t[0]), sub(t[2], t[0])));
    if (!(n > tolerance)) degenerate += 1;
    for (let i = 0; i < 3; i += 1) {
      const a = vertexKey(t[i]);
      const b = vertexKey(t[(i + 1) % 3]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const direction = a < b ? 1 : -1;
      const rec = edges.get(key) || { count: 0, balance: 0 };
      rec.count += 1;
      rec.balance += direction;
      edges.set(key, rec);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let flipped = 0;
  for (const rec of edges.values()) {
    if (rec.count === 1) boundary += 1;
    else if (rec.count !== 2) nonManifold += 1;
    else if (rec.balance !== 0) flipped += 1;
  }
  return {
    triangles: triangles.length,
    uniqueEdges: edges.size,
    boundary,
    nonManifold,
    flipped,
    degenerate,
    vertices: new Set(triangles.flat().map(vertexKey)).size
  };
}

/** Compute the outward-facing area-weighted normal sum (should be ~0 for a closed solid). */
export function normalFlux(triangles) {
  const out = [0, 0, 0];
  for (const t of triangles) {
    const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
    for (let i = 0; i < 3; i += 1) out[i] += n[i] / 2;
  }
  return out;
}

/** Parse STEP DATA section into id -> {type, args} records. */
export function parseStepEntities(text) {
  const entities = new Map();
  const re = /^#(\d+)\s*=\s*(.*);\s*$/;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = re.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const body = m[2];
    const typeMatch = /^([A-Z_][A-Z0-9_]*)\s*\(/.exec(body) || /^\(\s*([A-Z_][A-Z0-9_]*)\s*\(/.exec(body);
    entities.set(id, { id, body, type: typeMatch ? typeMatch[1] : 'COMPLEX', refs: [...body.matchAll(/#(\d+)/g)].map((r) => Number(r[1])) });
  }
  return entities;
}

export function countStepType(text, type) {
  return (text.match(new RegExp(`\\b${type}\\(`, 'g')) || []).length;
}

/** Walk every text file in the repo (skipping .git) for compliance checks. */
export function repoTextFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

const TEXT_EXT = new Set(['.md', '.html', '.js', '.mjs', '.json', '.txt', '.py', '.css', '.stl', '.step', '.scad', '.csv', '.svg', '.yml']);

export function complianceTextFiles() {
  return repoTextFiles().filter((p) => TEXT_EXT.has(path.extname(p).toLowerCase()));
}
