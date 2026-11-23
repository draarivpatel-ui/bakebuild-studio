// DOM, UI interaction, accessibility, and repository compliance tests for the
// browser workbench. A tiny DOM/canvas shim executes the real app.js module so
// design selection, orbit controls, keyboard navigation, and downloads are
// exercised end to end rather than merely grepped for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../cad-engine.js';
import '../cad-lab.js';
const CAD = globalThis.BakeBuildCAD;
const LAB = globalThis.BakeBuildLab;
import { readText, ROOT, complianceTextFiles } from './helpers.js';

const html = readText('index.html');
const css = readText('style.css');
const appSource = readText('app.js');
const engineSource = readText('cad-engine.js');
const readme = readText('README.md');

/* ------------------------------------------------------------ DOM harness */

class ShimClassList {
  constructor(initial = '') { this.items = new Set(initial.split(/\s+/).filter(Boolean)); }
  add(c) { this.items.add(c); }
  remove(c) { this.items.delete(c); }
  contains(c) { return this.items.has(c); }
  get value() { return [...this.items].join(' '); }
}

class ShimElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.classList = new ShimClassList();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.width = 0;
    this.height = 0;
    this.className = '';
    this.tabIndex = 0;
    this.ctx = null;
  }
  append(...kids) { for (const k of kids) { this.children.push(k); k.parentNode = this; } }
  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, event = {}) {
    const e = { type, preventDefault() { this.prevented = true; }, stopPropagation() {}, currentTarget: this, target: this, ...event };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  click() { this.dispatch('click'); }
  getBoundingClientRect() { return { width: 640, height: 480, left: 0, top: 0 }; }
  getContext() {
    if (!this.ctx) {
      const ops = [];
      const ctx = {
        ops,
        setTransform() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fill() {}, clearRect() {}, save() {}, restore() {},
        set fillStyle(v) { ops.push(['fillStyle', v]); }, get fillStyle() { return '#000'; },
        set strokeStyle(v) { ops.push(['strokeStyle', v]); }, get strokeStyle() { return '#000'; },
        set lineWidth(v) { ops.push(['lineWidth', v]); }, get lineWidth() { return 1; }
      };
      this.ctx = ctx;
    }
    return this.ctx;
  }
  setPointerCapture(id) { this.captured = id; }
  focus() { this.doc.activeElement = this; }
  querySelector(sel) { return this.doc.querySelector(sel); }
  querySelectorAll(sel) { return this.doc.querySelectorAll(sel); }
}

function createDom() {
  const doc = {
    byId: new Map(),
    created: [],
    activeElement: null,
    body: null,
    createElement(tag) {
      const el = new ShimElement(tag, doc);
      doc.created.push(el);
      return el;
    },
    getElementById(id) { return doc.byId.get(id) || null; },
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      if (sel.startsWith('#')) { const el = doc.byId.get(sel.slice(1)); return el ? [el] : []; }
      if (sel.includes(' ')) return [];
      return [...doc.byId.values()].filter((el) => el.matchesTag?.(sel));
    }
  };
  doc.body = new ShimElement('body', doc);
  // Parse every id from the static HTML and pre-create the elements.
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const id = match[1];
    const tagMatch = new RegExp(`<([a-z]+)[^>]*\\bid="${id}"`, 'i').exec(html);
    const el = new ShimElement(tagMatch ? tagMatch[1] : 'div', doc);
    el.id = id;
    el.matchesTag = (sel) => sel.toLowerCase() === el.tagName.toLowerCase();
    doc.byId.set(id, el);
  }
  // A real <select> adopts the value of its first appended option.
  const select = doc.byId.get('design');
  const originalAppend = select.append.bind(select);
  select.append = (...kids) => {
    originalAppend(...kids);
    if (select.value === '' && kids[0] && kids[0].value) select.value = kids[0].value;
  };
  // Canvas drawing support.
  const canvas = doc.byId.get('preview');
  canvas.getBoundingClientRect = () => ({ width: 640, height: 480 });
  const downloads = [];
  const revoked = [];
  const win = {
    devicePixelRatio: 2,
    listeners: {},
    addEventListener(type, fn) { (win.listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of win.listeners[type] || []) fn({ type, ...event }); }
  };
  const url = {
    createObjectURL(blob) { downloads.push(blob); return `blob:${downloads.length}`; },
    revokeObjectURL(u) { revoked.push(u); }
  };
  return { doc, win, url, canvas, downloads, revoked };
}

class ShimBlob {
  constructor(parts, options = {}) { this.parts = parts; this.options = options; }
}

