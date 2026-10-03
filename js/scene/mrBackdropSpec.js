// Geometry spec + layout math for the passthrough backdrop (mrBackdrop.js).
// Pure data/math — no three.js, no scene imports — so the placement is
// unit-testable headless (tests/mrBackdropSpec.test.js).
//
// WHAT IT IS. In mixed reality the far end of the table looks out onto
// whatever the player's room holds — a bookshelf, pictures, a patterned
// wall. A tester who plays against a decorated wall asked for what Eleven
// Table Tennis offers: a screen behind the opponent's end that covers the
// room. This is that screen: ONE flat wall in the Focus Room's wall finish
// (black, with the wood floor's bounce over its foot) carrying the SportyXR
// mark, stood a fixed distance behind the far edge of the table. No blue
// edge trim: the tester found it looked bad against passthrough.
// It is not a room — the floor, the sides and the ceiling stay passthrough,
// so the player still stands in their own space; only the view past the
// far end is replaced.
//
// WHY A FIXED STANDOFF, NOT THE REAL WALL. Passthrough has no depth, so a
// virtual surface draws over the real room wherever it is: a screen 1.5 m
// behind the far edge paints over a real wall 0.5 m behind it and a real
// wall 5 m behind it alike. What matters is that it clears everything
// virtual that lives beyond the far edge — the floating scoreboard sits
// 0.8 m behind it (scoreboard.js DISTANCE_BEHIND_AI_M).
//
// Coordinate basis (models.js): world y=0 is the floor, the player origin
// is (0,0,0) facing -Z, the table's far (AI) edge sits at ~z=-3.04.

import { ROOM, WALL_MARK } from './focusRoomSpec.js';

export const BACKDROP = {
  // As wide as the Focus Room, and for the same reason: at ~4.5 m from the
  // player 8 m spans ±42° — the whole of the view past the far end at any
  // natural head pose. A narrower screen shows its own edges, and a screen
  // with visible edges reads as a billboard in the room rather than as the
  // room's far wall.
  WIDTH_X: ROOM.WIDTH_X,
  // Lower than the Focus Room's 4.5 m: the screen stands in a real room, and
  // from a standing eye height 3.6 m reaches 24° above the horizon at the
  // standoff — past every picture, shelf and window a wall carries, while a
  // 4.5 m screen would cut visibly through a domestic ceiling.
  HEIGHT_Y: 3.6,
  // Behind the far table edge. Keeps the floating scoreboard (0.8 m behind
  // the same edge) in front of the screen with room to spare, and puts the
  // screen ~4.5 m from the player's eyes, three times the occlusion range.
  STANDOFF_Z: 1.5,
  // Decal clearance off the wall face — same reasoning as WALL_MARK.OFFSET.
  DECAL_OFFSET: WALL_MARK.OFFSET,
  // The mark sits above the floating scoreboard, whose 1.40 × 0.79 m panel
  // is centred 1.0 m above the table surface (top edge ≈ 2.16 m). At the
  // height ceiling the mark spans 2.30 – 3.20 m, clearing the board by 14 cm
  // and the top of the screen by 40 cm.
  MARK_Y: 2.75,
  MARK_MAX_HEIGHT_M: 0.9,
};

export function computeMRBackdropLayout(tableBox) {
  if (!tableBox) return null;
  const centerX = (tableBox.min.x + tableBox.max.x) / 2;
  // tableBox.min.z is the far (AI) edge: the player looks toward -Z.
  const wallZ = tableBox.min.z - BACKDROP.STANDOFF_Z;
  return {
    centerX,
    wallZ,
    // Where decals (stripe, trim, mark) sit: just in front of the wall face.
    faceZ: wallZ + BACKDROP.DECAL_OFFSET,
    width: BACKDROP.WIDTH_X,
    height: BACKDROP.HEIGHT_Y,
  };
}
