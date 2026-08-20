// The paddle, as a set of numbers rather than an asset.
//
// Paddle.glb is a mobile-game prop: one mesh, one material, a flat butt joint,
// and — more importantly for feel — a shape nothing in the codebase can reason
// about. Every physical fact the game needs (where the blade is, how wide, how
// thick, how heavy, how it swings) had to be *recovered* from it by measuring a
// bounding box and reading artist-placed empties, and the long comment blocks
// in models.js are the archaeology that took. This module inverts that: the bat
// is DEFINED here, and both the mesh (scene/paddleGeometry.js) and the physical
// properties below are derived from the same definition. Nothing is measured,
// so nothing can disagree.
//
// Deliberately dependency-free — no three, no DOM. It is pure geometry and
// integration, which makes it testable in Node and keeps physics/ from
// importing scene/.
//
// Coordinate convention is inherited from the GLB so the whole calibration
// stack (T_cal, presets, the wizard, muscle memory) stays valid:
//
//     +Y  blade tip            origin (0,0,0) = the controller grip point,
//      |                       i.e. the centroid of the closed fist. It sits
//   ((( ))) blade              INSIDE the handle, near the throat.
//      |
//      +----> +X  blade width  +Z = face normal (blade thinnest axis)
//      |
//     -Y  handle butt
//
// models.js then applies PADDLE_EULER, which maps model +Y → grip −Z (blade
// points out along the controller barrel) and model +Z → grip +X (face normal
// out through the knuckles). Do not change the convention without re-validating
// in headset — see the note on PADDLE_EULER in models.js.

// --- The bat ----------------------------------------------------------------
//
// All lengths in meters, densities in kg/m³. Every number here is either a real
// measurement off a competition bat or a documented deviation from one.

