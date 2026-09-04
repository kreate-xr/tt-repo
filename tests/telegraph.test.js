// Unit tests for telegraph + recovery. Covers spec §telegraph_design and
// §recovery_design.

const THREE = require('three');

import {
  SHOT_TYPES,
  FACE_Y_BY_SHOT_TYPE,
  WINDUP_DEPTH_M_BY_POWER,
  TELEGRAPH_LEAD_MS_BY_POWER,
  COMMIT_LOCK_BEFORE_CONTACT_MS,
  telegraphLeadMsForSpeed,
  shotTypeFromTarget,
  powerTierForSpeed,
  faceNormalForShot,
  windupPositionForShot,
  specTargetToWorld,
} from '../js/modes/aiMatch/telegraph.js';
import {
  RECOVERY_MS,
  VULNERABILITY_SPEED_MULTIPLIER,
  isWithinVulnerabilityWindow,
  recoveryDurationMs,
} from '../js/modes/aiMatch/recovery.js';

// --- Shot type enum + face Y -----------------------------------------------

describe('SHOT_TYPES + FACE_Y_BY_SHOT_TYPE', () => {
  test('ten TT shot types exist (6 original + 4 extended)', () => {
    // Original six (rally vocabulary) plus four extended (chop, drop_shot,
    // lob, flip) added to support real TT variety at Intermediate/Pro.
    expect(Object.values(SHOT_TYPES).sort()).toEqual(
      ['block', 'chop', 'drop_shot', 'flip', 'lob', 'loop',
       'push', 'slice', 'smash', 'topspin_drive'].sort(),
    );
  });

  test('face Y values match spec for the original six', () => {
    expect(FACE_Y_BY_SHOT_TYPE.topspin_drive).toBeCloseTo(-0.34, 5);
    expect(FACE_Y_BY_SHOT_TYPE.slice).toBeCloseTo( 0.34, 5);
    expect(FACE_Y_BY_SHOT_TYPE.block).toBeCloseTo(0.0, 5);
    expect(FACE_Y_BY_SHOT_TYPE.loop).toBeCloseTo(-0.17, 5);
    expect(FACE_Y_BY_SHOT_TYPE.push).toBeCloseTo(0.17, 5);
    expect(FACE_Y_BY_SHOT_TYPE.smash).toBeCloseTo(0.0, 5);
  });

  test('face Y values are set for the four extended shots', () => {
    // Exact values aren't spec-frozen — they can be tuned in headset —
    // but each new type must have a defined non-NaN Y so the paddle
    // telegraph doesn't render a broken face.
    expect(Number.isFinite(FACE_Y_BY_SHOT_TYPE.chop)).toBe(true);
    expect(Number.isFinite(FACE_Y_BY_SHOT_TYPE.drop_shot)).toBe(true);
    expect(Number.isFinite(FACE_Y_BY_SHOT_TYPE.lob)).toBe(true);
    expect(Number.isFinite(FACE_Y_BY_SHOT_TYPE.flip)).toBe(true);
    // Chop is the extreme open-face shot (defender scoops under a loop).
    // Must be more open than slice — otherwise it visually collapses
    // into a slice on-screen.
    expect(FACE_Y_BY_SHOT_TYPE.chop).toBeGreaterThan(FACE_Y_BY_SHOT_TYPE.slice);
  });
});

// --- shotTypeFromTarget ----------------------------------------------------

