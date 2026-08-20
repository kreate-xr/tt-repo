// Procedural ball texture — bakes a seam + cert-mark + logo pattern onto a
// 1024×512 canvas mapped to the SphereGeometry UV layout. Grayscale on
// purpose: the material's `color` uniform tints it, so the same texture
// serves both the white and orange ITTF ball variants without a re-bake.
//
// Why a texture at all? A plain matte sphere rotating is *invisible* — the
// specular has no highlight to shift, the diffuse looks identical from every
// angle. The markings give the eye something to lock onto and read spin
// direction from, which is the single strongest realism cue for ball motion.
//
// DIVISION OF LABOUR between the three features. They are not redundant —
// each covers a case the others cannot, and the split is driven by how much
// of the texture actually survives at play distance. A 40 mm ball at 3 m is
// ~15-19 px across on a Quest, so the visible hemisphere's 512 source pixels
// compress into ~17 px: roughly 30 source px per rendered px.
//
//   SEAM (inclined great circle) — the only feature that spans the whole
//     ball, so it is readable at any orientation. Deliberately low contrast:
//     it carries close-range realism and continuous spin, not distance
//     legibility.
//   CERT DOT — compact and high contrast, so it survives minification as a
//     coherent blob when finer detail has averaged away. This is the
//     distance spin anchor.
//   SWOOSH — brand mark, close-range character. Placed opposite the dot so
//     that at least one point anchor is on the visible hemisphere.

import * as THREE from 'three';
import { renderer } from './sceneSetup.js';

// Inclination of the seam's great circle away from the UV pole axis.
//
// THIS IS THE WHOLE POINT OF THE SEAM'S SHAPE, so it must not be "simplified"
// back to a horizontal band. A horizontal line in an equirectangular map is a
// LATITUDE circle, and a latitude circle is invariant under rotation about
// the pole axis — meaning a ball with pure sidespin shows literally zero seam
// movement. That is not a subtle degradation: spawnBallAt resets the ball's
// quaternion to identity, so the UV pole is aligned with world up at the
// start of every point, and sidespin serves are exactly when a player most
// needs to read the spin. The old texture had two such bands and therefore
// gave no sidespin cue at all.
//
// An inclined great circle has no such degenerate axis in play: it sweeps
// visibly under sidespin, topspin and everything between. 38° is far enough
// off the pole to make sidespin obvious while keeping the curve clear of the
// UV poles (where equirect stretching would smear it).
const SEAM_INCLINATION = 38 * Math.PI / 180;