export const PADDLE_SPEC = {
  // Blade head — a real competition head, 150 mm across by 157 mm along the
  // handle (Butterfly/Stiga/DHS all sit within a couple of mm of this).
  //
  // This shipped briefly as a 152 mm CIRCLE, chosen because the collider is a
  // disc and a circular blade makes the collision surface and the visible
  // rubber the same shape exactly. That was the wrong trade and it is worth
  // recording why: a circle is the SMALLEST outline for a given half-extent, so
  // the head read visibly undersized next to a real bat — the shoulders sat
  // high and the face looked narrow — and a paddle that does not look like a
  // paddle costs more presence than a few mm of collider slop ever buys back.
  bladeHalfWidth:  0.0750,   // X — 150 mm across
  bladeHalfLength: 0.0785,   // Y — 157 mm along the handle axis

  // Outline fullness. The head is a SUPERELLIPSE, |x/rx|^n + |y/ry|^n = 1, not
  // an ellipse: a real blade holds near-maximum width over a long span and
  // carries that width down into wide, low shoulders, which an ellipse does not
  // — it pinches away from the widest point immediately, and that pinch is most
  // of why the circular head looked small.
  //
  // 2.2 is fitted, not guessed: swept against the GLB's own measured width
  // profile (which is a real bat's shape even though the asset is a prop), the
  // residual bottoms out at n ≈ 2.15 with ~3.8 mm RMS. Rounded up slightly for
  // fullness. Raising it further keeps filling out the shoulders but pushes the
  // corners past the collision disc — at n = 2.8 that is 6.4 mm of rubber
  // outside the clean face, which is back to the GLB's problem.
  bladeShapeExponent: 2.2,

  // Distance from the grip point to the blade's geometric center. Held at the
  // GLB's value so the bat sits exactly where players' hands already expect it
  // and every calibration preset in xr/calibrationPresets.js stays meaningful.
  //
  // For the record, this is ~15 mm shorter than a real shakehand grip, where
  // fist-centroid → blade-center measures ~125-130 mm (the spec's own C1
  // 'shakehand' preset says 140 mm). Pushing it out is a one-line change here,
  // but it moves the blade for everyone and invalidates the tuned 'default'
  // preset, so it wants a headset session, not a guess.
  bladeCenterY:    0.0915,

  // --- Strata, per side of the wood core -----------------------------------
  // A real bat's rim is a visible sandwich: topsheet / sponge / ply / sponge /
  // topsheet. Here those are five separate extrusions sharing one silhouette,
  // so the layers ARE geometry — no strata texture, no fake edge band. Totals
  // 13.6 mm, inside the 12-20 mm real-bat range.
  plyThickness:      0.0060,   // 5-ply blade core
  spongeThickness:   0.0020,   // 2.0 mm sponge (a common offensive spec)
  topsheetThickness: 0.0018,   // 1.8 mm pimple-in topsheet

  // Rubber is trimmed flush to the wood at the edge (real bats are cut with the
  // blade as the guide) and terminated in a straight factory cut above the
  // throat, leaving bare wing wood between the cut and the handle.
  //
  // Set by what it produces, not picked for its own sake: it leaves 7 mm of
  // bare wing between the top of the handle cheeks and the rubber, and lands
  // the straight cut at 55 mm wide — both what a real bat measures. It is
  // coupled to throatHeight: the flare is fast, so a cut placed only a few mm
  // higher is a much wider cut (at 10.5 mm it came out 77 mm, which reads as
  // rubber spilling into the throat). Re-measure both together if either moves.
  cutAboveBladeBottom: 0.0070,

  // --- Throat -------------------------------------------------------------
  // The wood flares from handle width out to blade width over this height, on
  // a concave curve. Without it the blade meets the handle in a 90° butt joint
  // — the single most "molded toy" feature of the GLB, which reaches 90 mm wide
  // less than 3 mm above its own handle.
  //
  // 14 mm, down from 22. A real blade flares FAST: the shoulders are wide and
  // low, and a long gentle flare reads as a narrow head on a stick because it
  // holds the outline well inside the blade curve for the whole lower third.
  // This is short enough to keep the shoulders low and long enough that the
  // junction is still visibly a joint.
  throatHeight: 0.0140,

  // --- Handle (flared / FL) ------------------------------------------------
  // Half-extents at butt / waist / throat. Width is across the blade plane (X),
  // depth is along the face normal (Z). A flared handle is widest at the butt,
  // necks at the waist, and widens again into the wings.
  handleLength:          0.1000,
  handleHalfWidthButt:   0.0155,
  handleHalfWidthWaist:  0.0105,
  handleHalfWidthThroat: 0.0140,
  handleHalfDepthButt:   0.0122,
  handleHalfDepthWaist:  0.0102,
  handleHalfDepthThroat: 0.0105,
  // Cross-section shape: 2 = ellipse, 4 = rounded rectangle, ∞ = rectangle.
  // Real shakehand handles are a rounded rectangle with the corners well
  // broken; 4 is that.
  handleShapeExponent:   4,
  // Where the glued-on handle cheeks stop and taper into the blade wood.
  handleTopBevel:        0.0120,
  // Ply tongue sits this far inside the cheeks — it is buried, the inset just
  // keeps the two surfaces from z-fighting.
  cheekInset:            0.0010,

  // --- Densities ------------------------------------------------------------
  // Chosen to land the assembled bat at ~186 g, the bare blade at ~85 g, and a
  // sheet of rubber at ~50 g per side, which is where a real allround setup
  // sits. These are effective densities for the whole layer, not material
  // handbook values: the ply figure averages a hard outer veneer over a soft
  // ayous core, and the topsheet figure folds in the pimple voids on the
  // underside. Re-check them after any change to the blade outline — the
  // superellipse carries ~6% more area than the ellipse of the same extents,
  // and that lands entirely on the rubber.
  plyDensity:      520,
  handleDensity:   600,
  spongeDensity:   300,
  topsheetDensity: 1150,

  // --- Tessellation ---------------------------------------------------------
  bladeArcSegments: 96,   // around the blade ellipse
  throatSegments:   14,   // per side, through the wing flare
  handleSegments:   16,   // per side, down the handle silhouette
  handleRings:      22,   // cross-sections along the handle loft
  handleRadial:     24,   // points around each handle cross-section
};

// Live spec. Swappable so a dev build can push URL/tuner overrides in without
// every consumer re-importing; readers should call the accessors below rather
// than closing over the object.
let _spec = { ...PADDLE_SPEC };
let _revision = 0;

export function getPaddleSpec() {
  return _spec;
}

// Merge a partial override and invalidate the derived caches. Returns the new
// spec. Unknown keys are kept (harmless) so a typo shows up as "nothing
// changed" rather than a throw mid-session.
export function setPaddleSpec(partial) {
  _spec = { ..._spec, ...(partial || {}) };
  _revision++;
  _derivedCache = null;
  _massCache = null;
  return _spec;
}

export function resetPaddleSpec() {
  return setPaddleSpec(PADDLE_SPEC);
}

export function paddleSpecRevision() {
  return _revision;
}

// --- Derived geometry -------------------------------------------------------

let _derivedCache = null;