describe('shotTypeFromTarget — spec lookup table', () => {
  test('any_speed_negative_spin → SLICE', () => {
    expect(shotTypeFromTarget(3, -1)).toBe(SHOT_TYPES.SLICE);
    expect(shotTypeFromTarget(6, -10)).toBe(SHOT_TYPES.SLICE);
    expect(shotTypeFromTarget(10, -25)).toBe(SHOT_TYPES.SLICE);
  });

  test('low_speed_low_spin → BLOCK (spec "block or push" — block picked as default)', () => {
    expect(shotTypeFromTarget(3, 0)).toBe(SHOT_TYPES.BLOCK);
    expect(shotTypeFromTarget(4.5, 5)).toBe(SHOT_TYPES.BLOCK);
  });

  test('medium_speed_low_spin → BLOCK', () => {
    expect(shotTypeFromTarget(6, 0)).toBe(SHOT_TYPES.BLOCK);
    expect(shotTypeFromTarget(7.5, 5)).toBe(SHOT_TYPES.BLOCK);
  });

  test('medium_speed_high_topspin → TOPSPIN_DRIVE', () => {
    expect(shotTypeFromTarget(6, 25)).toBe(SHOT_TYPES.TOPSPIN_DRIVE);
    expect(shotTypeFromTarget(7, 30)).toBe(SHOT_TYPES.TOPSPIN_DRIVE);
  });

  test('high_speed_low_spin → SMASH', () => {
    expect(shotTypeFromTarget(9, 0)).toBe(SHOT_TYPES.SMASH);
    expect(shotTypeFromTarget(11, 5)).toBe(SHOT_TYPES.SMASH);
  });

  test('high_speed_high_topspin → LOOP', () => {
    expect(shotTypeFromTarget(9, 25)).toBe(SHOT_TYPES.LOOP);
    expect(shotTypeFromTarget(11, 28)).toBe(SHOT_TYPES.LOOP);
  });

  test('medium spin in mid-speed defaults to TOPSPIN_DRIVE (not in spec table, sane default)', () => {
    expect(shotTypeFromTarget(6, 15)).toBe(SHOT_TYPES.TOPSPIN_DRIVE);
  });
});

// --- powerTierForSpeed + windup depths -------------------------------------

describe('powerTierForSpeed + windup depths', () => {
  // Rescaled for the international ladder. These thresholds are now separate
  // from the shot_type_lookup_table's speed buckets (which stay at 5.0/8.0) —
  // swing power and shot labelling are different concerns that merely shared
  // numbers while the fastest ball in the game was 13.5 m/s.
  test('boundaries: 5.99 → soft, 6.0 → medium, 9.99 → medium, 10.0 → power', () => {
    expect(powerTierForSpeed(5.99)).toBe('soft');
    expect(powerTierForSpeed(6.0)).toBe('medium');
    expect(powerTierForSpeed(9.99)).toBe('medium');
    expect(powerTierForSpeed(10.0)).toBe('power');
  });

  test('the top tier\'s attacking strokes land in the power tier', () => {
    // loop 10.0, drive 10.5, smash 11.5 — if these fell back to medium the
    // telegraph lead would drop to 250ms and the tier would stop being
    // readable from the backswing.
    expect(powerTierForSpeed(10.0)).toBe('power');
    expect(powerTierForSpeed(10.5)).toBe('power');
    expect(powerTierForSpeed(11.5)).toBe('power');
  });

  test('touch shots stay in the soft tier', () => {
    expect(powerTierForSpeed(3.0)).toBe('soft');  // drop_shot
    expect(powerTierForSpeed(4.0)).toBe('soft');  // push
  });

  test('windup depths increase with power tier', () => {
    // Soft/medium stay in the spec ranges (15-25cm, 30-45cm). Power was
    // lifted past the spec's 50-70cm to 85cm so an international-pace swing
    // is visibly loaded well before contact — see TELEGRAPH_LEAD_MS_BY_POWER.
    expect(WINDUP_DEPTH_M_BY_POWER.soft).toBeGreaterThanOrEqual(0.15);
    expect(WINDUP_DEPTH_M_BY_POWER.soft).toBeLessThanOrEqual(0.25);
    expect(WINDUP_DEPTH_M_BY_POWER.medium).toBeGreaterThanOrEqual(0.30);
    expect(WINDUP_DEPTH_M_BY_POWER.medium).toBeLessThanOrEqual(0.45);
    expect(WINDUP_DEPTH_M_BY_POWER.power).toBeGreaterThan(WINDUP_DEPTH_M_BY_POWER.medium);
  });
});