export function createBallSeamTexture() {
  // 1024×512 (2× the naive 512×256). At real 40 mm scale the ball only
  // occupies ~15-38 px across in a Quest headset depending on distance —
  // any texture feature under ~30 source pixels averages into the
  // background under trilinear minification. Bumped resolution + bolder
  // strokes keep the markings legible after downsampling.
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // PURE WHITE BASE — do not tint this. The base is a pure multiplier on
  // material.color, so any value below 255 silently darkens every ball
  // colour the game offers. It used to be rgb(215), which cut BALL_COLORS'
  // measured ITTF orange (#ff6600) down to ~#d75600 and made the ball read
  // as burnt orange rather than tournament orange. The measurement in
  // BALL_COLORS is meaningless if this multiplies it away.
  //
  // The old 215 bought highlight headroom against ACES tone mapping at
  // exposure 1.2, which is no longer the pipeline: sceneSetup.js now uses
  // NeutralToneMapping at exposure 1.0, whose entire purpose is a graceful
  // highlight rolloff. Brightness belongs in BALL_COLORS (one obvious lever,
  // per-colour) or in exposure — not hidden inside a texture that every
  // colour variant shares.
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, W, H);

  // --- Seam: great circle inclined SEAM_INCLINATION off the UV equator ----
  // A great circle at inclination i projects to equirect as
  //     φ(λ) = asin( sin(i) · sin λ )
  // i.e. a sine-like curve, not a straight line. Sampling λ across a full
  // turn and stroking the polyline draws it directly. The curve closes on
  // itself at u=0/u=1 (φ=0 at both ends), so wrapS=Repeat joins it cleanly.
  //
  // Contrast is much lower than the old rgb(80)-on-rgb(215) bands. Those
  // spanned ~2.9 mm of a 40 mm ball at a 62% luminance drop and read as a
  // painted beach-ball stripe rather than a mould seam — real seams are
  // sub-millimetre and faint, and modern ITTF 40+ poly balls are usually
  // seamless. Distance legibility is the cert dot's job now, which frees
  // the seam to be as subtle as it should have been.
  ctx.strokeStyle = 'rgb(150, 150, 150)';
  ctx.lineWidth = 9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const STEPS = 512;
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    const phi = Math.asin(Math.sin(SEAM_INCLINATION) * Math.sin(u * Math.PI * 2));
    const y = H * (0.5 - phi / Math.PI);
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(u * W, y);
  }
  ctx.stroke();

  // --- Cert dot: the distance spin anchor ---------------------------------
  // constants.js has claimed since the TABLE_SPIN_GAIN 5→12 change that this
  // dot exists and drops the ball's effective rotational symmetry to 1-fold.
  // It did not exist; the swoosh was carrying that claim alone, at a stroke
  // width that is sub-pixel by 3 m. This is that dot, actually built.
  //
  // Sized from real balls rather than from what looks right in a macro view:
  // printed brand/cert marks span roughly 10 mm on a 40 mm ball, which is
  // 0.5 rad of arc ≈ 80 source px of the 1024 px (360°) longitude axis. That
  // lands at ~4-5 px on the rendered ball at 3 m — comfortably above the
  // minification floor, which is exactly why it, and not the seam, is what
  // reads as "that ball is spinning" from across the table.
  drawSphericalDot(ctx, W, H, 0.75, 0.30, 39, 'rgb(120, 120, 120)');

  // --- Swoosh: brand mark, close range ------------------------------------
  // Generic ITTF-style swoosh. Two arced strokes suggesting motion — abstract
  // enough to sidestep trademarks. Moved to u=0.25 / v=0.68: 180° of
  // longitude from the cert dot, so one of the two point anchors is on the
  // visible hemisphere from any viewing direction, and on the opposite side
  // of the equator from where the seam peaks at this longitude (v≈0.29) so
  // the curve doesn't cut through it.
  ctx.strokeStyle = 'rgb(110, 110, 110)';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  const cx = W * 0.25;
  const cy = H * 0.68;
  ctx.beginPath();
  ctx.moveTo(cx - 64, cy + 36);
  ctx.quadraticCurveTo(cx, cy - 48, cx + 64, cy + 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 44, cy + 60);
  ctx.quadraticCurveTo(cx + 8, cy + 8, cx + 52, cy + 44);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  // CanvasTexture defaults to NoColorSpace in modern three.js; under tone
  // mapping this reads washed-out. SRGB matches how the canvas was authored
  // (browser 2D context is sRGB).
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Spin markings for the Ball.glb baked map.
//
// Ball.glb's authored base-color texture (T_PingPongBallDefault_BC) is a
// near-uniform gray: measured pixel spread is ~169-176 (about 1% contrast of
// UV-island speckle against background), with a single black logo on ONE of
// its two hemisphere islands. models.js carried a comment claiming the GLB
// "bakes an equivalent off-axis marking" to the procedural seam texture above
// — it does not. In play that means a full hemisphere of viewing directions
// shows a featureless sphere, and a featureless sphere's rotation is
// invisible (same failure createBallSeamTexture's header explains). Slice
// and serve spin were being generated by the physics and then simply not
// rendered in any readable way.
//
// This composites spin-legibility markings ON TOP of the GLB's own map at
// load: the asset stays untouched, the baked speckle survives, and each
// hemisphere island gains (a) a bold cert-style dot — the distance anchor,
// same division of labour as the procedural texture — plus (b) a faint arc
// as the close-range continuous cue, plus (c) a small secondary dot so no
// orientation hides every anchor at once.
//
// The GLB's UV layout is two circular hemisphere islands, NOT equirect, so
// createBallSeamTexture's great-circle math does not transfer; marks are
// placed in island-local coordinates instead. Island centers/radii below
// were measured from the decoded PNG (threshold-segmented at the island/
// background luminance step). Placement only needs to land INSIDE each
// island — paint outside an island falls on UV background no fragment ever
// samples.
// Marking colors are ratios of the GLB base (~171 gray), NOT of white — the
// procedural texture's dot was rgb(120) on a 255 base (0.47×) and its seam
// rgb(150) (0.59×); matching those ratios on a 171 base gives ~80 and ~100.
// First pass used rgb(95)/rgb(155) picked against an assumed white base and
// rendered near-invisible (the arc was 0.91× — a tenth of the intended
// contrast).
const GLB_MAP_ISLANDS = [
  // Logo island (the "SportyXR 40mm" print is its own strong anchor, so its
  // added dot is secondary-strength and sits away from the print).
  { cx: 712, cy: 300, dots: [{ dx: -140, dy: -90, r: 22, fill: 'rgb(110,110,110)' }],
    arc: { x0: -200, y0: 120, cx: 0, cy: 190, x1: 200, y1: 140 } },
  // Blank island — gets the full anchor set: bold cert dot + faint arc +
  // small counter-dot.
  { cx: 310, cy: 711, dots: [{ dx: 90, dy: -70, r: 30, fill: 'rgb(80,80,80)' },
                             { dx: -110, dy: 130, r: 16, fill: 'rgb(110,110,110)' }],
    arc: { x0: -210, y0: -60, cx: -20, cy: -150, x1: 190, y1: -40 } },
];
const GLB_MAP_ARC_COLOR = 'rgb(115,115,115)';

