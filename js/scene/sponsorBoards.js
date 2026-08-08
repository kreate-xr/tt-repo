// Rotating sponsor content painted onto the stadium's Branding /
// Branding_Board meshes (7 total in TableTennis_Stadium.glb). Cycles
// through a static list every ~10 seconds so the arena feels like a
// live venue rather than a still image.
//
// Design: each board gets its OWN CanvasTexture (not a shared one) so the
// rotation staggers — boards A, B, C, D all showing sponsor X at once looks
// like a screenshot; staggered they read as independent LED panels.
//
// Sponsor content is fictional placeholder branding (no real trademarks —
// the game project doesn't ship real ad deals). Easy to swap for real
// content by editing SPONSORS.

import * as THREE from 'three';

// Fictional sponsor content. Each entry is { title, subtitle, bg, fg }.
// bg is the board background color; fg is the text color. Kept vivid so
// they read from across the arena.
const SPONSORS = [
  { title: 'ANTHROPIC',   subtitle: 'AI FOR HUMANITY',     bg: '#c76e2a', fg: '#ffffff' },
  { title: 'CLAUDE CODE', subtitle: 'BUILT WITH AI',        bg: '#1a1a2e', fg: '#ffd24a' },
  { title: 'RALLY PRO',   subtitle: 'OFFICIAL PADDLE',      bg: '#0e5c3a', fg: '#ffffff' },
  { title: 'ARC SPORTS',  subtitle: 'PLAY AT YOUR PEAK',    bg: '#3a1a5c', fg: '#8ea6ff' },
  { title: 'TABLE ONE',   subtitle: 'TOURNAMENT GRADE',     bg: '#8a1a1a', fg: '#ffe27a' },
  { title: 'WEBXR',       subtitle: 'THE OPEN METAVERSE',   bg: '#0a3a6b', fg: '#ffffff' },
  { title: 'QUEST',       subtitle: 'MIXED REALITY',        bg: '#1a1a1a', fg: '#f24a4a' },
  { title: 'THREE.JS',    subtitle: 'RENDERED IN WEBGL',    bg: '#049ef4', fg: '#ffffff' },
];

// Board canvas dimensions. 512×256 is enough to read text clearly from
// 5-10m away in VR, and small enough that 7 canvases don't strain GPU
// texture memory (~3.5MB total at RGBA8).
const CANVAS_W = 512;
const CANVAS_H = 256;

// Cycle period per board. Boards rotate independently (each starts on a
// different sponsor index so they don't move in lockstep).
const CYCLE_SECONDS = 10;
// Crossfade duration inside each cycle. Draws both old + new sponsor with
// a wipe transition to avoid the "instant snap" that reads as a bug.
const FADE_SECONDS = 1.2;

function drawSponsor(ctx, sponsor) {
  const w = CANVAS_W, h = CANVAS_H;
  ctx.fillStyle = sponsor.bg;
  ctx.fillRect(0, 0, w, h);
  // Diagonal stripe accent — visual anchor so the board doesn't read as
  // just a colored rectangle.
  ctx.fillStyle = sponsor.fg;
  ctx.globalAlpha = 0.15;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(w * 0.35, 0);
  ctx.lineTo(w * 0.42, 0);
  ctx.lineTo(w * 0.07, h);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  // Title.
  ctx.fillStyle = sponsor.fg;
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sponsor.title, w * 0.5, h * 0.42);
  // Subtitle.
  ctx.font = '28px system-ui, sans-serif';
  ctx.globalAlpha = 0.85;
  ctx.fillText(sponsor.subtitle, w * 0.5, h * 0.68);
  ctx.globalAlpha = 1;
}

export function createSponsorBoards({ boardMeshes = [] } = {}) {
  if (!boardMeshes || boardMeshes.length === 0) return null;

  const boards = [];
  const originalMaterials = new Map();

  for (let i = 0; i < boardMeshes.length; i++) {
    const mesh = boardMeshes[i];
    if (!mesh || !mesh.isMesh) continue;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    texture.flipY = false;

    originalMaterials.set(mesh, mesh.material);
    mesh.material = new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false,
      side: THREE.DoubleSide, // boards may face either way; DoubleSide is cheap for flat quads
    });

    // Stagger start index so boards don't cycle in lockstep.
    const idx = i % SPONSORS.length;
    boards.push({
      mesh,
      canvas,
      ctx,
      texture,
      currentIdx: idx,
      nextIdx: (idx + 1) % SPONSORS.length,
      // Random phase offset ±25% of cycle so boards drift out of sync from
      // the start. Without this, boards created at the same time end up
      // staggered by exactly the same interval, which reads as coordinated.
      t: Math.random() * CYCLE_SECONDS * 0.25,
    });
    // Initial paint.
    drawSponsor(ctx, SPONSORS[idx]);
    texture.needsUpdate = true;
  }

  function update(dt) {
    for (const b of boards) {
      b.t += dt;
      if (b.t >= CYCLE_SECONDS) {
        // Advance: current becomes next, next advances.
        b.currentIdx = b.nextIdx;
        b.nextIdx = (b.nextIdx + 1) % SPONSORS.length;
        b.t = 0;
        drawSponsor(b.ctx, SPONSORS[b.currentIdx]);
        b.texture.needsUpdate = true;
        continue;
      }
      // Crossfade window: last FADE_SECONDS of the cycle.
      const fadeStart = CYCLE_SECONDS - FADE_SECONDS;
      if (b.t >= fadeStart) {
        const k = (b.t - fadeStart) / FADE_SECONDS;
        // Wipe transition: current sponsor stays visible on left, next
        // sponsor wipes in from right. Cheap + reads clearly.
        drawSponsor(b.ctx, SPONSORS[b.currentIdx]);
        const wipeX = CANVAS_W * k;
        b.ctx.save();
        b.ctx.beginPath();
        b.ctx.rect(CANVAS_W - wipeX, 0, wipeX, CANVAS_H);
        b.ctx.clip();
        drawSponsor(b.ctx, SPONSORS[b.nextIdx]);
        b.ctx.restore();
        b.texture.needsUpdate = true;
      }
    }
  }

  function dispose() {
    for (const b of boards) {
      const orig = originalMaterials.get(b.mesh);
      const ours = b.mesh.material;
      if (orig) b.mesh.material = orig;
      if (ours && ours.dispose) ours.dispose();
      b.texture.dispose();
    }
    originalMaterials.clear();
    boards.length = 0;
  }

  return { update, dispose, boardCount: boards.length };
}