// Telegraph lead is a playability mechanic: an international-pace ball reaches
// the player in 130-180ms, at or below human reaction time, so it has to be
// readable from the backswing rather than from the ball.
describe('telegraph lead scales with shot pace', () => {
  test('lead grows monotonically with power tier', () => {
    expect(TELEGRAPH_LEAD_MS_BY_POWER.soft).toBeLessThan(TELEGRAPH_LEAD_MS_BY_POWER.medium);
    expect(TELEGRAPH_LEAD_MS_BY_POWER.medium).toBeLessThan(TELEGRAPH_LEAD_MS_BY_POWER.power);
  });

  test('a smash telegraphs far earlier than a push', () => {
    expect(telegraphLeadMsForSpeed(22.0)).toBeGreaterThan(telegraphLeadMsForSpeed(4.0));
  });

  test('every lead stays under the commitment lock', () => {
    // The FSM enters COMMITTED before SWINGING. A telegraph lead longer than
    // the commit lock would invert those states.
    for (const ms of Object.values(TELEGRAPH_LEAD_MS_BY_POWER)) {
      expect(ms).toBeLessThan(COMMIT_LOCK_BEFORE_CONTACT_MS);
    }
  });
});

// --- faceNormalForShot -----------------------------------------------------

describe('faceNormalForShot', () => {
  test('composes XZ toward target with Y from shot type, normalised to unit length', () => {
    const paddlePos = new THREE.Vector3(0, 1.0, -1.5);   // AI side
    const targetPos = new THREE.Vector3(0.4, 1.0,  1.0); // player side, right of center
    const out = new THREE.Vector3();
    faceNormalForShot(SHOT_TYPES.TOPSPIN_DRIVE, paddlePos, targetPos, out);

    // Y component matches the spec value for topspin_drive.
    // XZ should be horizontally aligned with paddle→target vector.
    // After normalisation, length is 1.
    expect(out.length()).toBeCloseTo(1.0, 5);
    // Direction sanity: x positive (target is +x of paddle), z positive (target is +z of paddle).
    expect(out.x).toBeGreaterThan(0);
    expect(out.z).toBeGreaterThan(0);
    // Y carries the shot-type telegraph (close to the spec value, scaled by
    // the normalisation factor since the input vector had length sqrt(1 + Y^2)).
    expect(out.y).toBeLessThan(0); // topspin → closed face → negative Y
  });

  test('vertical face for BLOCK (Y component is exactly 0 after normalisation)', () => {
    const out = new THREE.Vector3();
    faceNormalForShot(
      SHOT_TYPES.BLOCK,
      new THREE.Vector3(0, 1, -1),
      new THREE.Vector3(0, 1,  1),
      out,
    );
    expect(out.y).toBeCloseTo(0.0, 5);
    expect(out.length()).toBeCloseTo(1.0, 5);
  });

  test('opens face for SLICE (positive Y)', () => {
    const out = new THREE.Vector3();
    faceNormalForShot(
      SHOT_TYPES.SLICE,
      new THREE.Vector3(0, 1, -1),
      new THREE.Vector3(0, 1,  1),
      out,
    );
    expect(out.y).toBeGreaterThan(0);
  });

  test('returns sane fallback when paddle and target coincide', () => {
    const same = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3();
    faceNormalForShot(SHOT_TYPES.BLOCK, same, same, out);
    expect(out.length()).toBeCloseTo(1.0, 5);
  });
});

// --- windupPositionForShot -------------------------------------------------