export function derivePaddle(spec = _spec) {
  if (spec === _spec && _derivedCache) return _derivedCache;

  const bladeTopY = spec.bladeCenterY + spec.bladeHalfLength;
  const bladeBottomY = spec.bladeCenterY - spec.bladeHalfLength;
  const d = {
    bladeTopY,
    bladeBottomY,
    handleButtY: bladeBottomY - spec.handleLength,
    // Throat spans blade bottom → shoulder; below it the outline is the ply
    // tongue running down inside the handle.
    throatY: bladeBottomY,
    shoulderY: bladeBottomY + spec.throatHeight,
    rubberCutY: bladeBottomY + spec.cutAboveBladeBottom,
    bevelStartY: bladeBottomY - spec.handleTopBevel,

    coreHalfThickness: spec.plyThickness / 2,
    spongeInnerZ: spec.plyThickness / 2,
    spongeOuterZ: spec.plyThickness / 2 + spec.spongeThickness,
    // Half-thickness of the blade STACK — the number the table-penetration
    // clamp wants. models.js re-measures this off the mesh; they must agree.
    bladeHalfThickness:
      spec.plyThickness / 2 + spec.spongeThickness + spec.topsheetThickness,

    // Collision disc. Exact by construction: the blade is a circle of this
    // radius centered on bladeCenterY, so there is no phantom face past the
    // rubber and no rubber outside the clean-face disc.
    hitRadius: Math.max(spec.bladeHalfWidth, spec.bladeHalfLength),
  };

  if (spec === _spec) _derivedCache = d;
  return d;
}

// --- Silhouette -------------------------------------------------------------
//
// ONE half-width function describes the whole bat outline in the XY plane, from
// butt to tip. Every extrusion (ply, sponge ×2, topsheet ×2) samples it; the
// rubber layers just clip the bottom at the factory cut. Sharing the function
// is what guarantees the layers are flush at the rim, which is what makes the
// edge read as a sandwich instead of a stack of mismatched decals.

const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : v);

// Where the flared handle reaches its waist, as a fraction of handle length
// from the butt. The butt flare is shorter than the throat flare on a real FL
// handle, hence not 0.5.
const HANDLE_WAIST_T = 0.45;

function flaredProfile(t, butt, waist, throat) {
  const u = clamp01(t);
  if (u <= HANDLE_WAIST_T) {
    const k = u / HANDLE_WAIST_T;              // 0 at butt → 1 at waist
    return waist + (butt - waist) * Math.pow(1 - k, 2.0);
  }
  const k = (u - HANDLE_WAIST_T) / (1 - HANDLE_WAIST_T);  // 0 waist → 1 throat
  return waist + (throat - waist) * Math.pow(k, 2.6);
}

function handleT(y, spec, d) {
  return (y - d.handleButtY) / spec.handleLength;
}

export function handleHalfWidthAt(y, spec = _spec) {
  const d = derivePaddle(spec);
  return flaredProfile(
    handleT(y, spec, d),
    spec.handleHalfWidthButt, spec.handleHalfWidthWaist, spec.handleHalfWidthThroat,
  );
}

// Half-depth (along the face normal) of the handle solid. Above bevelStartY the
// glued-on cheeks taper away so the handle blends into the 6 mm ply instead of
// ending in a step.
export function handleHalfDepthAt(y, spec = _spec) {
  const d = derivePaddle(spec);
  const base = flaredProfile(
    handleT(y, spec, d),
    spec.handleHalfDepthButt, spec.handleHalfDepthWaist, spec.handleHalfDepthThroat,
  );
  if (y <= d.bevelStartY) return base;
  const k = clamp01((y - d.bevelStartY) / (d.throatY - d.bevelStartY));
  const ease = k * k * (3 - 2 * k);            // smoothstep
  const tip = d.coreHalfThickness + 0.0008;    // just proud of the ply
  return base + (tip - base) * ease;
}

// Half-width of the blade superellipse at height y. n = 2 recovers the ellipse.
export function bladeHalfWidthAt(y, spec = _spec) {
  const t = Math.abs((y - spec.bladeCenterY) / spec.bladeHalfLength);
  if (t >= 1) return 0;
  const n = spec.bladeShapeExponent;
  return spec.bladeHalfWidth * Math.pow(1 - Math.pow(t, n), 1 / n);
}

// Point on the blade outline at parameter angle theta, and the inverse (the
// theta that lands on a given height). The mesh walks the head by ANGLE rather
// than by height — uniform-in-y sampling starves the tip, which is the one part
// of the bat the player looks straight down at — so both directions are needed.
export function bladeOutlinePoint(theta, spec = _spec) {
  const e = 2 / spec.bladeShapeExponent;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    x: Math.sign(c) * Math.pow(Math.abs(c), e) * spec.bladeHalfWidth,
    y: spec.bladeCenterY
      + Math.sign(s) * Math.pow(Math.abs(s), e) * spec.bladeHalfLength,
  };
}

