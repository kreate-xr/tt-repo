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

// The venue blue. ONE constant because the court border, the wall stripe,
// the skirting rail, the corner posts and the cornice are deliberately the
// same colour — that is what makes them read as a single edge language
// wrapping the room rather than as five unrelated details. Renders
// rgb(70,122,205) on a wall and rgb(76,131,217) on the floor.
const ACCENT_BLUE = 0x3b5a90;

export const ROOM = {
  WIDTH_X: 8.0,
  LENGTH_Z: 12.0,
  HEIGHT_Y: 4.5,
  // EVERY color below is an ALBEDO, not the value you see on screen. The
  // room is lit by a single HemisphereLight at 2.2 (sceneSetup.js hemiLight)
  // and then Neutral-tone-mapped, which together divide albedo by ~3.5 on a
  // horizontal wall — and the tonemapper's black-point term
  // (`x - 6.25*x*x` for min channel x < 0.08) subtracts almost the entire
  // signal below that threshold. So an albedo has to be read together with
  // ROOM.SELF_LIT; the screen values are tabulated in focusRoom.js.
  //
  // The side walls are BLACK on purpose: they are the backdrop the
  // sideWallArt.js player graphic is printed on, and a black ground is what
  // makes that graphic read. This is a deliberate reversal of the earlier
  // brightening pass for the walls ONLY — the floor and court keep theirs. Consequence to know about: pure black plus the tonemapper's
  // black-point crush renders the wall as exactly rgb(0,0,0), a true void.
  // wallPanels.js paints the floor bounce back over the bottom of it so the
  // wood does not appear to end in midair; WALL_PANEL.BOUNCE_ALPHA is the
  // one constant to set to 0 if you want the walls absolutely black.
  WALL_COLOR: 0x000000,
  WALL_ROUGHNESS: 0.95,
  // Deep cool slate. Dark on purpose, and a deliberate reversal of the
  // milky-off-white (0xaeaca8) pass that preceded it.
  //
  // BALL VISIBILITY is the reason. The ceiling is the one surface a lofted
  // ball is seen against, and a white ball over a white ceiling is exactly
  // the problem the dark surround exists to prevent — real ITTF halls go
  // dark above the court for that reason.
  //
  // It is also what the room's value structure wants. Renders rgb(73,79,95),
  // luma 79: clearly a surface rather than the void the pre-SELF_LIT room
  // was, but a full stop below the wood floor (luma 135), so the brightest
  // thing overhead is a lamp and not the whole plane. White up there made the
  // ceiling the brightest surface in the venue and pulled the eye off the
  // table.
  //
  // DO NOT eyeball this albedo darker without recomputing. A down-facing
  // surface gets only the hemisphere's ground term, so nearly all of its
  // value comes from SELF_LIT, and the tonemapper's black-point term
  // (`x - 6.25*x*x` below 0.08) then eats what little is left: 0x1e2128 —
  // which LOOKS like a neighbouring slate — renders rgb(14,23,40), luma 22,
  // straight back to the black void. The usable ceiling range is narrow and
  // the response is steep at this end.
  //
  // And it gives the luminaires something to be bright against: LIGHT_PANELS
  // are unlit meshes at rgb(229,232,240), which over a white ceiling render
  // DARKER than the surface they sit on and vanish — unfixable by
  // brightening, since the tonemapper caps any surface at ~251.
  //
  // Faintly blue (r65 g68 b78) so it sits with the venue-blue trim.
  CEILING_COLOR: 0x41444e,
  // Neutral slate grey. The floor must avoid every gameplay hue: the table's
  // navy AND club green (wrist-menu options — the surface silhouette vanishes
  // into a matching floor), the paddle's red rubber (a Taraflex red was tried
  // and cut for that clash), and the orange/white ball colors. Grey conflicts
  // with none of them, and sits clearly lighter than the charcoal walls so
  // floor and wall still separate at the skirting line.
  // Renders rgb(135,143,156). The floor faces UP, so it is the one surface
  // that collects the hemisphere's full sky term.
  FLOOR_COLOR: 0x5d6269,
  FLOOR_ROUGHNESS: 0.85,
  // Lighter navy accent — wall stripe + court border band. Renders
  // rgb(76,131,217) on the floor band and rgb(70,122,205) on the wall
  // stripe (the wall normal is horizontal, so it collects less sky).
  ACCENT_COLOR: ACCENT_BLUE,
  ACCENT_STRIPE_Y: 1.0,
  ACCENT_STRIPE_H: 0.10,
  // EDGE TRIM — the four vertical corners and the cornice where each wall
  // meets the ceiling, plus the skirting rail painted by wallPanels.js.
  //
  // On a black wall these are the ONLY thing giving the room a shape. A flat
  // surface under one hemisphere light renders as a single value, and that
  // value is now 0, so nothing distinguishes one wall from the next, or a
  // wall from the ceiling, or tells you how far away the far wall is — the
  // venue reads as one undifferentiated black rectangle. Trim is what turns
  // it back into a box you can see the edges of. In the venue blue, matching
  // the court border and the wall stripe: renders rgb(70,122,205), luma 117
  // against a luma-0 black wall and a luma-79 slate ceiling, so the line
  // reads against both surfaces it separates. It is also the only thing
  // separating them now that BOTH are dark — the cornice carries more weight
  // against a slate ceiling than it did against the milky-white one, so if
  // the wall/ceiling join ever goes soft, CORNICE_H is the knob, not
  // CEILING_COLOR. (The cornice's underside faces down and so collects less
  // of the hemisphere — rgb(62,114,191) — which is the ~10% falloff you
  // would expect on a soffit anyway.)
  //
  // Widths are architectural rather than hairline on purpose: a 2 cm strip
  // 6 m away is a couple of pixels in a headset and shimmers instead of
  // reading as an edge.
  TRIM_COLOR: ACCENT_BLUE,
  TRIM_W: 0.06,
  CORNICE_H: 0.08,
  // Self-lit term for every room surface: each material sets
  // `emissive` to its OWN color with this as emissiveIntensity, so a
  // surface's outgoing radiance is albedo * (hemisphereIrradiance/PI +
  // SELF_LIT). That is algebraically an AmbientLight of intensity
  // SELF_LIT*PI scoped to this room and nothing else — which is what the
  // deleted `arenaAmbient` was trying to be. Emissive costs no per-fragment
  // light loop and, unlike a THREE.Light, genuinely cannot reach the ball,
  // paddle or table: three.js has NO per-mesh light masking (a light's
  // layers are tested against the CAMERA, never against a mesh), so a
  // real light here would necessarily also hit gameplay.
  //
  // THIS IS THE ROOM'S BRIGHTNESS KNOB. Scaling it scales every surface
  // together and preserves the palette's relative values. Raising it does
  // not touch gameplay lighting.
  SELF_LIT: 2.0,
};

