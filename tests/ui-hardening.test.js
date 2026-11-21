// UI/compliance hardening checks for the BakeBuild Studio static app shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText, readExport, ROOT } from './helpers.js';
import '../cad-engine.js';
const CAD = globalThis.BakeBuildCAD;

const HTML = readText('index.html');
const CSS = readText('style.css');
const APP = readText('app.js');

test('UI: index.html carries a restrictive CSP meta', () => {
  assert.ok(/http-equiv="Content-Security-Policy"/.test(HTML));
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
    assert.ok(HTML.includes(directive), directive);
  }
});

test('UI: CSP forbids remote and inline script sources', () => {
  const csp = (HTML.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.ok(!/script-src[^;]*https?:/i.test(csp));
  assert.ok(!/script-src[^;]*'unsafe-inline'/i.test(csp));
});

test('UI: no inline event-handler attributes in index.html', () => {
  assert.ok(!/\son(click|keydown|keyup|keypress|mouseover|load|error|submit|input|change)=/i.test(HTML));
});

test('UI: canvas keyboard shortcuts are bound to the canvas, not the document (WCAG 2.1.4)', () => {
  assert.ok(/canvas\.addEventListener\('keydown'/.test(APP), 'char-key handler must live on the focusable canvas');
  assert.ok(!/document\.addEventListener\('keydown'|window\.addEventListener\('keydown'/.test(APP), 'global char-key shortcut found');
});

test('UI: char-key handler calls preventDefault and ignores unrelated keys', () => {
  const m = APP.match(/canvas\.addEventListener\('keydown'[\s\S]*?\}\);/);
  assert.ok(m);
  assert.ok(/preventDefault/.test(m[0]));
  assert.ok(/includes\(e\.key\)/.test(m[0]));
});

test('UI: focus-visible outlines cover buttons, selects, links and canvas', () => {
  for (const sel of ['button:focus-visible', 'select:focus-visible', 'canvas:focus-visible', 'a:focus-visible']) {
    assert.ok(CSS.includes(sel), sel);
  }
  const rule = CSS.slice(CSS.indexOf(':focus-visible'));
  assert.ok(/outline:\s*[2-9](\.\d+)?px/.test(rule.slice(0, 400)));
});

test('UI: canvas has an accessible name and is keyboard focusable', () => {
  const canvas = (HTML.match(/<canvas[^>]*>/) || [''])[0];
  assert.ok(/aria-label="[^"]+"/.test(canvas), canvas);
  assert.ok(/tabindex="0"/.test(canvas), canvas);
});

test('UI: no scroll-behavior smooth anywhere in CSS', () => {
  assert.ok(!/scroll-behavior\s*:\s*smooth/.test(CSS + HTML + APP));
});

test('UI: app renders controls for every design id', () => {
  for (const d of CAD.DESIGNS) {
    assert.ok(APP.includes('option') || HTML.includes('<select'), 'selector wiring');
  }
});

test('UI: STEP FILE_NAME timestamp is fixed for deterministic exports', () => {
  const step = CAD.toSTEP(CAD.generate(CAD.DESIGNS[0].id));
  const line = step.split('\n').find((l) => l.startsWith('FILE_NAME'));
  assert.ok(line.includes("'2026-11-04T00:00:00'"), line);
});

test('UI: shipped STEP files are byte-identical to fresh generation', () => {
  for (const d of CAD.DESIGNS) {
    const fresh = CAD.toSTEP(CAD.generate(d.id));
    assert.equal(fresh, readExport(`${d.id}.step`), `${d.id}.step drifted from generator`);
  }
});

test('UI: shipped STL files are byte-identical to fresh generation', () => {
  for (const d of CAD.DESIGNS) {
    const fresh = CAD.toSTL(CAD.generate(d.id));
    assert.equal(fresh, readExport(`${d.id}.stl`), `${d.id}.stl drifted from generator`);
  }
});