/**
 * Return a copy of the ball GLB's base-color texture with spin markings
 * drawn on. Idempotent via userData.spinMarkings so meshes sharing one
 * material (or one texture) composite only once. Preserves flipY (glTF uses
 * top-left UV origin → flipY false), color space, and wrap modes so the
 * swap is invisible apart from the markings.
 */
export function compositeSpinMarkings(srcTex) {
  if (!srcTex || !srcTex.image || srcTex.userData.spinMarkings) return srcTex;
  const img = srcTex.image;
  const W = img.width, H = img.height;
  if (!W || !H) return srcTex;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);

  const s = W / 1024;   // island coordinates were measured on the 1024 map
  for (const isl of GLB_MAP_ISLANDS) {
    // Faint arc — same close-range role (and contrast ratio) as the
    // procedural seam.
    ctx.strokeStyle = GLB_MAP_ARC_COLOR;
    ctx.lineWidth = 9 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo((isl.cx + isl.arc.x0) * s, (isl.cy + isl.arc.y0) * s);
    ctx.quadraticCurveTo(
      (isl.cx + isl.arc.cx) * s, (isl.cy + isl.arc.cy) * s,
      (isl.cx + isl.arc.x1) * s, (isl.cy + isl.arc.y1) * s,
    );
    ctx.stroke();
    for (const d of isl.dots) {
      ctx.fillStyle = d.fill;
      ctx.beginPath();
      ctx.arc((isl.cx + d.dx) * s, (isl.cy + d.dy) * s, d.r * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  // glTF textures use top-left UV origin (flipY false) — CanvasTexture
  // defaults to true, which would mirror every island. Copy the source's
  // sampling state wholesale.
  tex.flipY = srcTex.flipY;
  tex.colorSpace = srcTex.colorSpace;
  tex.wrapS = srcTex.wrapS;
  tex.wrapT = srcTex.wrapT;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.userData.spinMarkings = true;
  return tex;
}

/**
 * Fill a disc that is CIRCULAR ON THE SPHERE at UV (u, v).
 *
 * Equirectangular mapping compresses longitude by cos(latitude), so a round
 * ellipse in UV space renders as a longitudinally-squashed lens on the ball —
 * more so the further the mark sits from the equator. Pre-stretching the
 * horizontal radius by 1/cos(φ) cancels that exactly, which matters here
 * because a cert mark that reads as an oval is instantly recognisable as a
 * texturing error rather than as printing.
 *
 * `radiusPx` is the vertical (latitude-direction) radius in source pixels,
 * which is the undistorted one.
 */
function drawSphericalDot(ctx, W, H, u, v, radiusPx, fill) {
  const phi = (0.5 - v) * Math.PI;              // latitude, radians
  const stretch = 1 / Math.max(0.2, Math.cos(phi));   // clamped near the poles
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(u * W, v * H, radiusPx * stretch, radiusPx, 0, 0, Math.PI * 2);
  ctx.fill();
}