// Wall finish. wallPanels.js paints it; this is the data half.
//
// The wall itself is black (ROOM.WALL_COLOR), so there is no panelling left
// to draw — an earlier version put acoustic-panel joints here, and on a black
// ground those inverted into pale glowing lines, because anything drawn over
// black can only lift it. What remains is the one thing that still belongs on
// a black wall:
//
// FLOOR BOUNCE. A warm gradient over the bottom BOUNCE_H_M, tinted toward the
// wood. In a real hall the floor throws light back up the wall; without it the
// wood floor visibly ends in midair at the skirting. Nothing in the rig can
// produce this — one hemisphere light gives a flat surface exactly one value
// everywhere (sceneSetup.js LIGHTING LAYERS) — so it is painted.
//
// The texture is horizontally UNIFORM, which is why PX_W is 8 rather than
// hundreds: it carries a vertical gradient and nothing else. That also means
// no per-face UV rescale is needed on the shell — every wall samples the same
// column regardless of its length. Restoring anything with horizontal
// structure would need both back.
export const WALL_PANEL = {
  PX_W: 8,
  PX_H: 1024,
  // Warm light thrown back up the wall by the wood floor.
  BOUNCE_COLOR: 0x48433c,
  BOUNCE_H_M: 1.5,
  // Set to 0 for absolutely black walls, at the cost of the floor/wall join.
  BOUNCE_ALPHA: 0.85,
  // Base rail where wall meets floor, in the venue blue like the rest of the
  // trim so the floor line, the corner posts and the cornice are one edge
  // language. It was a DARKER rail when the wall was charcoal; on a black
  // wall a darker rail is invisible, since anything painted over black can
  // only lift it.
  SKIRT_COLOR: ACCENT_BLUE,
  SKIRT_H_M: 0.07,
  ANISOTROPY: 4,
};