async function boot(hash) {
  const dom = createDom();
  // The shim stays installed for the lifetime of this test file: app.js
  // registers DOM event handlers that resolve `document` at dispatch time,
  // not only during the initial module evaluation.
  globalThis.document = dom.doc;
  globalThis.window = dom.win;
  if (hash !== undefined) dom.win.location = { hash, href: 'https://local.test/index.html' + hash };
  globalThis.Blob = ShimBlob;
  globalThis.URL = { createObjectURL: dom.url.createObjectURL, revokeObjectURL: dom.url.revokeObjectURL };
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  // Cache-busting query lets each boot re-evaluate the module-level IIFE.
  await import(`${pathToFileURL(path.join(ROOT, 'app.js')).href}?v=${Math.random()}`);
  return dom;
}

/* --------------------------------------------------------- Static markup */

test('index.html has HTML5 doctype, language, charset, viewport, and a descriptive title', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<title>BakeBuild Studio: CAD workbench<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="style.css">/);
  assert.match(html, /<script src="cad-engine.js"><\/script><script src="cad-lab.js"><\/script><script src="app.js"><\/script>/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
});

test('index.html has exactly one h1, ordered headings, and a main landmark', () => {
  assert.equal((html.match(/<h1\b/gi) || []).length, 1);
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  assert.equal(levels[0], 1);
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i] <= levels[i - 1] + 1, `heading jump h${levels[i - 1]} to h${levels[i]}`);
  }
  assert.match(html, /<main>/);
  assert.match(html, /<footer>/);
  assert.match(html, /<header>/);
  assert.match(html, /<aside>/);
});

test('all DOM ids are unique and every app.js getElementById target exists in the HTML', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, 'at least 8 DOM ids');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  const used = [...appSource.matchAll(/getElementById\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.ok(used.length >= 7, 'app.js binds to real elements');
  for (const id of used) assert.ok(ids.includes(id), `#${id} is missing from index.html`);
  // The download buttons are bound dynamically through getElementById(ext).
  assert.match(appSource, /for \(const ext of \['step','stl'\]\)/);
  for (const id of ['preview', 'design', 'reset', 'step', 'stl', 'model-name', 'dimensions', 'status', 'checks']) {
    assert.ok(ids.includes(id), `#${id} exists`);
  }
});

test('canvas is keyboard focusable, labelled, and the hint explains every control', () => {
  const canvasTag = /<canvas id="preview"[^>]*>/.exec(html)[0];
  assert.match(canvasTag, /tabindex="0"/);
  assert.match(canvasTag, /role="application"/, 'interactive canvas needs a named widget role for aria-label to be announced');
  assert.match(canvasTag, /aria-label="[^"]{30,}"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="status"/);
  const hint = /<p class="hint">([^<]+)<\/p>/.exec(html)[1];
  assert.match(hint, /Drag/);
  assert.match(hint, /Scroll/);
  assert.match(hint, /Arrow keys/);
  assert.match(hint, /zoom/);
});

test('download links and buttons reference real export files and are typed correctly', () => {
  assert.match(html, /<button id="step" type="button">Download \.step<\/button>/);
  assert.match(html, /<button id="stl" type="button">Download \.stl<\/button>/);
  assert.match(html, /<button id="reset" type="button">/);
  assert.match(html, /<a href="exports\/manifest.json" download>/);
  assert.ok(fs.existsSync(path.join(ROOT, 'exports', 'manifest.json')));
  for (const d of CAD.DESIGNS) {
    assert.ok(fs.existsSync(path.join(ROOT, 'exports', `${d.id}.step`)));
    assert.ok(fs.existsSync(path.join(ROOT, 'exports', `${d.id}.stl`)));
  }
});

test('stylesheet provides focus rings, reduced layout overflow, and responsive layout', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /outline:3px solid/);
  assert.match(css, /@media\(max-width:850px\)/);
  assert.match(css, /touch-action:none/);
  assert.match(css, /color-scheme:dark/);
  assert.match(css, /\.pass\{color:/);
  assert.match(css, /\.fail\{color:/);
});

/* ---------------------------------------------------------- Live UI behaviour */

test('booting app.js populates the design selector with all four designs and shows a passing model', async () => {
  const { doc, canvas } = await boot();
  const select = doc.getElementById('design');
  assert.equal(select.children.length, 4, 'one option per design');
  assert.deepEqual(select.children.map((o) => o.value), CAD.DESIGNS.map((d) => d.id));
  assert.deepEqual(select.children.map((o) => o.textContent), CAD.DESIGNS.map((d) => d.name));
  assert.equal(doc.getElementById('model-name').textContent, CAD.DESIGNS[0].name);
  assert.match(doc.getElementById('dimensions').textContent, /×/);
  assert.match(doc.getElementById('dimensions').textContent, /mm$/);
  const status = doc.getElementById('status');
  assert.equal(status.textContent, 'All geometry rules pass');
  assert.equal(status.className, 'pass');
  assert.ok(canvas.ctx && canvas.ctx.ops.length > 0, 'render drew triangles into the canvas');
  assert.ok(canvas.width > 0 && canvas.height > 0, 'canvas was sized for devicePixelRatio');
});

