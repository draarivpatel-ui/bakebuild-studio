// ES-module entry point: loads the UMD engine for its global side effect and
// re-exports the same API, so `import` consumers get named bindings while
// classic <script> loading stays file:// safe.
import './cad-engine.js';
const api = globalThis.BakeBuildCAD;
export default api;
export const {
  DESIGNS, RULES, generate, validate, toSTEP, toSTL,
  profile, offset, signedVolume,
  polygonSelfIntersections, manifoldReport, depthSort,
} = api;
