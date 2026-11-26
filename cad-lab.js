/* Tolerance, wall-thickness and B-rep manifold audit lab. Pure JS, zero
 * dependencies: drives the BakeBuildCAD kernel, stamps one SHA-256 audit
 * digest per normalized state, and round-trips a strict #bbs= bookmark hash.
 * Classic-script safe (file://) and CommonJS friendly.
 */
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const engine = () => root.BakeBuildCAD;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const r3 = (v) => Math.round(v * 1e3) / 1e3;

  const MATERIALS = Object.freeze({
    PLA: Object.freeze({ name: 'PLA', density: 1.24 }),
    PETG: Object.freeze({ name: 'PETG', density: 1.27 }),
    ABS: Object.freeze({ name: 'ABS', density: 1.04 })
  });
  const NOZZLES = Object.freeze([0.4, 0.6]);
  const MIN_WALL_RATIO = 2;
  const LIP_BAND_HEIGHT = 1.5;
  const KEYRING_HEIGHT = 4;
  const PROBE_LIMITS = Object.freeze({ cutter: [0.1, 8], keyring: [1, 20] });
  const LIP_SWEEP = Object.freeze(Array.from({ length: 13 }, (_, i) => r6(0.4 + i * 0.1)));
  const HOLE_SWEEP = Object.freeze([4, 5, 6, 7, 8, 9, 10]);

  function cad() {
    const c = engine();
    if (!c) throw new Error('BakeBuildCAD engine is unavailable');
    return c;
  }
  function findDesign(modelId) {
    const d = cad().DESIGNS.find((x) => x.id === modelId);
    if (!d) throw new Error('Unknown design: ' + modelId);
    return d;
  }
  function checkNozzle(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0 || v > 5) throw new RangeError('Nozzle width must be a finite positive mm value');
    return v;
  }
  function checkProbe(p) {
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0 || v > 50) throw new RangeError('Probe value must be a finite positive mm value');
    return v;
  }

  /* ------------------------------------------------ UTF-8 + FIPS 180-4 SHA-256 */
  function utf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd);
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  const byteLen = (s) => utf8(s).length;
  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256Hex(input) {
    if (typeof input !== 'string') throw new TypeError('sha256Hex expects a string');
    const msg = utf8(input);
    const bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (let i = 7; i >= 0; i--) msg.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let block = 0; block < msg.length; block += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = (msg[block + i * 4] << 24) | (msg[block + i * 4 + 1] << 16) | (msg[block + i * 4 + 2] << 8) | msg[block + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0,
        (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0];
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  /* ---------------------------------------------------------- 2D geometry */
  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return a / 2;
  }
  function distSeg(p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
  }
  function distToPoly(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distSeg(p, poly[i], poly[(i + 1) % poly.length]));
    return best;
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* ------------------------------------------------- topology comparator */
  function surfaceArea(triangles) {
    let a = 0;
    for (const t of triangles) {
      const u = t[1].map((v, i) => v - t[0][i]), v = t[2].map((v, i) => v - t[0][i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      a += Math.hypot(n[0], n[1], n[2]) / 2;
    }
    return a;
  }
  function eulerReport(model) {
    const rep = cad().manifoldReport(model.triangles);
    const verts = new Set();
    for (const t of model.triangles) for (const p of t) verts.add(p.map((c) => Math.round(c * 1e6)).join(','));
    const V = verts.size, E = rep.edges, F = model.triangles.length;
    return {
      vertices: V, edges: E, faces: F, chi: V - E + F,
      boundary: rep.boundary, nonManifold: rep.nonManifold, flipped: rep.flipped,
      degenerate: rep.degenerate, nan: rep.nan
    };
  }
  function stepEntityCount(text) {
    return (text.match(/^#\d+=/gm) || []).length;
  }
  function filamentGrams(volumeMm3, materialId) {
    const m = MATERIALS[materialId];
    if (!m) return null;
    if (typeof volumeMm3 !== 'number' || !Number.isFinite(volumeMm3) || volumeMm3 < 0) {
      throw new RangeError('volume_mm3 must be a finite non-negative number');
    }
    return r3((volumeMm3 / 1000) * m.density);
  }
  function modelReport(modelId) {
    const c = cad();
    const model = c.generate(modelId);
    const step = c.toSTEP(model), stl = c.toSTL(model);
    const mass = {};
    for (const k of Object.keys(MATERIALS)) mass[k] = filamentGrams(model.volume, k);
    return {
      id: model.id, name: model.name, type: model.type,
      dimensions: model.dimensions.map(r6),
      bounds: { min: model.bounds.min.map(r6), max: model.bounds.max.map(r6) },
      volume: r6(model.volume),
      surfaceArea: r6(surfaceArea(model.triangles)),
      topo: eulerReport(model),
      step: { entities: stepEntityCount(step), bytes: byteLen(step) },
      stl: { facets: (stl.match(/facet normal/g) || []).length, bytes: byteLen(stl) },
      mass
    };
  }
  function compareModels() {
    return cad().DESIGNS.map((d) => modelReport(d.id));
  }

  /* ------------------------------------------------------- nozzle sweeps */
  // Offsets a contour at each width and reports simplicity, the swept band
  // volume at the given extrusion height, and the nozzle wall ratio.
  function sweepOffsets(contour, widths, nozzle, height) {
    const noz = checkNozzle(nozzle);
    const c = cad();
    const base = Math.abs(polyArea(contour));
    return widths.map((w) => {
      const width = Number(w);
      if (!Number.isFinite(width) || width <= 0) return { x: width, width, crossings: null, volume: null, ratio: null, printable: false, error: 'invalid width' };
      let pts = null, crossings = null;
      try {
        pts = c.offset(contour, width);
        crossings = c.polygonSelfIntersections(pts);
      } catch (e) {
        return { x: width, width: r6(width), crossings: null, volume: null, ratio: r6(width / noz), printable: false, error: String(e && e.message || e) };
      }
      const volume = (Math.abs(polyArea(pts)) - base) * height;
      const ratio = width / noz;
      return {
        x: r6(width), width: r6(width), crossings,
        volume: r6(volume), ratio: r6(ratio),
        printable: crossings === 0 && volume > 0 && ratio >= MIN_WALL_RATIO
      };
    });
  }
  function lipSweep(modelId, nozzle) {
    const d = findDesign(modelId);
    if (d.type !== 'cutter') throw new Error('Lip sweep only applies to cutter designs');
    return sweepOffsets(cad().profile(d), [...LIP_SWEEP], nozzle, LIP_BAND_HEIGHT);
  }
  function holeSweep(nozzle, diameters) {
    const noz = checkNozzle(nozzle);
    const c = cad();
    const d = c.DESIGNS.find((x) => x.type === 'keyring');
    const contour = c.profile(d), n = d.sectors;
    const base = Math.abs(polyArea(contour));
    return (diameters || [...HOLE_SWEEP]).map((dia) => {
      const dm = Number(dia);
      if (!Number.isFinite(dm) || dm <= 0) return { x: dm, hole: dm, crossings: null, fits: false, minRing: null, volume: null, ratio: null, printable: false, error: 'invalid diameter' };
      const r = (dm / 2) / Math.cos(Math.PI / n);
      const hole = Array.from({ length: n }, (_, i) => [r * Math.cos(TAU * i / n), r * Math.sin(TAU * i / n)]);
      const crossings = c.polygonSelfIntersections(hole);
      let minRing = Infinity, fits = true;
      for (let i = 0; i < n; i++) {
        const p = hole[i], q = hole[(i + 1) % n], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (!pointInPoly(p, contour)) fits = false;
        minRing = Math.min(minRing, distToPoly(p, contour), distToPoly(m, contour));
      }
      const volume = (base - Math.abs(polyArea(hole))) * KEYRING_HEIGHT;
      const minRingR = r6(minRing);
      const ratio = minRingR / noz;
      return {
        x: r6(dm), hole: r6(dm), clearDiameter: r6(dm), crossings, fits,
        minRing: minRingR, volume: r6(volume), ratio: r6(ratio),
        printable: fits && crossings === 0 && volume > 0 && ratio >= MIN_WALL_RATIO
      };
    });
  }
  function sweepForModel(modelId, nozzle) {
    const d = findDesign(modelId);
    return d.type === 'cutter'
      ? { kind: 'lip', rows: lipSweep(modelId, nozzle) }
      : { kind: 'hole', rows: holeSweep(nozzle) };
  }
  function probeResult(modelId, nozzle, probe) {
    const d = findDesign(modelId);
    const p = checkProbe(probe);
    if (d.type === 'cutter') {
      const row = sweepOffsets(cad().profile(d), [p], nozzle, LIP_BAND_HEIGHT)[0];
      return { kind: 'lip', ...row };
    }
    return { kind: 'hole', ...holeSweep(nozzle, [p])[0] };
  }
  // Contour + offset data for the 2D cross-section inspector, in raw mm.
  function contourData(modelId) {
    const c = cad();
    const d = findDesign(modelId);
    const outer = c.profile(d);
    const extent = (pts) => Math.max(...pts.flat().map(Math.abs));
    if (d.type === 'cutter') {
      const offsets = [['lip', c.RULES.lip], ['wall', c.RULES.wall], ['rim', c.RULES.rimWidth]]
        .map(([label, w]) => ({ label, width: w, points: c.offset(outer, w) }));
      return {
        type: 'cutter', outer, offsets, hole: null,
        extent: Math.max(extent(outer), ...offsets.map((o) => extent(o.points)))
      };
    }
    const n = d.sectors, r = (c.RULES.holeDiameter / 2) / Math.cos(Math.PI / n);
    const hole = Array.from({ length: n }, (_, i) => [r * Math.cos(TAU * i / n), r * Math.sin(TAU * i / n)]);
    return { type: 'keyring', outer, offsets: [], hole: { points: hole, clearRadius: c.RULES.holeDiameter / 2 }, extent: extent(outer) };
  }

  /* ---------------------------------------------- #bbs= bookmark codec */
  const HASH_PREFIX = 'bbs=';
  const DECODE_SPEC = Object.freeze({ m: 1, n: 1, f: 1, p: 1 });
  function defaultProbe(modelId) {
    const d = findDesign(modelId);
    return d.type === 'cutter' ? cad().RULES.lip : cad().RULES.holeDiameter;
  }
  function normalizeProbe(modelId, p) {
    const d = findDesign(modelId);
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0) return defaultProbe(modelId);
    const [lo, hi] = PROBE_LIMITS[d.type];
    return r6(Math.min(hi, Math.max(lo, v)));
  }
  // Normalize a state object to the canonical shape or return null.
  // Only own properties on the input are read; unknown ids/values fail closed.
  function canonicalState(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const get = (long, short) => (hasOwn(input, long) ? input[long] : (hasOwn(input, short) ? input[short] : undefined));
    const c = cad();
    const model = get('model', 'm') ?? c.DESIGNS[0].id;
    if (!c.DESIGNS.some((d) => d.id === model)) return null;
    const nozzle = Number(get('nozzle', 'n') ?? 0.4);
    if (!NOZZLES.includes(nozzle)) return null;
    const material = String(get('material', 'f') ?? 'PLA');
    if (!hasOwn(MATERIALS, material)) return null;
    let probe = get('probe', 'p');
    if (probe === undefined || probe === null || probe === '') probe = defaultProbe(model);
    probe = Number(probe);
    if (!Number.isFinite(probe) || probe <= 0 || probe > 50) return null;
    const design = c.DESIGNS.find((d) => d.id === model);
    const [probeLo, probeHi] = PROBE_LIMITS[design.type];
    if (probe < probeLo || probe > probeHi) return null;
    return { model: String(model), nozzle, material, probe: r6(probe) };
  }
  function encodeHash(state) {
    const s = canonicalState(state);
    if (!s) return null;
    return '#' + HASH_PREFIX + 'm=' + encodeURIComponent(s.model) + '&n=' + s.nozzle + '&f=' + encodeURIComponent(s.material) + '&p=' + s.probe;
  }
  // Strict decode: only the four whitelisted keys, own-property checks so
  // __proto__/constructor keys fail, then full value validation.
  function decodeHash(raw) {
    if (typeof raw !== 'string') return null;
    let h = raw;
    if (h.startsWith('#')) h = h.slice(1);
    if (!h.startsWith(HASH_PREFIX)) return null;
    const body = h.slice(HASH_PREFIX.length);
    if (!body || body.length > 300 || !/^[A-Za-z0-9&=%._~-]+$/.test(body)) return null;
    const params = Object.create(null);
    for (const pair of body.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 1 || eq !== pair.lastIndexOf('=')) return null;
      const k = pair.slice(0, eq);
      if (!hasOwn(DECODE_SPEC, k) || hasOwn(params, k)) return null;
      let v;
      try { v = decodeURIComponent(pair.slice(eq + 1)); } catch (e) { return null; }
      params[k] = v;
    }
    return canonicalState(params);
  }

  /* ------------------------------------ canonical payload + digest cache */
  function stableStringify(v, active = new Set()) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('canonical JSON rejects non-finite numbers');
    if (typeof v === 'bigint') throw new TypeError('canonical JSON rejects bigint');
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (active.has(v)) throw new TypeError('canonical JSON rejects cyclic structures');
    active.add(v);
    try {
      if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x, active)).join(',') + ']';
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k], active)).join(',') + '}';
    } finally {
      active.delete(v);
    }
  }
  const payloadCache = new Map();
  // One canonical digest-stamped payload per normalized state. The page
  // fingerprint and every export read from this single cached object so the
  // SHA-256 can never drift between views.
  function auditPayload(input) {
    const s = canonicalState(input);
    if (!s) return null;
    const key = JSON.stringify(s);
    if (payloadCache.has(key)) return payloadCache.get(key);
    const models = compareModels();
    const sweep = sweepForModel(s.model, s.nozzle);
    const probe = probeResult(s.model, s.nozzle, s.probe);
    const payload = {
      schema: 'bakebuild-audit/1',
      state: s, models, probe,
      sweep: { kind: sweep.kind, nozzle: s.nozzle, rows: sweep.rows }
    };
    const canonical = stableStringify(payload);
    const stamped = { state: s, payload, canonical, digest: sha256Hex(canonical) };
    payloadCache.set(key, stamped);
    return stamped;
  }
  function auditDigest(state) {
    const st = auditPayload(state);
    return st ? st.digest : null;
  }
  function verifyDigest(payload, digest) {
    if (!payload || typeof payload !== 'object' || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return false;
    try { return sha256Hex(stableStringify(payload)) === digest; } catch (e) { return false; }
  }
  function tamperPayload(payload) {
    const copy = JSON.parse(JSON.stringify(payload));
    if (copy.models && copy.models[0]) copy.models[0].volume = r6((copy.models[0].volume || 0) + 1);
    else copy.tampered = true;
    return copy;
  }

  /* ---------------------------------------------------------- exporters */
  function exportJSON(state) {
    const st = auditPayload(state);
    if (!st) return null;
    return JSON.stringify({ integrity: { algorithm: 'SHA-256', digest: st.digest }, ...st.payload }, null, 2) + '\n';
  }
  // Formula-safe CSV cell: neutralize spreadsheet formula triggers, then quote.
  function csvCell(v) {
    let s = String(v);
    const first = s.replace(/^[\s\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]+/, '').charAt(0);
    if (first !== '' && '=+-@'.includes(first)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function exportCSV(state) {
    const st = auditPayload(state);
    if (!st) return null;
    const s = st.state;
    const lines = [
      '# bakebuild-studio audit brief v1',
      '# state model=' + s.model + ' nozzle=' + s.nozzle + ' material=' + s.material + ' probe=' + s.probe,
      '# sha256 ' + st.digest,
      'model,type,dim_x_mm,dim_y_mm,dim_z_mm,volume_mm3,surface_mm2,euler_chi,boundary_edges,nonmanifold_edges,step_entities,step_bytes,stl_facets,stl_bytes,mass_' + s.material.toLowerCase() + '_g'
    ];
    for (const m of st.payload.models) {
      lines.push([
        m.id, m.type, ...m.dimensions, m.volume, m.surfaceArea,
        m.topo.chi, m.topo.boundary, m.topo.nonManifold,
        m.step.entities, m.step.bytes, m.stl.facets, m.stl.bytes,
        m.mass[s.material]
      ].map(csvCell).join(','));
    }
    lines.push('probe_kind,probe_value,ratio,printable');
    lines.push([st.payload.probe.kind, st.payload.probe.x, st.payload.probe.ratio, st.payload.probe.printable].map(csvCell).join(','));
    return lines.join('\n') + '\n';
  }
  function exportMarkdown(state) {
    const st = auditPayload(state);
    if (!st) return null;
    const s = st.state;
    const lines = [
      '## BakeBuild Studio audit brief',
      '',
      'State: model=' + s.model + ', nozzle=' + s.nozzle + ' mm, material=' + s.material + ', probe=' + s.probe + ' mm',
      '',
      '| Model | Bounds (mm) | Volume (mm^3) | Surface (mm^2) | Euler | Boundary | Non-manifold | STEP entities | STEP bytes | STL facets | STL bytes | Mass ' + s.material + ' (g) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    ];
    for (const m of st.payload.models) {
      lines.push('| ' + [
        m.name, m.dimensions.map((v) => v.toFixed(2)).join(' x '),
        m.volume.toFixed(2), m.surfaceArea.toFixed(1), m.topo.chi,
        m.topo.boundary, m.topo.nonManifold, m.step.entities, m.step.bytes,
        m.stl.facets, m.stl.bytes, m.mass[s.material].toFixed(2)
      ].join(' | ') + ' |');
    }
    lines.push('', 'Probe: ' + st.payload.probe.kind + ' ' + st.payload.probe.x + ' mm, ratio ' + st.payload.probe.ratio + ', printable ' + st.payload.probe.printable);
    lines.push('', 'SHA-256 audit digest: `' + st.digest + '`', '');
    return lines.join('\n');
  }

  /* --------------------------------------------------------- self tests */
  function must(cond, msg) { if (!cond) throw new Error(msg || 'self-test failed'); }
  const SELF_TESTS = [
    { name: 'sha256-kat-empty', run: () => must(sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty digest') },
    { name: 'sha256-kat-abc', run: () => must(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc digest') },
    { name: 'sha256-kat-fox', run: () => must(sha256Hex('The quick brown fox jumps over the lazy dog') === 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592', 'fox digest') },
    { name: 'sha256-kat-56', run: () => must(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', '56 byte digest') },
    ...cad().DESIGNS.map((d) => ({
      name: 'euler-' + d.id, run: () => {
        const t = eulerReport(cad().generate(d.id));
        must(t.chi === 0, 'chi=' + t.chi);
      }
    })),
    ...cad().DESIGNS.map((d) => ({
      name: 'manifold-' + d.id, run: () => {
        const t = eulerReport(cad().generate(d.id));
        must(t.boundary === 0 && t.nonManifold === 0 && t.flipped === 0 && t.degenerate === 0 && t.nan === 0, 'manifold census failed');
      }
    })),
    ...cad().DESIGNS.map((d) => ({
      name: 'volume-' + d.id, run: () => {
        const m = cad().generate(d.id);
        must(cad().signedVolume(m.triangles) > 0, 'outward winding must give positive volume');
      }
    })),
    { name: 'offset-exact-distance', run: () => {
      const c = cad(), d = c.DESIGNS[0], base = c.profile(d), off = c.offset(base, c.RULES.lip);
      for (let i = 0; i < base.length; i++) {
        const prev = base[(i + base.length - 1) % base.length], next = base[(i + 1) % base.length];
        for (const e of [[base[i][0] - prev[0], base[i][1] - prev[1]], [next[0] - base[i][0], next[1] - base[i][1]]]) {
          const m = Math.hypot(e[0], e[1]), n = [e[1] / m, -e[0] / m];
          const shift = [off[i][0] - base[i][0], off[i][1] - base[i][1]];
          must(Math.abs(shift[0] * n[0] + shift[1] * n[1] - c.RULES.lip) < 1e-7, 'offset vertex ' + i + ' off distance');
        }
      }
    } },
    { name: 'offset-contours-simple', run: () => {
      const c = cad();
      for (const d of c.DESIGNS.filter((x) => x.type === 'cutter')) {
        for (const w of [c.RULES.lip, c.RULES.wall, c.RULES.rimWidth]) {
          must(c.polygonSelfIntersections(c.offset(c.profile(d), w)) === 0, d.id + ' offset ' + w);
        }
      }
    } },
    { name: 'step-reference-closure', run: () => {
      const c = cad();
      for (const d of c.DESIGNS) {
        const text = c.toSTEP(c.generate(d.id));
        const ids = new Set();
        for (const m of text.matchAll(/^#(\d+)=/gm)) ids.add(Number(m[1]));
        for (const line of text.split('\n')) {
          const t = line.trim(), def = /^#(\d+)=/.exec(t);
          const body = def ? t.slice(t.indexOf('=') + 1) : t;
          for (const r of body.matchAll(/#(\d+)/g)) {
            const id = Number(r[1]);
            must(ids.has(id), 'dangling ref #' + id);
            must(!def || id < Number(def[1]), 'forward ref #' + id);
          }
        }
      }
    } },
    { name: 'stl-facet-parity', run: () => {
      const c = cad();
      for (const d of c.DESIGNS) {
        const m = c.generate(d.id);
        must((c.toSTL(m).match(/facet normal/g) || []).length === m.triangles.length, d.id + ' facet count');
      }
    } },
    { name: 'csv-formula-escape', run: () => {
      for (const bad of ['=CMD()', '+1', '-2', '@handle', '\t=1+1']) must(csvCell(bad).startsWith("'"), 'unescaped ' + JSON.stringify(bad));
      must(csvCell('plain') === 'plain', 'plain cell untouched');
    } },
    { name: 'digest-export-parity', run: () => {
      const st = auditPayload({ model: 'orpheus_circuit_crest_cutter', nozzle: 0.4, material: 'PLA', probe: 0.8 });
      must(st && /^[0-9a-f]{64}$/.test(st.digest), 'digest missing');
      must(st.digest === sha256Hex(st.canonical), 'digest does not match canonical payload');
      must(exportJSON(st.state).includes('"digest": "' + st.digest + '"'), 'json digest drift');
      must(exportCSV(st.state).includes('# sha256 ' + st.digest), 'csv digest drift');
      must(exportMarkdown(st.state).includes(st.digest), 'md digest drift');
    } },
    { name: 'tamper-detection', run: () => {
      const st = auditPayload({ model: 'hex_gear_logic_gate_cutter', nozzle: 0.6, material: 'PETG', probe: 1.2 });
      must(verifyDigest(st.payload, st.digest) === true, 'clean payload rejected');
      must(verifyDigest(tamperPayload(st.payload), st.digest) === false, 'tampered payload accepted');
    } },
    { name: 'codec-roundtrip', run: () => {
      for (const d of cad().DESIGNS) for (const n of NOZZLES) for (const f of Object.keys(MATERIALS)) {
        const s = { model: d.id, nozzle: n, material: f, probe: d.type === 'cutter' ? 0.8 : 6 };
        must(JSON.stringify(decodeHash(encodeHash(s))) === JSON.stringify(s), 'round trip ' + d.id);
      }
    } },
    { name: 'codec-hostile-reject', run: () => {
      for (const bad of ['#bbs=m=__proto__', '#bbs=__proto__=x', '#bbs=m=x&constructor=y', '#bbs=x=1', '#bbs=m=ghost', 'bbs=', '#bbs=', '#bbs=m=%zz', '', null, 42])
        must(decodeHash(bad) === null, 'accepted ' + JSON.stringify(bad));
    } },
    { name: 'filament-mass-finite', run: () => {
      for (const r of compareModels()) for (const k of Object.keys(MATERIALS))
        must(Number.isFinite(r.mass[k]) && r.mass[k] > 0, r.id + ' ' + k + ' mass');
    } },
    { name: 'hole-sweep-fits', run: () => {
      for (const row of holeSweep(0.4)) must(row.fits === true && row.crossings === 0 && row.minRing > 0, 'hole ' + row.hole);
    } },
    { name: 'surface-area-positive', run: () => {
      for (const d of cad().DESIGNS) must(surfaceArea(cad().generate(d.id).triangles) > 0, d.id);
    } }
  ];
  function runSelfTests() {
    return SELF_TESTS.map((t) => {
      try { t.run(); return { name: t.name, pass: true, detail: '' }; }
      catch (e) { return { name: t.name, pass: false, detail: String((e && e.message) || e) }; }
    });
  }

  const api = {
    MATERIALS, NOZZLES, MIN_WALL_RATIO, LIP_SWEEP, HOLE_SWEEP, PROBE_LIMITS,
    sha256Hex, utf8, byteLen, stableStringify,
    polyArea, distToPoly, pointInPoly, surfaceArea,
    eulerReport, modelReport, compareModels, filamentGrams, stepEntityCount,
    sweepOffsets, lipSweep, holeSweep, sweepForModel, probeResult, contourData,
    defaultProbe, normalizeProbe, canonicalState, encodeHash, decodeHash,
    auditPayload, auditDigest, verifyDigest, tamperPayload,
    exportJSON, exportCSV, exportMarkdown, csvCell,
    SELF_TESTS, runSelfTests
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BakeBuildLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
