// Renders a live scoreboard onto the stadium GLB's built-in screen meshes
// (TV, Screen, Billboard) so the venue's own displays show the current
// match state instead of a floating panel in world space. Complements
// scoreboard.js — this module owns the *venue* screens, scoreboard.js still
// owns the floating fallback for arenas that don't have them.
//
// The visual layout (SportyXR broadcast style) is shared with scoreboard.js
// via scoreboardLayout.js so the venue screens and the floating panel can
// never drift apart visually.
//
// The stadium is authored with `TV` and `Screen` mesh nodes (see
// public/models/TableTennis_Stadium.glb node list). We share ONE CanvasTexture
// across all of them so the layout only re-renders once per update.
//
// Materials are replaced with MeshBasicMaterial so the screen reads as
// self-illuminating (like a real LED display) regardless of arena lighting.
// Original materials are held onto so dispose() can restore them if the
// arena is torn down without unloading the venue geometry (currently the
// venue is cached and reused across sessions — restoring is a courtesy).

import * as THREE from 'three';
import {
  LAYOUT_W, LAYOUT_H, createScoreboardState, renderScoreboardLayout,
} from './scoreboardLayout.js';

export function createStadiumScoreboard({ screenMeshes = [], config = {} } = {}) {
  if (!screenMeshes || screenMeshes.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = LAYOUT_W;
  canvas.height = LAYOUT_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  // The TV mesh's UVs in the stadium GLB place (0,0) at top-left of the
  // screen face. Canvas Y also grows downward, but three.js flips textures
  // vertically by default for glTF-loaded assets — so leave flipY at its
  // per-mesh default (usually false for GLB) and rely on the natural UV
  // mapping. If a specific screen reads upside-down we can override per-
  // mesh below (`.flipY = true` on that material's map).
  texture.flipY = false;

  // Snapshot the original materials so dispose() can restore them (defensive:
  // venue geometry is currently cached and shared across sessions, so leaving
  // our BasicMaterial in place would leak the scoreboard into non-match VR
  // sessions).
  const originalMaterials = new Map();
  // Every texture that samples the shared canvas (the base + per-mesh fitted
  // clones). render() must bump needsUpdate on ALL of them — clones share the
  // canvas image but each has its own GPU upload state.
  const textures = [texture];
  for (const mesh of screenMeshes) {
    if (!mesh || !mesh.isMesh) continue;
    originalMaterials.set(mesh, mesh.material);
    const map = fittedTextureFor(mesh, texture, textures);
    // Fresh Basic material so the screen is self-illuminating. Color is
    // pure white — the CanvasTexture provides all the visible content
    // including the dark slab background.
    mesh.material = new THREE.MeshBasicMaterial({
      map,
      toneMapped: false, // preserve canvas luminance — LED screens don't tonemap
      side: THREE.FrontSide,
    });
  }

  const state = createScoreboardState(config);

  function render() {
    renderScoreboardLayout(ctx, state);
    for (const t of textures) t.needsUpdate = true;
  }

  render();

  function update(patch) {
    if (patch) Object.assign(state, patch);
    render();
  }

  function setMatchOverBanner(text) {
    state.matchOverBanner = text;
    render();
  }

  function dispose() {
    // Restore each mesh's original material so a subsequent arena mount
    // (cached geometry, shared across sessions) doesn't inherit our
    // Basic-material paintjob. Dispose the created Basic materials + the
    // CanvasTexture; leave the originals alone (they're owned by the GLB).
    for (const [mesh, orig] of originalMaterials.entries()) {
      const ours = mesh.material;
      mesh.material = orig;
      if (ours && ours.dispose) ours.dispose();
    }
    originalMaterials.clear();
    for (const t of textures) t.dispose();
    textures.length = 0;
  }

  return { update, setMatchOverBanner, dispose, screenCount: screenMeshes.length };
}

// --- Screen-fit mapping ------------------------------------------------------
//
// The stadium's TV/Screen faces are 16:9-ish (Screen quad: 1.359×0.770 m) but
// not guaranteed to match the canvas exactly, and their UVs may only cover a
// sub-rect of 0..1. Give each such mesh its own clone of the base texture with
// offset/repeat set so the canvas maps onto the mesh's ACTUAL uv rect with the
// canvas aspect preserved ("contain": full layout visible, any leftover face
// area clamps to the canvas's dark edge pixels and reads as bezel).
//
// The Billboard is a curved ring segment, not a flat screen — a bounding-box
// aspect is meaningless there, so it keeps the plain full-UV mapping it always
// had. Fit is applied only to meshes named TV/Screen (the flat displays).
function fittedTextureFor(mesh, baseTexture, textures) {
  const name = mesh.name || '';
  const isFlatScreen = name.startsWith('TV') || name.startsWith('Screen');
  if (!isFlatScreen) return baseTexture;

  const geom = mesh.geometry;
  const uvAttr = geom && geom.attributes && geom.attributes.uv;
  if (!uvAttr) return baseTexture;

  // Used-UV rect of this mesh.
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < uvAttr.count; i++) {
    const u = uvAttr.getX(i), v = uvAttr.getY(i);
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const su = u1 - u0, sv = v1 - v0;
  if (!(su > 1e-4) || !(sv > 1e-4)) return baseTexture;

  // Physical face aspect from the two largest bounding-box dimensions (the
  // smallest is the screen's depth). Node scale on these meshes is identity /
  // uniform, so local dims are fine for a ratio.
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z]
    .sort((a, b) => b - a);
  const meshAspect = dims[1] > 1e-4 ? dims[0] / dims[1] : 1;
  const canvasAspect = LAYOUT_W / LAYOUT_H;

  // Contain: fraction of the face the canvas occupies along each axis.
  let fx = 1, fy = 1;
  if (meshAspect > canvasAspect) fx = canvasAspect / meshAspect;
  else fy = meshAspect / canvasAspect;

  // Map uv → texture coords so [u0..u1] covers the centered fx fraction:
  // tex = ((uv - uvMin)/span - (1-f)/2) / f, folded into repeat/offset form.
  const tex = baseTexture.clone();
  tex.repeat.set(1 / (su * fx), 1 / (sv * fy));
  tex.offset.set(
    -u0 / (su * fx) - (1 - fx) / (2 * fx),
    -v0 / (sv * fy) - (1 - fy) / (2 * fy),
  );
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  textures.push(tex);
  return tex;
}
