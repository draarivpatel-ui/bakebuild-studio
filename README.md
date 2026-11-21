# BakeBuild Studio

Zero-dependency local CAD workbench for three custom cookie cutters and one Orpheus FuseRing keyring. Serve this directory on any static HTTP host and open `index.html` to rotate/zoom the shaded 3D mesh, inspect dimensions and rule checks, and download STEP or STL. The workbench uses classic scripts, so `index.html` also opens directly from disk (`file://`) with no server. No external network requests, build tools, or third-party packages are needed.

## Quick start

From the repository root:

```sh
npm test          # full geometry, export, DOM, and compliance suite
npm run build     # regenerate all exports/ files from cad-engine.js
```

The direct equivalents are `node --test tests/*.test.js` and `node cli.js`. Regeneration is deterministic: an unchanged kernel produces byte-identical STEP, STL, and manifest output.

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html` for the interactive workbench.

## Exports

Exports live directly in `exports/`: four `.step` files, four ASCII `.stl` files, and `manifest.json` with dimensions, rule results, topology counts, file sizes, and SHA-256 hashes. Geometry is deterministic and all coordinates are millimetres. Edit the named design parameters in `cad-engine.js` to adjust a profile, then regenerate and rerun validation.

Cookie cutters use custom circuit-crest, hex-gear, and sigma-badge contours with true parallel line offsets: 0.8 mm lip (z=0 to 1.5), 2.0 mm wall (z=1.5 to 10.7), and a 5.0 mm wide by 2.0 mm high top rim (z=10.7 to 12.7). Each fits a 100 x 100 x 100 mm envelope. FuseRing has an Orpheus-inspired outline, flat z=0 bottom, 4 mm height, and a central carabiner hole circumscribed around a 6 mm circle, within 80 x 80 x 6 mm. The coarse polygon hole never intrudes into the specified clear diameter.

STEP uses AP214-style product metadata, explicit millimetre units, shared edge/vertex topology, planar advanced faces, and one manifold solid B-rep per model. Curved silhouettes are intentionally polygonal, not spline surfaces. Each part has a single connected closed shell, including the hole and cutter ledges. STL triangulates that boundary without internal interfaces. All four solids are genus-1 watertight manifolds: the hollow cutter walls and the keyring through hole both have Euler characteristic 0. Independently check CAD import, slicing, clearances, and material safety before manufacturing. These files are geometry prototypes, not a food-contact certification or a manufacturing-readiness guarantee.

## API and verification

The engine exports `generate(id)`, `validate(model)`, `toSTEP(model)`, `toSTL(model)`, `profile(design)`, `offset(points, distance)`, `signedVolume(triangles)`, `polygonSelfIntersections(points)`, `manifoldReport(triangles)`, and `depthSort(triangles)` in both Node and the browser (`globalThis.BakeBuildCAD`; `cad-engine.mjs` re-exports the same API for ES-module consumers). The validator checks generated bounds, height, band parameters, flat bottom, clear hole, and positive signed volume, and inspects the mesh itself: non-empty solids and triangles, finite coordinates, no degenerate facets, closed manifold topology, consistent winding, agreement between reported and mesh-computed volume, and contour simplicity.

The 179-test suite passes on Node 26 across six files:

| File | Focus |
| --- | --- |
| `tests/geometry.test.js` | Kernel units, determinism, parallel-offset distance, signed volume, face planarity, manifold edge incidence, Euler characteristic, outward winding, and mutated-rule rejection |
| `tests/exports.test.js` | Shipped STEP/STL parsing, facet normals, declared coordinates, entity reference closure, B-rep topology counts, SHA-256 hashes, and byte-identical regeneration via `exportAll()` |
| `tests/dom.test.js` | Static markup and accessibility, live `app.js` execution in a DOM shim (selection, redraw, reset, drag, wheel, keyboard, download payloads), and repository compliance gates |
| `tests/hardening.test.js` | Parametric edge cases, scalar guards, offset geometry, and export determinism |
| `tests/ui-hardening.test.js` | Keyboard-scope rules, focus rings, CSP, and offline loading contracts |
| `tests/adversarial.test.js` | Regression tests for the hostile audit: painter-order inversions, hollow validation, offset self-intersection, ESM surface, canvas role, executable bit, STEP exponent case |

Compliance gates assert zero em-dashes, zero en-dashes, zero AI disclosures or model names, and zero personal contact details across every shipped text file. See [DEVPOST_UPGRADE.md](DEVPOST_UPGRADE.md) for the project write-up.