// The venue graphics printed on the two side walls: the player poster on the
// LEFT (-X) and the FOCUS / PRACTICE / IMPROVE / REPEAT motivation piece on
// the RIGHT (+X). Right is +X because the player stands at the origin facing
// -Z, so forward x up puts their right hand toward +X.
//
// Both are WebP, converted from the masters kept in art/ (which are NOT under
// public/ — anything there ships verbatim, and the PNGs are 8-20x the size):
//   left_side_wall.png  2363 KB -> 255 KB      rightside_ext.png 1296 KB -> 121 KB
// Re-encode from art/, never from the shipped WebP: recompressing an already
// lossy file stacks artifacts.
//
// BOTH ARE FEATHERED — alpha falls to 0 at their edges. That is why they are
// composited with straight alpha blending and NO alphaTest: a cutout threshold
// would slice the glow into a hard-edged rectangle, which is the panel edge
// the feathering exists to avoid. On a black wall they read as light spilling
// onto it rather than as posters hung on it.
//
// SIZE. WIDTH_M is the real knob. At 4.5 m these filled two thirds of a 4.5 m
// wall and read as wallpaper; 3.0 m x 2.0 m leaves clear wall around them. The source is re-encoded to
// suit: 1024 px across 3 m is 2.9 mm per texel, which is finer than it can be
// resolved from across the room. If WIDTH_M grows much past this, re-encode
// from the master at a higher resolution rather than letting it soften.
//
// TONE is a brightness scale, not a tint: outgoing = TONE * texel * ~2.29, so
// untoned art blows out. At 0xaeaeae the whites land at 238 and the midtones
// at 128 — a lit print, not a light source.
//
// WORTH KNOWING: these are bright and high-contrast, and sit in the player's
// peripheral vision during a rally, which is the one thing the dark surround
// exists to protect. They are off the play axis, but if ball tracking ever
// feels off, dim TONE first and shrink WIDTH_M second.
export const SIDE_WALL_ART = {
  TONE: 0xaeaeae,
  // Clearance off the wall face. Same decal-stack reasoning as WALL_MARK:
  // a print flush with its surface z-fights into a shimmer at distance.
  OFFSET: 0.02,
  // Height is derived from each asset's MEASURED aspect at load, never
  // assumed here — swapping in art of a different shape must not stretch it.
  //
  // CENTER_Y is derived from the room height rather than typed, so the art
  // stays centred on the wall if the room is ever resized. At a literal 2.0 it
  // left 1.0 m of wall below and 1.5 m above, which read as sitting toward the
  // floor; ROOM.HEIGHT_Y / 2 gives equal margins.
  WALLS: [
    { side: 'left',  URL: '/left_side_wall.webp', WIDTH_M: 3.0, CENTER_Y: ROOM.HEIGHT_Y / 2 },
    { side: 'right', URL: '/rightside_ext.webp',  WIDTH_M: 3.0, CENTER_Y: ROOM.HEIGHT_Y / 2 },
  ],
};

// Procedural wood sport-hall floor. woodFloor.js paints these onto a
// canvas at runtime; this block is the pure data half, same split as
// WALL_MARK / brandLogo.js.
//
// Every color here is an ALBEDO, exactly like ROOM above — the floor faces
// UP, so it is the one surface collecting the hemisphere's full sky term,
// and albedo * (irradiance/PI + ROOM.SELF_LIT) then goes through Neutral
// tone mapping. What you actually see:
//   boards  rgb(159,135,110) rgb(147,127,101) rgb(166,143,117)
//           rgb(139,121,96)  rgb(154,134,107)   — mean rgb(153,132,106)
//   grain   rgb(112,95,76)     end joints / board edges rgb(87,75,59)
//
// The mean sits at luma 135 against the flat grey floor it replaces (142),
// so the ball keeps the contrast it had. Tone matters as much as
// brightness here: ROOM.FLOOR_COLOR's note warns the floor must not wear a
// gameplay hue, and an ITTF orange ball IS wood-colored. These boards are
// deliberately a desaturated warm grey-oak — saturation 0.31 against the
// orange ball's 0.92 — rather than the honey-brown a hall floor is usually
// drawn as. Do not warm them up without re-checking the ball against them.
export const WOOD = {
  // World metres one texture tile covers. The tile is seamless, so this
  // need not divide the room evenly.
  TILE_M: 4.0,
  // Texture resolution. 1024 over a 4 m tile is ~4 mm per texel, which is
  // what keeps a board edge from turning to mush underfoot. RGBA + mips
  // is ~5.3 MB; drop to 512 if that budget is ever contested.
  PX: 1024,
  // Sport parquet board width. TILE_M / PLANK_W_M is rounded to a whole
  // number of boards so the across-boards seam lands exactly on the tile
  // edge and wraps.
  PLANK_W_M: 0.13,
  // End-joint stagger: board lengths are drawn from this range and then
  // scaled to sum to exactly one tile, so the joints wrap too.
  BOARD_MIN_M: 1.0,
  BOARD_MAX_M: 2.6,
  // Per-board base tones, picked at random per board.
  PLANKS: [0x6c5d4d, 0x655848, 0x716251, 0x605445, 0x695c4b],
  // Extra per-board 0-255 jitter on top of PLANKS, so two neighbours that
  // drew the same tone still differ.
  JITTER: 5,
  GRAIN_COLOR: 0x4f453a,
  GRAIN_PER_BOARD: 9,
  SEAM_COLOR: 0x413a32,
  // Fixed so the floor is identical every session and in both eyes.
  SEED: 0x5eed7a11,
  // Grazing-angle sharpening. A floor is the worst case for it in VR; 4 is
  // the usual quality/bandwidth knee on mobile GPUs.
  ANISOTROPY: 4,
};