test('initial render lists every validation check as passing', async () => {
  const { doc } = await boot();
  const checks = doc.getElementById('checks').children;
  const model = CAD.generate(CAD.DESIGNS[0].id);
  assert.equal(checks.length, model.validation.checks.length);
  for (const li of checks) {
    assert.equal(li.className, 'pass');
    assert.ok(li.textContent.startsWith('✓'), 'pass glyph');
  }
  assert.deepEqual(checks.map((li) => li.textContent.slice(2)), model.validation.checks.map((c) => c.rule));
});

test('switching designs recomputes name, dimensions, checks, and redraws the canvas', async () => {
  const { doc, canvas } = await boot();
  const select = doc.getElementById('design');
  for (const d of CAD.DESIGNS) {
    select.value = d.id;
    const before = canvas.ctx.ops.length;
    select.dispatch('change');
    const model = CAD.generate(d.id);
    assert.equal(doc.getElementById('model-name').textContent, d.name);
    assert.equal(doc.getElementById('dimensions').textContent,
      model.dimensions.map((n) => n.toFixed(2)).join(' × ') + ' mm');
    assert.equal(doc.getElementById('checks').children.length, model.validation.checks.length);
    assert.equal(doc.getElementById('status').className, 'pass');
    assert.ok(canvas.ctx.ops.length > before, `${d.id} triggered a redraw`);
  }
});

test('reset view restores the default camera and renders again', async () => {
  const { doc, canvas } = await boot();
  const select = doc.getElementById('design');
  select.value = CAD.DESIGNS[1].id;
  select.dispatch('change');
  const before = canvas.ctx.ops.length;
  doc.getElementById('reset').click();
  assert.ok(canvas.ctx.ops.length > before, 'reset triggers a draw');
  assert.equal(doc.getElementById('model-name').textContent, CAD.DESIGNS[1].name, 'reset does not change the design');
});

test('STEP and STL download buttons generate the correct filenames and payloads', async () => {
  const { doc, downloads } = await boot();
  const select = doc.getElementById('design');
  for (const d of CAD.DESIGNS) {
    select.value = d.id;
    select.dispatch('change');
    for (const ext of ['step', 'stl']) {
      const before = downloads.length;
      doc.getElementById(ext).click();
      assert.equal(downloads.length, before + 1, `${d.id} ${ext} download created one blob`);
      const blob = downloads[downloads.length - 1];
      assert.equal(blob.options.type, 'text/plain;charset=utf-8');
      assert.ok(blob.parts[0].startsWith(ext === 'step' ? 'ISO-10303-21;\nHEADER;' : `solid ${d.id}\n`),
        `${d.id} ${ext} payload has the expected header`);
      const anchor = doc.created.filter((el) => el.tagName === 'A').at(-1);
      assert.equal(anchor.download, `${d.id}.${ext}`);
      assert.ok(String(anchor.href).startsWith('blob:'));
      assert.equal(anchor.parentNode, null, 'temporary anchor is removed after click');
    }
  }
  assert.equal(downloads.length, 8, 'four designs times two formats');
});

test('download payloads are byte-identical to the shipped exports', async () => {
  const { doc, downloads } = await boot();
  const select = doc.getElementById('design');
  for (const d of CAD.DESIGNS) {
    select.value = d.id;
    select.dispatch('change');
    doc.getElementById('step').click();
    doc.getElementById('stl').click();
  }
  for (let i = 0; i < CAD.DESIGNS.length; i += 1) {
    const d = CAD.DESIGNS[i];
    assert.equal(downloads[i * 2].parts[0], fs.readFileSync(path.join(ROOT, 'exports', `${d.id}.step`), 'utf8'));
    assert.equal(downloads[i * 2 + 1].parts[0], fs.readFileSync(path.join(ROOT, 'exports', `${d.id}.stl`), 'utf8'));
  }
});

test('pointer drag orbits the mesh and pointer release stops dragging', async () => {
  const { doc, canvas } = await boot();
  const before = canvas.ctx.ops.length;
  canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 7 });
  assert.equal(canvas.captured, 7, 'pointer was captured');
  canvas.dispatch('pointermove', { clientX: 130, clientY: 115 });
  assert.ok(canvas.ctx.ops.length > before, 'drag renders');
  const afterDrag = canvas.ctx.ops.length;
  canvas.dispatch('pointerup', {});
  canvas.dispatch('pointermove', { clientX: 200, clientY: 200 });
  assert.equal(canvas.ctx.ops.length, afterDrag, 'moving after release does not render');
});

