# BakeBuild Studio: four real solids, one small kernel

## Inspiration

Cookie cutter files online are often decorative outlines with no thickness, no closed shell, and no way to tell whether a slicer will see a printable object. This project takes the opposite approach: a small deterministic kernel builds four connected solids from first principles, then writes both a boundary-representation STEP file and a triangulation STL file that describe exactly the same geometry. Every number shown in the browser is computed from the model, and every downloaded byte can be reproduced by one command.

## What it does

The workbench ships four designs: three cookie cutters (Orpheus Circuit Crest, Hex Gear Logic Gate, and Stepcheck Sigma Badge) and one Orpheus FuseRing keyring. Each cutter is a genuine hollow wall with three stepped bands: a 0.8 mm cutting lip, a 2.0 mm main wall, and a 5.0 mm wide top handle rim, all inside a 100 mm build envelope at 12.7 mm total height. The keyring is a 4 mm tall solid with a flat bottom and a through hole whose polygonal boundary circumscribes a clear 6 mm circle.

The browser view renders the real triangle mesh on a 2D canvas with CPU depth sorting and shading. Drag orbit, wheel zoom, arrow keys, plus/minus keys, and a reset button all operate on the same camera state. A design selector recomputes the model, the dimensions readout, and the full rule-check list. STEP and STL downloads are generated in the browser from the live model, so they cannot drift from what is on screen. An export manifest lists dimensions, rule results, topology counts, file sizes, and SHA-256 hashes for all eight files.

## How we built it

`cad-engine.js` is a single UMD source with no runtime dependencies (classic-script safe, so `index.html` works from `file://`); `cad-engine.mjs` re-exports the same API for ES-module consumers. Profiles are sampled as equally spaced polar polygons with deterministic harmonic perturbations. Band contours use a true parallel line offset computed from the intersection of adjacent translated edge lines, not radial scaling, so wall thickness stays at the specified perpendicular distance even at sharp lobes. Each solid is assembled from ten quad rings per sector for cutters (three inner walls, three outer walls, three downward ledges, one upward top rim) or four for the keyring (inner hole wall, outer wall, bottom and top annuli).

The STEP writer emits AP214-style product metadata, explicit millimetre, radian, and steradian units, a geometric tolerance context, shared `EDGE_CURVE` and `VERTEX_POINT` topology, planar `ADVANCED_FACE` surfaces, one `CLOSED_SHELL`, and one `MANIFOLD_SOLID_BREP`. The STL writer triangulates the same face list. Both are pure functions of the generated model, and `cli.js` serializes them alongside a manifest. Regeneration from an unchanged kernel is byte-identical.

## Verification

The upgraded suite has 410 tests across seven files and passes on Node 26:

```sh
npm test
```

Geometry tests prove determinism, exact band heights, flat bottoms, the 6 mm inscribed hole, 2 mm perpendicular offset distance on every vertex of every band, signed volume (including orientation reversal), face planarity, and Euler characteristic. Manifold checks count boundary edges, non-manifold edges, flipped edge winding, and degenerate triangles; all four solids report zero for each. A closed surface also has zero net normal flux, and outward winding is confirmed by positive signed volume.

Export tests re-parse the shipped ASCII STL text and the STEP DATA section rather than trusting the generator. They verify declared facet normals against geometric winding, coordinate-by-coordinate agreement with a fresh `generate()` call, SHA-256 hashes and byte counts, sequential entity ids with no dangling references, exact B-rep entity counts, and a full `exportAll()` regeneration into a temporary directory that matches the checked-in files byte for byte.

DOM tests execute the actual `app.js` module against a small DOM and canvas shim. They cover design switching, check-list rendering, reset, pointer drag and release, clamped wheel zoom, every supported keyboard control, window resize, and both download payloads compared against the shipped exports. Static checks cover doctype, headings, unique ids, label resolution, focus rings, and responsive CSS. The lab suite adds known-answer SHA-256 vectors checked against the platform crypto, a four-model topology comparator, cutter-lip and carabiner-hole nozzle wall-ratio sweeps, a strict bookmark-hash codec with hostile-input rejection, one cached digest shared across the JSON, CSV, and Markdown audit exports, and formula-escaped CSV cells.

Compliance gates scan every shipped text file for em-dashes, en-dashes, AI disclosures, model names, and personal contact details. Zero occurrences are allowed. The harness command is:

```sh
python3 "../../hark_honesty_and_defect_harness.py" --audit . --project bakebuild-studio
```

## Challenges

The first deep issue was topology. A naive ring extrusion produces duplicated vertices and internal sector interfaces, which look fine in a shaded preview but fail manifold checks. The kernel now shares one vertex per ring position and closes every ledge with an annulus, giving each solid a genus-1 surface with balanced outward and inward wall normals.

The offset was another trap. Radial scaling silently changes wall thickness at lobe peaks. Line-intersection offsets keep it exact, but need a collinear fallback when adjacent edges are parallel; both paths are tested. Number formatting also needed care: the STEP and STL writers print `-0.` for a negative zero, so round-trip comparisons normalize it without hiding any coordinate difference.

Browser testing without a browser required a small shim that preserves real event semantics. A real select adopts the value of its first option, and event handlers resolve `document` at dispatch time. The test harness models both so that clicking a download button genuinely produces the shipped file bytes.

## Accomplishments

- Four deterministic, watertight, genus-1 solids with one closed B-rep shell each.
- STEP and STL exports that are byte-identical on regeneration and verified by independent parsers.
- True parallel-offset wall thickness at 0.8 mm, 2.0 mm, and 5.0 mm on every contour vertex.
- A browser workbench whose downloads are generated from the live model, not stale files.
- 410 automated checks spanning kernel math, artifact integrity, browser interaction, audit-lab correctness, and compliance.
- An in-page audit lab with a four-model topology comparator, nozzle wall-ratio sweeps, true-millimetre cross-section charts, SHA-256 stamped JSON/CSV/Markdown audit briefs, and a `#bbs=` bookmark hash that restores the full lab state.

## What's next

The obvious next steps are curved spline silhouettes with exact analytic offsets, a second STL export mode with a coarser facet budget for small printers, and swept-width probes that regenerate the full solid instead of a band estimate. Real food-contact testing, slicer-specific minimum feature checks, and physical fit trials remain outside the scope of a digital geometry prototype.

## Judge demo

Serve this folder with `python3 -m http.server`, open `index.html`, switch between the three cutters and the keyring, and watch the rule list and dimensions update. Drag and zoom the mesh, then download a STEP file and an STL file. Scroll to the audit lab for the comparator table, cross-section and nozzle-ratio charts, digest-stamped exports, the tamper demo, and the in-page self-test runner. Run `npm test` to see all 410 checks pass and `npm run build` to confirm the exports regenerate without changing a byte.
