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
const CAD = globalThis.BakeBuildCAD;
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

async function boot() {
  const dom = createDom();
  // The shim stays installed for the lifetime of this test file: app.js
  // registers DOM event handlers that resolve `document` at dispatch time,
  // not only during the initial module evaluation.
  globalThis.document = dom.doc;
  globalThis.window = dom.win;
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
  assert.match(html, /<script src="cad-engine.js"><\/script><script src="app.js"><\/script>/);
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