export function bladeAngleAtHeight(y, spec = _spec) {
  const v = Math.max(-1, Math.min(1,
    (y - spec.bladeCenterY) / spec.bladeHalfLength));
  // Invert y(theta) = ry·sign(sin)|sin|^(2/n) for sin(theta).
  const sin = Math.sign(v) * Math.pow(Math.abs(v), spec.bladeShapeExponent / 2);
  return Math.asin(Math.max(-1, Math.min(1, sin)));
}

// Numeric slope, used to make the throat curve meet its neighbours tangentially.
// Analytic derivatives exist for both sides but a central difference is exact
// enough at 10 µm and cannot fall out of sync with the profile functions.
function slopeAt(fn, y, h = 1e-5) {
  return (fn(y + h) - fn(y - h)) / (2 * h);
}

// The outline, for any y from the butt to the tip.
//
//   y ≥ shoulder : the blade superellipse
//   throat..shoulder : cubic Hermite, tangent to the handle below and to the
//                      head above, which makes it concave — the wings
//   y < throat   : the ply tongue, hugging just inside the handle cheeks
//
// The Hermite is why the throat looks assembled rather than butt-jointed, and
// tangency at both ends is why there is no crease to catch the key light.
export function paddleOutlineHalfWidth(y, spec = _spec) {
  const d = derivePaddle(spec);
  const head = (yy) => bladeHalfWidthAt(yy, spec);
  const tongue = (yy) => handleHalfWidthAt(yy, spec) - spec.cheekInset;

  if (y >= d.shoulderY) return head(y);
  if (y <= d.throatY) return tongue(y);

  const span = d.shoulderY - d.throatY;
  const u = (y - d.throatY) / span;
  const w0 = tongue(d.throatY);
  const w1 = head(d.shoulderY);
  const m0 = slopeAt(tongue, d.throatY) * span;
  const m1 = slopeAt(head, d.shoulderY) * span;

  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * w0 + h10 * m0 + h01 * w1 + h11 * m1;
}

// Superellipse |x/a|^n + |z/b|^n = 1, used for the handle cross-section.
// Returns the point at parameter angle t ∈ [0, 2π).
export function superellipsePoint(t, a, b, n) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / n;
  return {
    x: Math.sign(c) * Math.pow(Math.abs(c), e) * a,
    z: Math.sign(s) * Math.pow(Math.abs(s), e) * b,
  };
}

// Area of that superellipse: 4ab·Γ(1+1/n)²/Γ(1+2/n). Only n = 2 and n = 4 are
// realistic handle sections, so the two constants are tabulated rather than
// dragging in a gamma function; anything else falls back to the ellipse, which
// under-reports mass by at most 15% at n = 4.
const SUPERELLIPSE_AREA_K = { 2: Math.PI, 4: 3.708136 };
export function superellipseArea(a, b, n) {
  return (SUPERELLIPSE_AREA_K[n] || Math.PI) * a * b;
}

// --- Mass properties --------------------------------------------------------
//
// What "weight" actually means for a bat is not its mass — it is how hard the
// bat is to accelerate about the wrist, i.e. the second moment of mass about
// the grip point. Two 180 g bats with the rubber weight in different places
// feel completely different. Because the grip point is the model origin by
// construction, that moment is just ∫y² dm with no parallel-axis bookkeeping.
//
// Everything is integrated over y with the same silhouette the mesh uses, so
// changing a number in PADDLE_SPEC moves the mesh and the feel together.

const INTEGRATION_STEPS = 2000;

// Midpoint-rule accumulation of a slab: width(y) × thickness at height y,
// offset zOff along the face normal, of density rho.
function integrateSlab(y0, y1, widthFn, thickness, zOff, rho, acc) {
  if (y1 <= y0 || thickness <= 0) return;
  const dy = (y1 - y0) / INTEGRATION_STEPS;
  // Through-thickness contribution to ∫z² dm for a slab centered at zOff.
  const zz = zOff * zOff + (thickness * thickness) / 12;
  for (let i = 0; i < INTEGRATION_STEPS; i++) {
    const y = y0 + (i + 0.5) * dy;
    const w = widthFn(y);
    if (w <= 0) continue;
    const dm = 2 * w * thickness * dy * rho;
    acc.m += dm;
    acc.my += dm * y;
    acc.i += dm * (y * y + zz);
  }
}

let _massCache = null;