describe('windupPositionForShot', () => {
  test('pulls back along -faceNormal by the shot-power tier depth', () => {
    const interception = new THREE.Vector3(0, 1, -1);
    const faceNormal = new THREE.Vector3(0, 0, 1); // facing player side
    const out = new THREE.Vector3();
    windupPositionForShot(SHOT_TYPES.TOPSPIN_DRIVE, /* speed */ 9.0, interception, faceNormal, out);
    // Speed 9 → medium tier (7.0 <= s < 13.0) → 0.38m pullback.
    expect(out.z).toBeCloseTo(-1 - WINDUP_DEPTH_M_BY_POWER.medium, 5);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(1, 5);
  });

  test('power tier pulls back furthest', () => {
    const interception = new THREE.Vector3(0, 1, 0);
    const faceNormal = new THREE.Vector3(0, 0, 1);
    const soft = new THREE.Vector3();
    const power = new THREE.Vector3();
    windupPositionForShot(SHOT_TYPES.BLOCK, 3.0, interception, faceNormal, soft);
    windupPositionForShot(SHOT_TYPES.SMASH, 10.0, interception, faceNormal, power);
    expect(Math.abs(power.z)).toBeGreaterThan(Math.abs(soft.z));
  });
});

// --- specTargetToWorld -----------------------------------------------------

describe('specTargetToWorld', () => {
  test('maps target_z to tableCenterZ + target_z (player side is +z)', () => {
    const out = new THREE.Vector3();
    specTargetToWorld(
      /* tx */ 0.3, /* tz */ 0.8, /* centerX */ 0, /* centerZ */ 0, /* surfaceY */ 0.75, out,
    );
    expect(out.x).toBeCloseTo(0.3, 5);
    expect(out.z).toBeCloseTo(0.8, 5);
    expect(out.y).toBeGreaterThan(0.75); // slightly above table
  });

  // The bug this signature exists to prevent: an off-centre table (Table.glb
  // runs -0.8302..0.6841) used to leave every spec x displaced by the centre
  // offset, so the engines' symmetric envelopes reached past one side line
  // and never used the other.
  test('offsets target_x by the table centre line, not by zero', () => {
    const out = new THREE.Vector3();
    specTargetToWorld(
      /* tx */ 0.7, /* tz */ 0.8, /* centerX */ -0.073, /* centerZ */ 0, /* surfaceY */ 0.75, out,
    );
    expect(out.x).toBeCloseTo(0.627, 5);
  });
});

// --- Recovery --------------------------------------------------------------

describe('recovery constants + helpers', () => {
  // Lengthened for the upper tiers alongside the international re-tune: a
  // faster swing is a longer recovery, and the vulnerability window is the
  // only counter a human has against a tier hitting above reaction time.
  test('RECOVERY_MS matches the retuned ladder (300/420/450)', () => {
    expect(RECOVERY_MS.beginner).toBe(300);
    expect(RECOVERY_MS.intermediate).toBe(420);
    expect(RECOVERY_MS.pro).toBe(450);
  });

  test('Pro has the LONGEST recovery (spec counterintuitive)', () => {
    expect(RECOVERY_MS.pro).toBeGreaterThan(RECOVERY_MS.intermediate);
    expect(RECOVERY_MS.intermediate).toBeGreaterThan(RECOVERY_MS.beginner);
  });

  test('VULNERABILITY_SPEED_MULTIPLIER is exactly 0.4 (spec)', () => {
    expect(VULNERABILITY_SPEED_MULTIPLIER).toBeCloseTo(0.4, 10);
  });

  test('isWithinVulnerabilityWindow tracks elapsed against duration', () => {
    expect(isWithinVulnerabilityWindow(0, 'beginner')).toBe(true);
    expect(isWithinVulnerabilityWindow(150, 'beginner')).toBe(true);
    expect(isWithinVulnerabilityWindow(299.9, 'beginner')).toBe(true);
    expect(isWithinVulnerabilityWindow(300, 'beginner')).toBe(false);
    expect(isWithinVulnerabilityWindow(449, 'pro')).toBe(true);
    expect(isWithinVulnerabilityWindow(451, 'pro')).toBe(false);
  });

  test('recoveryDurationMs has a beginner fallback for unknown difficulty', () => {
    expect(recoveryDurationMs('unknown')).toBe(RECOVERY_MS.beginner);
    expect(recoveryDurationMs(undefined)).toBe(RECOVERY_MS.beginner);
  });
});