// Court rectangle the floor's border band draws. It used to be ringed by
// surround barriers too; those are gone, so this band is now the only thing
// marking the court. HALF_X keeps ~2 m clear of
// the table sides (table half-width ~0.76 m); HALF_Z ~2 m behind each
// baseline (table half-length ~1.37 m).
export const COURT = {
  HALF_X: 2.75,
  HALF_Z: 3.6,
  BORDER_W: 0.30,
};

// The SportyXR mark on the two END walls — back wall behind the AI, front
// wall behind the player.
//
// It was previously printed on every court-surround barrier. With 14 panels
// ringing the court that was one wordmark repeated at 1.4 m intervals, which
// reads as tiling rather than branding, and the barriers have since been
// removed entirely. A venue puts its name on the end walls, so that is where
// it is.
//
// The mark's own aspect is NOT a constant here — brandLogo.js measures it off
// the trimmed asset at load — so only a width and a height ceiling are given
// and the builder derives the other. When the ceiling binds it scales WIDTH
// down with it rather than squashing the wordmark.
export const WALL_MARK = {
  WIDTH_M: 2.6,
  MAX_HEIGHT_M: 1.0,
  // Clearance off the wall face. Same decal-stack reasoning as everything
  // else printed in this room: flush with the surface it decorates, it
  // z-fights into a shimmer at distance.
  OFFSET: 0.02,
  // Front wall carries nothing else, so the mark is centred on it.
  FRONT_Y: 2.25,
  // The back wall is the SCOREBOARD's: it wall-mounts at y 2.2 and, at
  // 2.80 x 1.58 m, spans 1.41 to 2.99 m. The mark therefore sits above it —
  // 3.12 to 4.12 m at the height ceiling, clearing the board by 13 cm and the
  // cornice by 28 cm. Moving the scoreboard means rechecking this.
  BACK_Y: 3.62,
  // The mark is white ink on transparent (brandLogo.js recolors it), so this
  // is a brightness scale that stops it burning out on a black wall: whites
  // land at ~218 rather than clipping.
  TONE: 0x9a9a9a,
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
  // Recess reveal: a frame in the gap between each panel and the ceiling,
  // read from below as the lit inner wall of a recessed troffer.
  //
  // It gives every fixture the three-step falloff a real recessed light has:
  // panel rgb(229,232,240), reveal rgb(125,123,118), ceiling rgb(73,79,95) —
  // lamp, then reflector, then dark ceiling. The ORDER is the thing to keep:
  // the reveal sits strictly BETWEEN the other two, and tests/focusRoom.test.js
  // asserts that per channel.
  //
  // It was deliberately DARKER than the ceiling while the ceiling was milky
  // white, because unlit panels could only read as a shadow gap against a
  // surface brighter than themselves; taking the ceiling back to dark flips
  // this with it. A dark frame on a dark ceiling merges into it and leaves
  // the panels floating with no fixture around them.
  // Renders rgb(125,123,118).
  REVEAL_COLOR: 0x62605d,
  // How far the reveal extends past the panel on each side.
  REVEAL_MARGIN: 0.05,
  REVEAL_THICK: 0.02,
};

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

  // Ceiling light panel positions: one centred over the table plus a ring
  // either side of it. panelY hangs them LIGHT_PANELS.DROP below the ceiling
  // plane so they can never z-fight it.
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
    panelY,
    panelSlots,
  };
}
