// Renders a live scoreboard onto the stadium GLB's built-in screen meshes
// (TV, Screen, Billboard) so the venue's own displays show the current
// match state instead of a floating panel in world space. Complements
// scoreboard.js — this module owns the *venue* screens, scoreboard.js still
// owns the floating fallback for arenas that don't have them.
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

const CANVAS_W = 1024;
const CANVAS_H = 512;

export function createStadiumScoreboard({ screenMeshes = [], config = {} } = {}) {
  if (!screenMeshes || screenMeshes.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
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
  for (const mesh of screenMeshes) {
    if (!mesh || !mesh.isMesh) continue;
    originalMaterials.set(mesh, mesh.material);
    // Fresh Basic material so the screen is self-illuminating. Color is
    // pure white — the CanvasTexture provides all the visible content
    // including the dark slab background.
    mesh.material = new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false, // preserve canvas luminance — LED screens don't tonemap
      side: THREE.FrontSide,
    });
  }

  const state = {
    playerScore: 0,
    aiScore: 0,
    playerGames: 0,
    aiGames: 0,
    currentServer: 'ai',
    matchOverBanner: null,
    bestOf: config.bestOf ?? 5,
  };

  function render() {
    const w = CANVAS_W, h = CANVAS_H;
    ctx.clearRect(0, 0, w, h);

    // Deep-blue broadcast slab — ITTF LED scoreboards use a saturated blue
    // background so white text pops without glare.
    ctx.fillStyle = '#0a1a3a';
    ctx.fillRect(0, 0, w, h);

    // Top strip: "TABLE TENNIS" header — venue-broadcast look.
    ctx.fillStyle = '#ff9c1a';
    ctx.fillRect(0, 0, w, 60);
    ctx.fillStyle = '#0a1a3a';
    ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TABLE TENNIS  ·  LIVE', w * 0.5, 30);

    // Side labels.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.fillStyle = '#8ea6ff';
    ctx.fillText('PLAYER', w * 0.25, 130);
    ctx.fillStyle = '#ff9c6b';
    ctx.fillText('AI', w * 0.75, 130);

    // Server dot — lit on the serving side, dim on the other.
    const dotY = 185;
    ctx.fillStyle = state.currentServer === 'player' ? '#8ea6ff' : 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(w * 0.25, dotY, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = state.currentServer === 'ai' ? '#ff9c6b' : 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(w * 0.75, dotY, 14, 0, Math.PI * 2); ctx.fill();

    // Big current-game points + center divider.
    ctx.font = 'bold 200px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(state.playerScore), w * 0.25, 340);
    ctx.fillText(String(state.aiScore),     w * 0.75, 340);
    ctx.font = 'bold 140px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fillText('·', w * 0.5, 330);

    // Games / best-of footer.
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.fillText(
      `SETS  ${state.playerGames} – ${state.aiGames}   ·   BEST OF ${state.bestOf}`,
      w * 0.5, h - 40,
    );

    // Match-over overlay masks the score area.
    if (state.matchOverBanner) {
      ctx.fillStyle = 'rgba(10, 26, 58, 0.96)';
      ctx.fillRect(0, 230, w, 200);
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(state.matchOverBanner, w * 0.5, 330);
    }

    texture.needsUpdate = true;
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
    texture.dispose();
  }

  return { update, setMatchOverBanner, dispose, screenCount: screenMeshes.length };
}
