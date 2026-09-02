// Geometry spec + layout math for the procedural Focus Room (focusRoom.js).
// Pure data/math — no three.js, no scene imports — so the scoreboard-anchor
// and clearance math is unit-testable headless (tests/focusRoomSpec.test.js).
//
// Coordinate basis (models.js): world y=0 is the physical floor
// (local-floor reference space), player origin at (0,0,0) facing -Z. The
// table's near edge sits at z=-0.30 and its far (AI) edge at ~z=-3.04, so
// the room is centered on the TABLE center, not the player — the long end
// goes to the AI side (where the scoreboard wall lives) and the player
// still keeps ~4.3 m of room behind them.

export const ROOM = {
  WIDTH_X: 8.0,
  LENGTH_Z: 12.0,
  HEIGHT_Y: 4.5,
  // Dark matte charcoal. ITTF venues keep the surround behind the players
  // dark and non-reflective so a white ball never loses its silhouette —
  // the whole point of this venue.
  WALL_COLOR: 0x14161c,
  WALL_ROUGHNESS: 0.95,
  CEILING_COLOR: 0x1e2128,
  // Neutral slate grey. The floor must avoid every gameplay hue: the table's
  // navy AND club green (wrist-menu options — the surface silhouette vanishes
  // into a matching floor), the paddle's red rubber (a Taraflex red was tried
  // and cut for that clash), and the orange/white ball colors. Grey conflicts
  // with none of them, and sits clearly lighter than the charcoal walls so
  // floor and wall still separate at the skirting line.
  FLOOR_COLOR: 0x454b55,
  FLOOR_ROUGHNESS: 0.85,
  // Lighter navy accent — wall stripe + court border band.
  ACCENT_COLOR: 0x2c4f8a,
  ACCENT_STRIPE_Y: 1.0,
  ACCENT_STRIPE_H: 0.10,
};

// Court rectangle the surround barriers ring. HALF_X keeps ~2 m clear of
// the table sides (table half-width ~0.76 m); HALF_Z ~2 m behind each
// baseline (table half-length ~1.37 m).
export const COURT = {
  HALF_X: 2.75,
  HALF_Z: 3.6,
  BORDER_W: 0.30,
};

// Tournament surround barriers: real ones are ~73 cm tall, ~1.4 m wide
// free-standing segments.
export const BARRIER = {
  HEIGHT: 0.73,
  SEG_W: 1.4,
  GAP: 0.06,
  THICK: 0.04,
  COLOR: 0x10233f,
  STRIPE_COLOR: 0xdfe6f2,
  STRIPE_H: 0.08,
  // The stripe is a CAP that wraps the panel top with real clearance on
  // every axis — no face of it may be coplanar with (or millimeters from) a
  // panel face, or the two z-fight into a glittery shimmer at distance.
  STRIPE_LIP: 0.006,   // stripe top face sits this far ABOVE the panel top
  STRIPE_WRAP: 0.02,   // stripe overhang past the panel's front/back faces
  STRIPE_END: 0.012,   // stripe overhang past the panel's end faces
};

// Venue branding: the SportyXR mark printed on the court-facing face of
// every barrier panel, where a real tournament prints its title sponsor.
// The mark's own aspect ratio is NOT a constant here — brandLogo.js
// measures it off the trimmed asset at load — so only the width and a
// height ceiling are specified, and the builder derives the other.
export const BARRIER_LOGO = {
  // Leaves ~25 cm of bare panel either side of a 1.4 m segment, so the
  // print reads as centered art on a panel rather than as the panel.
  WIDTH: 0.90,
  // Ceiling for a taller-than-expected replacement asset: a mark this tall
  // still clears the 0.73 m panel top and the floor by ~14 cm. When it
  // binds, the builder scales WIDTH down with it rather than squashing.
  MAX_HEIGHT: 0.44,
  // Clearance in front of the panel face. Same reasoning as STRIPE_LIP
  // above: a decal flush with the surface it decorates z-fights into a
  // shimmer at distance, and the barrier line is seen edge-on from the
  // serve position where that is worst.
  OFFSET: 0.006,
};

// Emissive ceiling light panels — visual luminaires only (unlit material,
// zero lighting cost; the actual light comes from sceneSetup's layer-3 rig).
// DROP = gap between the panel's top face and the interior ceiling face so
// they can never z-fight the ceiling plane.
export const LIGHT_PANELS = {
  W: 2.4,
  D: 1.1,
  THICK: 0.04,
  DROP: 0.03,
  COLOR: 0xf4f7ff,
  RING_X: 2.0,
  RING_DZ: 3.2,
};