export function paddleMassProperties(spec = _spec) {
  if (spec === _spec && _massCache) return _massCache;

  const d = derivePaddle(spec);
  const outline = (y) => paddleOutlineHalfWidth(y, spec);

  const part = () => ({ m: 0, my: 0, i: 0 });
  const ply = part();
  const handle = part();
  const sponge = part();
  const topsheet = part();

  // 1. Wood core. One extrusion from butt to tip; the section below the throat
  //    is the tongue buried inside the handle.
  integrateSlab(d.handleButtY, d.bladeTopY, outline, spec.plyThickness, 0,
    spec.plyDensity, ply);

  // 2. Handle cheeks — the superellipse solid MINUS the ply tongue passing
  //    through it, so the overlap is not counted twice. Integrated as an
  //    equivalent slab of the same area so the same accumulator applies.
  {
    const dy = (d.throatY - d.handleButtY) / INTEGRATION_STEPS;
    for (let i = 0; i < INTEGRATION_STEPS; i++) {
      const y = d.handleButtY + (i + 0.5) * dy;
      const a = handleHalfWidthAt(y, spec);
      const b = handleHalfDepthAt(y, spec);
      const gross = superellipseArea(a, b, spec.handleShapeExponent);
      const tongue = 2 * outline(y) * spec.plyThickness;
      const net = Math.max(0, gross - tongue);
      const dm = net * dy * spec.handleDensity;
      handle.m += dm;
      handle.my += dm * y;
      // Radius of gyration through the section, about the X axis: for a
      // rounded rect of half-depth b that is b²/3 to within a few percent.
      handle.i += dm * (y * y + (b * b) / 3);
    }
  }

  // 3 & 4. Rubber, both sides. Same silhouette as the wood, clipped at the
  //        factory cut above the throat.
  for (const side of [1, -1]) {
    integrateSlab(d.rubberCutY, d.bladeTopY, outline, spec.spongeThickness,
      side * (d.spongeInnerZ + spec.spongeThickness / 2), spec.spongeDensity, sponge);
    integrateSlab(d.rubberCutY, d.bladeTopY, outline, spec.topsheetThickness,
      side * (d.spongeOuterZ + spec.topsheetThickness / 2), spec.topsheetDensity, topsheet);
  }

  const mass = ply.m + handle.m + sponge.m + topsheet.m;
  const my = ply.my + handle.my + sponge.my + topsheet.my;
  const inertia = ply.i + handle.i + sponge.i + topsheet.i;

  const props = {
    massKg: mass,
    massGrams: mass * 1000,
    // Bare blade — wood only. This is the number a blade is sold by, and the
    // one to sanity-check against a catalogue (allround 5-ply ≈ 85 g).
    bladeGrams: (ply.m + handle.m) * 1000,
    rubberGrams: (sponge.m + topsheet.m) * 1000,
    // Distance from the grip point to the center of mass, along the handle
    // axis. Real bats balance 70-90 mm ahead of the fist.
    balanceY: my / mass,
    // Second moment of mass about the X axis through the grip point — the
    // "swing weight" you feel resisting a forehand drive. kg·m².
    inertiaGripX: inertia,
    parts: { ply, handle, sponge, topsheet },
  };

  if (spec === _spec) _massCache = props;
  return props;
}

// Swing weight of the current spec relative to the shipped one. Exactly 1.0
// for an unmodified PADDLE_SPEC — same feel-neutrality contract that
// paddleWeight.js holds for its slider, so "did my edit change anything?"
// stays a decidable question.
let _referenceInertia = null;
export function referenceSwingWeight() {
  if (_referenceInertia === null) {
    _referenceInertia = paddleMassProperties(PADDLE_SPEC).inertiaGripX;
  }
  return _referenceInertia;
}

export function swingWeightScale(spec = _spec) {
  const ref = referenceSwingWeight();
  if (!(ref > 0)) return 1;
  const own = spec === PADDLE_SPEC
    ? ref                       // identical float, so the default is exactly 1
    : paddleMassProperties(spec).inertiaGripX;
  return own / ref;
}

// --- Dev overrides ----------------------------------------------------------
//
// Numeric spec keys can be pushed from a query string so the bat can be dialled
// in from inside the headset browser without a rebuild:
//
//   ?paddle.handleLength=0.11&paddle.bladeHalfWidth=0.070
//
// Only keys that already exist and parse as finite numbers are applied — a
// typo is ignored rather than poisoning the spec with NaN, which would
// propagate silently into the collision radius.
export function paddleSpecOverridesFromQuery(search) {
  const out = {};
  if (!search) return out;
  const params = new URLSearchParams(search);
  for (const [key, raw] of params) {
    if (!key.startsWith('paddle.')) continue;
    const name = key.slice('paddle.'.length);
    if (!(name in PADDLE_SPEC)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out[name] = value;
  }
  return out;
}
