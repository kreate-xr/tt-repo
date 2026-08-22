// Unit tests for the contact-time ITTF fault geometry.
//
// These are the two rules that can't be judged from where the ball lands:
// obstruction (hitting before the ball bounced on your half) and the service
// position rule (struck from behind the end line, above the surface).

const THREE = require('three');

import {
  checkServeContact,
  classifyPreBounceContact,
  SERVE_BEHIND_LINE_GRACE_M,
} from '../js/modes/aiMatch/ittfFaults.js';

// Regulation-ish table matching the rallyManager test mock. Player owns +Z.
const tableBox = new THREE.Box3(
  new THREE.Vector3(-0.7625, -0.01, -1.37),
  new THREE.Vector3(0.7625, 0.01, 1.37),
);
const tableSurfaceY = 0;
const PLAYER_END_Z = 1.37;

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// --- Service position (Law 2.6) --------------------------------------------

describe('checkServeContact', () => {
  test('struck behind the end line and above the surface is legal', () => {
    expect(checkServeContact({
      contactPos: v(0, 0.35, PLAYER_END_Z + 0.10), tableBox, tableSurfaceY, isNear: true,
    })).toBeNull();
  });

  test('struck out over the playing surface is a fault', () => {
    expect(checkServeContact({
      contactPos: v(0, 0.35, 0.9), tableBox, tableSurfaceY, isNear: true,
    })).toBe('overTable');
  });

  test('a contact just inside the line stays legal — the grace absorbs toss drift', () => {
    // The courtesy toss legitimately drifts a few cm inward during flight;
    // punishing that would fault the game's own serve. See playerServe.js.
    const justInside = PLAYER_END_Z - (SERVE_BEHIND_LINE_GRACE_M - 0.02);
    expect(checkServeContact({
      contactPos: v(0, 0.35, justInside), tableBox, tableSurfaceY, isNear: true,
    })).toBeNull();
    // …but a genuine reach over the table is nowhere near the grace band.
    expect(checkServeContact({
      contactPos: v(0, 0.35, PLAYER_END_Z - 0.40), tableBox, tableSurfaceY, isNear: true,
    })).toBe('overTable');
  });

  test('struck below table level is a fault', () => {
    expect(checkServeContact({
      contactPos: v(0, -0.20, PLAYER_END_Z + 0.10), tableBox, tableSurfaceY, isNear: true,
    })).toBe('belowTable');
  });

  test('the far side is mirrored, not hardcoded to +Z', () => {
    expect(checkServeContact({
      contactPos: v(0, 0.35, -1.50), tableBox, tableSurfaceY, isNear: false,
    })).toBeNull();
    expect(checkServeContact({
      contactPos: v(0, 0.35, -0.9), tableBox, tableSurfaceY, isNear: false,
    })).toBe('overTable');
  });

  test('missing geometry judges nothing rather than guessing', () => {
    expect(checkServeContact({ contactPos: null, tableBox })).toBeNull();
    expect(checkServeContact({ contactPos: v(0, 0.3, 2), tableBox: null })).toBeNull();
  });
});

// --- Obstruction vs. an already-out ball (Law 2.5.7) -----------------------

describe('classifyPreBounceContact', () => {
  test('a ball on its way into the striker court is obstruction', () => {
    // Descending over the player's half, still short of the end line.
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.40, 0.5), inVel: v(0, -1, 2),
      tableBox, tableSurfaceY, isNear: true,
    })).toBe('volley');
  });

  test('a ball that would have sailed long is out, not obstruction', () => {
    // Same contact point, three times the forward speed — it clears the end
    // line before it can come down. Swatting that away is the striker's
    // right; the point was already theirs.
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.40, 0.5), inVel: v(0, -1, 6),
      tableBox, tableSurfaceY, isNear: true,
    })).toBe('out');
  });

  test('a ball heading wide of the side line is out', () => {
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.40, 0.5), inVel: v(6, -1, 2),
      tableBox, tableSurfaceY, isNear: true,
    })).toBe('out');
  });

  test('a rising ball is still judged on where it eventually lands', () => {
    // Struck on the way up: the descending root is the one that matters, so
    // a lofted ball that comes down on the court is still obstruction.
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.25, 0.4), inVel: v(0, 2.5, 1.2),
      tableBox, tableSurfaceY, isNear: true,
    })).toBe('volley');
  });

  test('the far side is mirrored', () => {
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.40, -0.5), inVel: v(0, -1, -2),
      tableBox, tableSurfaceY, isNear: false,
    })).toBe('volley');
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.40, -0.5), inVel: v(0, -1, -6),
      tableBox, tableSurfaceY, isNear: false,
    })).toBe('out');
  });

  test('without a velocity it falls back to the end line', () => {
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.4, 0.5), inVel: null, tableBox, tableSurfaceY, isNear: true,
    })).toBe('volley');
    expect(classifyPreBounceContact({
      contactPos: v(0, 0.4, PLAYER_END_Z + 0.3), inVel: null,
      tableBox, tableSurfaceY, isNear: true,
    })).toBe('out');
  });

  test('missing geometry judges nothing', () => {
    expect(classifyPreBounceContact({ contactPos: null, tableBox })).toBeNull();
  });
});