// Segment center offsets for a barrier row of the given clear length,
// centered on 0: as many SEG_W segments as fit with GAP between them.
function barrierRowOffsets(length) {
  const pitch = BARRIER.SEG_W + BARRIER.GAP;
  const n = Math.max(1, Math.floor((length + BARRIER.GAP) / pitch));
  const total = n * BARRIER.SEG_W + (n - 1) * BARRIER.GAP;
  const offsets = [];
  for (let i = 0; i < n; i++) {
    offsets.push(-total / 2 + BARRIER.SEG_W / 2 + i * pitch);
  }
  return offsets;
}

export function computeFocusRoomLayout(tableBox) {
  if (!tableBox) return null;

  const center = {
    x: (tableBox.min.x + tableBox.max.x) / 2,
    z: (tableBox.min.z + tableBox.max.z) / 2,
  };
  const backWallInnerZ = center.z - ROOM.LENGTH_Z / 2;
  const frontWallInnerZ = center.z + ROOM.LENGTH_Z / 2;

  // Same formula and shape as arena.js getBackWallAnchor() for the tt
  // variant — 2.2 m up (broadcast-banner height) or 70% of the wall,
  // whichever is lower; 2 cm off the wall face against z-fighting — so
  // createScoreboard({ anchor }) wall-mounts with zero changes.
  const backWallAnchor = {
    x: center.x,
    y: Math.min(2.2, ROOM.HEIGHT_Y * 0.7),
    z: backWallInnerZ + 0.02,
    wallWidth: ROOM.WIDTH_X,
    wallHeight: ROOM.HEIGHT_Y,
  };

  // Barrier ring around the court rectangle. Side rows run along Z
  // (rotY 90°), end rows along X.
  //
  // Each segment also emits the transform for its branding decal, in a
  // parallel array with matching indices. `inwardRotY` is the rotation
  // that turns a plane's +Z normal to face the court — NOT the panel's own
  // rotY, which is ambiguous about which of the two faces is the front:
  // the two side rows share rotY 90° but face opposite directions. A
  // rotation of θ about Y sends +Z to (sinθ, 0, cosθ), which is also what
  // pushes the decal off the panel face along its own normal.
  const barrierSegments = [];
  const barrierLogos = [];
  const decalGap = BARRIER.THICK / 2 + BARRIER_LOGO.OFFSET;
  function pushSegment(x, z, rotY, inwardRotY) {
    barrierSegments.push({ x, z, rotY });
    barrierLogos.push({
      x: x + Math.sin(inwardRotY) * decalGap,
      y: BARRIER.HEIGHT / 2,
      z: z + Math.cos(inwardRotY) * decalGap,
      rotY: inwardRotY,
    });
  }
  for (const off of barrierRowOffsets(COURT.HALF_Z * 2)) {
    pushSegment(center.x - COURT.HALF_X, center.z + off, Math.PI / 2, Math.PI / 2);
    pushSegment(center.x + COURT.HALF_X, center.z + off, Math.PI / 2, -Math.PI / 2);
  }
  for (const off of barrierRowOffsets(COURT.HALF_X * 2)) {
    pushSegment(center.x + off, center.z - COURT.HALF_Z, 0, 0);
    pushSegment(center.x + off, center.z + COURT.HALF_Z, 0, Math.PI);
  }

  // Center of each panel box; top face lands DROP below the interior
  // ceiling face (which itself sits 1 cm below the shell top).
  const panelY = ROOM.HEIGHT_Y - 0.01 - LIGHT_PANELS.DROP - LIGHT_PANELS.THICK / 2;
  const panelSlots = [{ x: center.x, z: center.z, isCenter: true }];
  for (const dz of [-LIGHT_PANELS.RING_DZ, 0, LIGHT_PANELS.RING_DZ]) {
    panelSlots.push({ x: center.x - LIGHT_PANELS.RING_X, z: center.z + dz, isCenter: false });
    panelSlots.push({ x: center.x + LIGHT_PANELS.RING_X, z: center.z + dz, isCenter: false });
  }

  return {
    center,
    backWallInnerZ,
    frontWallInnerZ,
    backWallAnchor,
    barrierSegments,
    barrierLogos,
    panelY,
    panelSlots,
  };
}