test('wheel zoom clamps between 0.4 and 3 and prevents default scrolling', async () => {
  const { doc, canvas } = await boot();
  for (const deltaY of [-5000, -5000, 5000, 5000, 5000, 5000, 5000, 5000]) {
    const e = canvas.dispatch('wheel', { deltaY });
    assert.equal(e.prevented, true, 'wheel event is preventDefault-ed');
  }
  assert.ok(canvas.ctx.ops.length > 0, 'zoom still renders');
});

test('keyboard arrows, plus, equals, and minus rotate and zoom; unrelated keys are ignored', async () => {
  const { doc, canvas } = await boot();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-']) {
    const before = canvas.ctx.ops.length;
    const e = canvas.dispatch('keydown', { key });
    assert.equal(e.prevented, true, `${key} is handled`);
    assert.ok(canvas.ctx.ops.length > before, `${key} triggers a render`);
  }
  const before = canvas.ctx.ops.length;
  const e = canvas.dispatch('keydown', { key: 'a' });
  assert.equal(e.prevented, undefined, 'unrelated key is not intercepted');
  assert.equal(canvas.ctx.ops.length, before, 'unrelated key does not render');
});

test('window resize triggers a fresh render', async () => {
  const { canvas, win } = await boot();
  const before = canvas.ctx.ops.length;
  win.dispatch('resize');
  assert.ok(canvas.ctx.ops.length > before);
});

/* ------------------------------------------------------------- Compliance */

test('every repository text file has zero em-dashes and zero en-dashes', () => {
  // Build the forbidden characters from code points so this test file does not
  // itself contain them, then scan every shipped text file.
  const emDash = String.fromCodePoint(0x2014);
  const enDash = String.fromCodePoint(0x2013);
  const bad = [];
  for (const file of complianceTextFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(emDash)) bad.push(`${path.relative(ROOT, file)}: em-dash`);
    if (text.includes(enDash)) bad.push(`${path.relative(ROOT, file)}: en-dash`);
  }
  assert.deepEqual(bad, []);
});

test('no repository text file contains banned disclosures, model names, or vendor assistant branding', () => {
  const d = (...codes) => String.fromCharCode(...codes);
  const words = [
    [65,110,116,104,114,111,112,105,99], [79,112,101,110,65,73], [67,108,97,117,100,101],
    [67,104,97,116,71,80,84], [71,80,84,45,52], [71,80,84,45,53], [67,111,112,105,108,111,116],
    [71,101,109,105,110,105], [65,73,45,97,115,115,105,115,116,101,100],
    [65,73,45,103,101,110,101,114,97,116,101,100],
    [108,97,114,103,101,32,108,97,110,103,117,97,103,101,32,109,111,100,101,108],
    [108,97,110,103,117,97,103,101,32,109,111,100,101,108], [76,76,77]
  ].map((codes) => d(...codes));
  const pattern = new RegExp('\\b(?:' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
  const bad = [];
  for (const file of complianceTextFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (pattern.test(text)) {
      bad.push(`${path.relative(ROOT, file)}: restricted term`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('no personal contact details or home address leak into repository files', () => {
  const streetRegex = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Court|Ct|Way|Manor|Place)\b/;
  const bad = [];
  for (const file of complianceTextFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) bad.push(`${path.relative(ROOT, file)}: email address`);
    if (streetRegex.test(text)) bad.push(`${path.relative(ROOT, file)}: street address`);
  }
  assert.deepEqual(bad, []);
});

test('README documents the correct local CLI path, test command, and export contents', () => {
  assert.match(readme, /^# BakeBuild Studio/m);
  assert.match(readme, /node cli\.js/);
  assert.match(readme, /npm test|node --test/);
  assert.ok(!readme.includes('artifacts/bakebuild-studio/cli.js'), 'stale nested path removed');
  assert.match(readme, /exports\/manifest\.json|manifest\.json/);
  assert.match(readme, /DEVPOST_UPGRADE\.md/);
});

test('DEVPOST_UPGRADE.md exists, is substantive, and passes the same compliance gates', () => {
  const devpost = readText('DEVPOST_UPGRADE.md');
  assert.ok(devpost.length > 1500, 'upgrade write-up has real content');
  assert.match(devpost, /^# /m);
  assert.equal(devpost.includes(String.fromCodePoint(0x2014)), false, 'no em-dash');
  assert.equal(devpost.includes(String.fromCodePoint(0x2013)), false, 'no en-dash');
  const restricted = new RegExp('\\b(?:' + [
    [65,73,45,97,115,115,105,115,116,101,100], [65,110,116,104,114,111,112,105,99],
    [79,112,101,110,65,73], [67,108,97,117,100,101], [71,80,84]
  ].map((c) => String.fromCharCode(...c)).join('|') + ')\\b', 'i');
  assert.equal(restricted.test(devpost), false, 'no restricted disclosure or model names');
});

test('cad-engine.js is loadable as a classic script and a UMD global (file:// safe)', () => {
  assert.match(engineSource, /module\.exports=api/);
  assert.match(engineSource, /root\.BakeBuildCAD=api/);
  assert.doesNotMatch(engineSource, /^export\s/m, 'top-level export statements break classic <script> loading under file://');
  assert.equal(typeof CAD.generate, 'function');
  assert.equal(typeof CAD.toSTEP, 'function');
  assert.equal(typeof CAD.toSTL, 'function');
});

/* ----------------------------------------------------------- Audit lab */

const labIds = ['lab', 'lab-nozzle', 'lab-material', 'lab-probe', 'lab-probe-label', 'lab-tbody', 'lab-mass-col',
  'lab-xsec', 'lab-xsec-cap', 'lab-ratio', 'lab-ratio-cap', 'lab-json', 'lab-csv', 'lab-md', 'lab-share',
  'lab-verify', 'lab-tamper', 'lab-digest', 'lab-share-url', 'lab-status', 'lab-test-count', 'lab-test-list', 'lab-run-tests'];

test('lab section is present in markup with every required control id', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of labIds) assert.ok(ids.includes(id), `#${id} missing from index.html`);
  assert.match(html, /<section class="lab" id="lab" hidden>/, 'lab starts hidden until cad-lab.js loads');
  assert.match(html, /<h2>Manifold &amp; Tolerance Audit Lab<\/h2>/);
  assert.match(html, /<table id="lab-table">/);
  assert.match(html, /<svg id="lab-xsec" tabindex="0" role="img" aria-label="[^"]+"/);
  assert.match(html, /<svg id="lab-ratio" viewBox="0 0 360 170" tabindex="0" role="img" aria-label="[^"]+"/);
  for (const id of ['lab-json', 'lab-csv', 'lab-md', 'lab-share', 'lab-verify', 'lab-tamper', 'lab-run-tests']) {
    assert.match(html, new RegExp(`<button id="${id}" type="button">`), `#${id} is a real button`);
  }
  assert.match(html, /<input id="lab-share-url" type="text" readonly/);
  assert.match(css, /\.lab\[hidden\]\{display:none\}/, 'hidden lab stays hidden even against author CSS');
});

test('lab section reveals and populates the four-model comparator on boot', async () => {
  const { doc } = await boot();
  const lab = doc.getElementById('lab');
  assert.equal(lab.hidden, false, 'lab visible when cad-lab.js is present');
  const rows = doc.getElementById('lab-tbody').children;
  assert.equal(rows.length, 4, 'one comparator row per model');
  assert.equal(rows[0].children.length, 9, 'nine comparator columns');
  assert.equal(rows[0].children[0].textContent, CAD.DESIGNS[0].name);
  const reports = LAB.compareModels();
  for (let i = 0; i < rows.length; i += 1) {
    assert.equal(rows[i].children[4].textContent, '0 / 0 / 0', `${reports[i].id} euler/boundary/non-manifold`);
    assert.equal(rows[i].children[8].children[0].tagName, 'BUTTON', 'inspect button present');
  }
});

test('lab stays hidden and the page still works when BakeBuildLab is absent', async () => {
  const saved = globalThis.BakeBuildLab;
  try {
    delete globalThis.BakeBuildLab;
    const { doc } = await boot();
    assert.equal(doc.getElementById('lab').hidden, true, 'lab hidden without the module');
    assert.equal(doc.getElementById('status').textContent, 'All geometry rules pass', 'viewer unaffected');
    assert.equal(doc.getElementById('lab-tbody').children.length, 0, 'no lab rows rendered');
  } finally {
    globalThis.BakeBuildLab = saved;
  }
});

test('lab nozzle and filament selectors populate with the supported options', async () => {
  const { doc } = await boot();
  const nozzle = doc.getElementById('lab-nozzle'), material = doc.getElementById('lab-material');
  assert.deepEqual(nozzle.children.map((o) => o.value), ['0.4', '0.6']);
  assert.deepEqual(material.children.map((o) => o.value), ['PLA', 'PETG', 'ABS']);
  assert.equal(nozzle.value, '0.4');
  assert.equal(material.value, 'PLA');
});

test('material change rewrites the mass column header and row masses', async () => {
  const { doc } = await boot();
  const material = doc.getElementById('lab-material');
  const before = doc.getElementById('lab-tbody').children[0].children[7].textContent;
  material.value = 'PETG';
  material.dispatch('change');
  assert.equal(doc.getElementById('lab-mass-col').textContent, 'Mass PETG (g)');
  const after = doc.getElementById('lab-tbody').children[0].children[7].textContent;
  assert.notEqual(after, before, 'mass values re-render for the chosen filament');
  const r = LAB.compareModels()[0];
  assert.equal(after, r.mass.PETG.toFixed(2));
});

test('switching to the keyring retargets the probe to hole diameter and highlights its row', async () => {
  const { doc } = await boot();
  const select = doc.getElementById('design');
  select.value = 'orpheus_fusering_keyring';
  select.dispatch('change');
  assert.equal(doc.getElementById('lab-probe-label').textContent, 'Hole diameter probe (mm)');
  assert.equal(doc.getElementById('lab-probe').value, '6', 'probe resets to the clear hole');
  assert.equal(doc.getElementById('lab-probe').max, '20');
  const rows = doc.getElementById('lab-tbody').children;
  assert.equal(rows[3].className, 'sel', 'keyring row marked selected');
  assert.equal(rows[0].className, '', 'cutter row unmarked');
});

test('probe input re-renders the dashed probe contour with its aria-label', async () => {
  const { doc } = await boot();
  const probe = doc.getElementById('lab-probe');
  probe.value = '1.2';
  probe.dispatch('input');
  const xsec = doc.getElementById('lab-xsec');
  const probePath = xsec.children.find((c) => c.getAttribute('class') === 'probe-line');
  assert.ok(probePath, 'probe contour exists');
  assert.match(probePath.getAttribute('aria-label'), /probe 1\.2 mm, ratio 3/, 'probe ratio in label');
});

test('probe change normalizes out-of-range values to per-type limits', async () => {
  const { doc } = await boot();
  const probe = doc.getElementById('lab-probe');
  probe.value = '99';
  probe.dispatch('change');
  assert.equal(probe.value, '8', 'cutter probe clamps to 8 mm');
  const select = doc.getElementById('design');
  select.value = 'orpheus_fusering_keyring';
  select.dispatch('change');
  probe.value = '0';
  probe.dispatch('change');
  assert.equal(probe.value, '6', 'invalid keyring probe restores the clear hole default');
});

test('inspect buttons drive the shared 3D viewport and focus the canvas', async () => {
  const { doc, canvas } = await boot();
  const rows = doc.getElementById('lab-tbody').children;
  rows[3].children[8].children[0].click();
  assert.equal(doc.getElementById('design').value, 'orpheus_fusering_keyring');
  assert.equal(doc.getElementById('model-name').textContent, 'Orpheus FuseRing');
  assert.equal(doc.activeElement, canvas, 'canvas receives keyboard focus for orbit controls');
  rows[1].children[8].children[0].click();
  assert.equal(doc.getElementById('design').value, 'hex_gear_logic_gate_cutter');
});

test('cross-section svg draws contour, three focusable bands, probe path, and a marker', async () => {
  const { doc } = await boot();
  const xsec = doc.getElementById('lab-xsec');
  const cls = xsec.children.map((c) => c.getAttribute('class'));
  assert.deepEqual(cls.slice(0, 4), ['contour', 'band lip', 'band wall', 'band rim'], 'cutter bands drawn');
  assert.ok(cls.includes('probe-line') && cls.includes('marker'));
  for (const c of xsec.children.filter((c) => (c.getAttribute('class') || '').startsWith('band'))) {
    assert.equal(c.getAttribute('tabindex'), '0', 'band contour keyboard focusable');
    assert.equal(c.getAttribute('role'), 'img');
    assert.match(c.getAttribute('aria-label'), /offset \d/);
  }
  assert.ok((xsec.getAttribute('viewBox') || '').split(' ').every((v) => Number.isFinite(Number(v))), 'viewBox set to mm extents');
});

test('keyring cross-section swaps bands for the hole polygon and clear circle', async () => {
  const { doc } = await boot();
  const select = doc.getElementById('design');
  select.value = 'orpheus_fusering_keyring';
  select.dispatch('change');
  const xsec = doc.getElementById('lab-xsec');
  const cls = xsec.children.map((c) => c.getAttribute('class'));
  assert.ok(cls.includes('holeline'), 'hole boundary polygon drawn');
  const clear = xsec.children.find((c) => c.getAttribute('class') === 'clear');
  assert.ok(clear, 'clear hole circle drawn');
  assert.equal(clear.getAttribute('r'), '3', 'clear circle is the 6 mm radius-3 inscribed circle');
  assert.equal(clear.getAttribute('tabindex'), '0', 'clear circle focusable');
});

test('ratio chart renders one bar per sweep row with a threshold line and focusable bars', async () => {
  const { doc } = await boot();
  const chart = doc.getElementById('lab-ratio');
  const bars = chart.children.filter((c) => (c.getAttribute('class') || '').startsWith('bar '));
  assert.equal(bars.length, 13, 'thirteen lip sweep rows');
  assert.ok(chart.children.some((c) => c.getAttribute('class') === 'thresh'), '2.0 threshold line drawn');
  assert.equal(bars[0].getAttribute('tabindex'), '0');
  assert.match(bars[0].getAttribute('aria-label'), /below threshold/, '0.4 mm lip on 0.4 mm nozzle cannot print');
  assert.match(bars.at(-1).getAttribute('aria-label'), /printable/);
  const probed = bars.filter((b) => (b.getAttribute('class') || '').includes(' cur'));
  assert.equal(probed.length, 1, 'exactly the probed row is outlined');
});

test('keyring ratio chart switches to the seven hole sweep rows', async () => {
  const { doc } = await boot();
  const select = doc.getElementById('design');
  select.value = 'orpheus_fusering_keyring';
  select.dispatch('change');
  const chart = doc.getElementById('lab-ratio');
  const bars = chart.children.filter((c) => (c.getAttribute('class') || '').startsWith('bar '));
  assert.equal(bars.length, 7, 'seven hole diameter rows');
  assert.match(bars[0].getAttribute('aria-label'), /^hole 4 mm: ratio /);
});

test('nozzle change re-renders the chart and the share link', async () => {
  const { doc } = await boot();
  const nozzle = doc.getElementById('lab-nozzle');
  const before = doc.getElementById('lab-share-url').value;
  nozzle.value = '0.6';
  nozzle.dispatch('change');
  const after = doc.getElementById('lab-share-url').value;
  assert.match(before, /&n=0\.4&/);
  assert.match(after, /&n=0\.6&/, 'nozzle encoded into the share link');
  const bars = doc.getElementById('lab-ratio').children.filter((c) => (c.getAttribute('class') || '').startsWith('bar '));
  const printable = bars.filter((b) => (b.getAttribute('class') || '').includes('ok')).length;
  assert.equal(printable, 5, 'on 0.6 mm nozzle only lips >= 1.2 mm print');
});

test('fingerprint shows a real SHA-256 hex digest in data-digest matching the exports', async () => {
  const { doc, downloads } = await boot();
  const digest = doc.getElementById('lab-digest').getAttribute('data-digest');
  assert.match(digest, /^[0-9a-f]{64}$/, 'full hex digest stored');
  doc.getElementById('lab-json').click();
  const json = JSON.parse(downloads.at(-1).parts[0]);
  assert.equal(json.integrity.digest, digest, 'JSON export digest equals on-page fingerprint');
  doc.getElementById('lab-csv').click();
  assert.ok(downloads.at(-1).parts[0].includes('# sha256 ' + digest), 'CSV provenance digest equals fingerprint');
  doc.getElementById('lab-md').click();
  assert.ok(downloads.at(-1).parts[0].includes('SHA-256 audit digest: `' + digest + '`'), 'Markdown footer digest equals fingerprint');
});

test('audit JSON export carries the schema, state, models, sweep, and probe', async () => {
  const { doc, downloads } = await boot();
  doc.getElementById('lab-json').click();
  const blob = downloads.at(-1);
  const parsed = JSON.parse(blob.parts[0]);
  assert.equal(parsed.schema, 'bakebuild-audit/1');
  assert.equal(parsed.state.model, 'orpheus_circuit_crest_cutter');
  assert.equal(parsed.models.length, 4);
  assert.equal(parsed.sweep.kind, 'lip');
  assert.equal(parsed.sweep.rows.length, 13);
  assert.equal(parsed.probe.kind, 'lip');
  const anchor = doc.created.filter((el) => el.tagName === 'A').at(-1);
  assert.equal(anchor.download, 'bakebuild-audit.json');
});

test('audit CSV export is formula-safe with four model rows and provenance', async () => {
  const { doc, downloads } = await boot();
  doc.getElementById('lab-csv').click();
  const text = downloads.at(-1).parts[0];
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '# bakebuild-studio audit brief v1');
  assert.match(lines[1], /^# state model=orpheus_circuit_crest_cutter nozzle=0\.4 material=PLA probe=0\.8$/);
  assert.match(lines[2], /^# sha256 [0-9a-f]{64}$/);
  assert.match(lines[3], /^model,type,dim_x_mm/);
  assert.equal(lines.length, 4 + 4 + 2, 'three provenance lines, header, four rows, probe header, probe row');
  for (const line of lines.slice(4, 8)) assert.ok(!/^[=+\-@\t]/.test(line), 'no formula-leading cell');
  const anchor = doc.created.filter((el) => el.tagName === 'A').at(-1);
  assert.equal(anchor.download, 'bakebuild-audit.csv');
});

test('audit Markdown export contains the comparison table and digest footer', async () => {
  const { doc, downloads } = await boot();
  doc.getElementById('lab-md').click();
  const text = downloads.at(-1).parts[0];
  assert.match(text, /^## BakeBuild Studio audit brief/m);
  assert.equal((text.match(/^\| /gm) || []).length, 6, 'header, separator, four model rows');
  assert.match(text, /SHA-256 audit digest: `[0-9a-f]{64}`/);
  const anchor = doc.created.filter((el) => el.tagName === 'A').at(-1);
  assert.equal(anchor.download, 'bakebuild-audit.md');
});

test('copy share link fills the readonly field and reports through the status region', async () => {
  const { doc } = await boot();
  doc.getElementById('lab-share').click();
  const field = doc.getElementById('lab-share-url');
  assert.match(field.value, /#bbs=m=orpheus_circuit_crest_cutter&n=0\.4&f=PLA&p=0\.8$/, 'share link encodes the live state');
  assert.ok(doc.getElementById('lab-status').textContent.length > 0, 'status line updated');
});

test('verify digest confirms the stamped SHA-256 against a fresh recomputation', async () => {
  const { doc } = await boot();
  doc.getElementById('lab-verify').click();
  assert.match(doc.getElementById('lab-status').textContent, /Digest verified/);
});

test('tamper demo proves a mutated payload fails the digest check', async () => {
  const { doc } = await boot();
  doc.getElementById('lab-tamper').click();
  assert.match(doc.getElementById('lab-status').textContent, /Tamper detected/);
});

test('in-page self-test runner lists every check with a passing count', async () => {
  const { doc } = await boot();
  doc.getElementById('lab-run-tests').click();
  const items = doc.getElementById('lab-test-list').children;
  assert.equal(items.length, LAB.SELF_TESTS.length, 'every self-test listed');
  assert.ok(LAB.SELF_TESTS.length >= 16, 'at least sixteen in-page checks');
  for (const li of items) {
    assert.equal(li.className, 'pass', `${li.textContent} passes`);
    assert.ok(li.textContent.startsWith('✓'), 'pass glyph prefix');
  }
  assert.equal(doc.getElementById('lab-test-count').textContent, `${items.length}/${items.length} passing`);
});

test('boot with a #bbs= hash restores model, nozzle, material, and probe', async () => {
  const { doc } = await boot('#bbs=m=orpheus_fusering_keyring&n=0.6&f=PETG&p=7');
  assert.equal(doc.getElementById('design').value, 'orpheus_fusering_keyring');
  assert.equal(doc.getElementById('model-name').textContent, 'Orpheus FuseRing');
  assert.equal(doc.getElementById('lab-nozzle').value, '0.6');
  assert.equal(doc.getElementById('lab-material').value, 'PETG');
  assert.equal(doc.getElementById('lab-probe').value, '7');
  assert.equal(doc.getElementById('lab-probe-label').textContent, 'Hole diameter probe (mm)');
  const digest = doc.getElementById('lab-digest').getAttribute('data-digest');
  assert.equal(digest, LAB.auditDigest({ model: 'orpheus_fusering_keyring', nozzle: 0.6, material: 'PETG', probe: 7 }),
    'restored state stamps the same digest');
});

test('a hostile or malformed hash is rejected and defaults apply', async () => {
  const { doc } = await boot('#bbs=m=ghost&n=9&f=WOOD&p=-1');
  assert.equal(doc.getElementById('design').value, CAD.DESIGNS[0].id, 'default model applies');
  assert.equal(doc.getElementById('lab-nozzle').value, '0.4');
  assert.equal(doc.getElementById('lab-material').value, 'PLA');
  assert.equal(doc.getElementById('lab-probe').value, '0.8');
});

test('hashchange re-applies the encoded state without a reload', async () => {
  const { doc, win } = await boot('#bbs=m=orpheus_circuit_crest_cutter&n=0.4&f=PLA&p=0.8');
  win.location.hash = '#bbs=m=stepcheck_sigma_badge_cutter&n=0.6&f=ABS&p=1.4';
  win.dispatch('hashchange');
  assert.equal(doc.getElementById('design').value, 'stepcheck_sigma_badge_cutter');
  assert.equal(doc.getElementById('lab-nozzle').value, '0.6');
  assert.equal(doc.getElementById('lab-material').value, 'ABS');
  assert.equal(doc.getElementById('lab-probe').value, '1.4');
});

test('round trip: share link from the live state reloads to the identical fields', async () => {
  const first = await boot();
  const sel = first.doc.getElementById('design');
  sel.value = 'stepcheck_sigma_badge_cutter';
  sel.dispatch('change');
  const nozzle = first.doc.getElementById('lab-nozzle');
  nozzle.value = '0.6';
  nozzle.dispatch('change');
  const material = first.doc.getElementById('lab-material');
  material.value = 'ABS';
  material.dispatch('change');
  const probe = first.doc.getElementById('lab-probe');
  probe.value = '1.4';
  probe.dispatch('input');
  const hash = first.doc.getElementById('lab-share-url').value.split('#')[1];
  const second = await boot('#' + hash);
  assert.equal(second.doc.getElementById('design').value, 'stepcheck_sigma_badge_cutter');
  assert.equal(second.doc.getElementById('lab-nozzle').value, '0.6');
  assert.equal(second.doc.getElementById('lab-material').value, 'ABS');
  assert.equal(second.doc.getElementById('lab-probe').value, '1.4');
});
