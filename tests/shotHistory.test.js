// Unit tests for the AI worker's shot ring buffer + decay schedule.
// Spec §testing_requirements.unit_tests_jest:
//   - ShotHistory ring buffer wraps correctly at 15 slots
//   - Decay function applied per rally produces expected weights at
//     t+5, t+10, t+20 (0.93^5, 0.93^10, 0.93^20)

import {
  ShotHistory, DEFAULT_CAPACITY, DEFAULT_DECAY, SHOT_FIELDS,
  computeSpinScouting, spinClassOf,
  SPIN_CLASS_BACKSPIN_MAX_RPS, SPIN_CLASS_TOPSPIN_MIN_RPS, SCOUT_MIN_CLASS_SAMPLES,
} from '../js/ai/shotHistory.js';

function makeShotArray(shotId) {
  return [shotId, shotId * 100, 0, 0, 0, 0, 5, 0];
}

describe('ShotHistory', () => {
  test('default capacity matches spec (15)', () => {
    expect(DEFAULT_CAPACITY).toBe(15);
  });

  test('default decay matches spec (0.93)', () => {
    expect(DEFAULT_DECAY).toBe(0.93);
  });

  test('exposes the 10 expected shot fields', () => {
    expect(SHOT_FIELDS).toEqual([
      'shot_id', 'timestamp_ms', 'landing_x', 'landing_z',
      'success', 'swing_lateness_ms', 'ball_speed_at_contact_mps', 'ball_spin_rps',
      // Spin-scouting fields: what the AI SENT, captured at the shot's
      // bounce so they exist on misses too (see shotAdapter).
      'sent_spin_rps', 'sent_speed_mps',
    ]);
  });

  test('size grows up to capacity then wraps (oldest dropped)', () => {
    const h = new ShotHistory();
    for (let i = 1; i <= 20; i++) h.push(makeShotArray(i));
    expect(h.size()).toBe(15);
    const all = h.getAll();
    // After 20 pushes, the 15 in-buffer shots are ids 6..20.
    expect(all[0].shot_id).toBe(6);
    expect(all[all.length - 1].shot_id).toBe(20);
  });

  test('new shot lands at weight 1.0, all existing shots age by one decay step', () => {
    const h = new ShotHistory();
    h.push(makeShotArray(1));
    h.push(makeShotArray(2));
    h.push(makeShotArray(3));
    const all = h.getAll();
    // shot 1 was pushed first, has been decayed twice (after 2 and after 3).
    expect(all[0].weight).toBeCloseTo(Math.pow(0.93, 2), 10);
    expect(all[1].weight).toBeCloseTo(Math.pow(0.93, 1), 10);
    expect(all[2].weight).toBeCloseTo(1.0, 10);
  });

  test('weight at t+5, t+10, t+20 equals 0.93^N exactly (within float tolerance)', () => {
    // Push shot id=1, then push 5 more dummies, snapshot weight.
    // Repeat at +10, +20 absolute steps after shot 1.
    function decayAfter(nMore) {
      const h = new ShotHistory();
      h.push(makeShotArray(1));
      for (let i = 0; i < nMore; i++) h.push(makeShotArray(100 + i));
      const all = h.getAll();
      // shot 1 should still be the OLDEST (unless we overflowed); look it up.
      const s1 = all.find(s => s.shot_id === 1);
      return s1 ? s1.weight : null;
    }
    expect(decayAfter(5)).toBeCloseTo(Math.pow(0.93, 5), 10);
    expect(decayAfter(10)).toBeCloseTo(Math.pow(0.93, 10), 10);
    // After 20 pushes, capacity is 15 so shot 1 is gone. Verify it dropped.
    expect(decayAfter(20)).toBeNull();
    // Verify the t+14 case (still inside capacity) decays correctly.
    expect(decayAfter(14)).toBeCloseTo(Math.pow(0.93, 14), 10);
  });

  test('re-pushing a shot with the same shot_id updates in place without re-decaying', () => {
    const h = new ShotHistory();
    h.push(makeShotArray(1));
    h.push(makeShotArray(2)); // decays shot 1 to 0.93
    // Now update shot 1 in place — should NOT re-decay.
    const updated = makeShotArray(1);
    updated[4] = 1; // success = 1
    h.push(updated);
    const all = h.getAll();
    const s1 = all.find(s => s.shot_id === 1);
    expect(s1.weight).toBeCloseTo(0.93, 10);
    expect(s1.success).toBe(1);
    // Shot 2 should still be at weight 1.0 — push of same-id doesn't age others.
    const s2 = all.find(s => s.shot_id === 2);
    expect(s2.weight).toBeCloseTo(1.0, 10);
  });

  test('accepts object shape as well as array shape', () => {
    const h = new ShotHistory();
    h.push({
      shot_id: 7, timestamp_ms: 700, landing_x: 0.1, landing_z: 0.2,
      success: 1, swing_lateness_ms: 30, ball_speed_at_contact_mps: 5.5, ball_spin_rps: 1.2,
    });
    const s = h.getAll()[0];
    expect(s.shot_id).toBe(7);
    expect(s.landing_x).toBeCloseTo(0.1);
    expect(s.ball_speed_at_contact_mps).toBeCloseTo(5.5);
    expect(s.weight).toBeCloseTo(1.0);
  });

  test('reset clears the buffer', () => {
    const h = new ShotHistory();
    for (let i = 0; i < 5; i++) h.push(makeShotArray(i));
    expect(h.size()).toBe(5);
    h.reset();
    expect(h.size()).toBe(0);
    expect(h.getAll()).toEqual([]);
  });

  test('custom capacity and decay are honored', () => {
    const h = new ShotHistory({ capacity: 3, decay: 0.5 });
    h.push(makeShotArray(1));
    h.push(makeShotArray(2));
    h.push(makeShotArray(3));
    h.push(makeShotArray(4));
    expect(h.size()).toBe(3);
    const all = h.getAll();
    // shot 2 has been decayed twice (after 3, after 4), weight = 0.5^2.
    expect(all[0].shot_id).toBe(2);
    expect(all[0].weight).toBeCloseTo(0.25, 10);
  });
});

// --- Spin scouting ----------------------------------------------------------

describe('spin scouting — learning WHAT the player fails against', () => {
  // Build a shot object the way ShotHistory stores it.
  const shot = (sentSpin, success, late = 0, weight = 1) => ({
    shot_id: Math.random(), success: success ? 1 : 0,
    swing_lateness_ms: late, sent_spin_rps: sentSpin, weight,
  });

  test('spinClassOf: thresholds and pre-schema records', () => {
    expect(spinClassOf(SPIN_CLASS_BACKSPIN_MAX_RPS)).toBe('backspin');
    expect(spinClassOf(SPIN_CLASS_TOPSPIN_MIN_RPS)).toBe('topspin');
    expect(spinClassOf(0)).toBe('flat');
    expect(spinClassOf(undefined)).toBeNull();
    expect(spinClassOf(NaN)).toBeNull();
  });

  test('repeated misses against backspin brand the weakness', () => {
    const shots = [
      shot(-30, false), shot(-25, false), shot(-28, false),   // backspin: 3 misses
      shot(40, true), shot(45, true), shot(35, true),         // topspin: handled fine
      shot(0, true), shot(5, true), shot(2, true),            // flat: handled fine
    ];
    const r = computeSpinScouting(shots);
    expect(r.weakness).toBe('backspin');
  });

  test('no verdict without enough class evidence', () => {
    const r = computeSpinScouting([shot(-30, false), shot(-25, false)]); // mass 2 < min 3
    expect(r.weakness).toBeNull();
  });

  test('a player who handles everything is never branded', () => {
    const shots = [];
    for (let i = 0; i < 4; i++) {
      shots.push(shot(-25, true), shot(40, true), shot(0, true));
    }
    expect(computeSpinScouting(shots).weakness).toBeNull();
  });

  test('decay ages a weakness out: old misses, recent successes', () => {
    const shots = [
      // Three old misses at heavily decayed weight...
      shot(-30, false, 0, 0.2), shot(-25, false, 0, 0.2), shot(-28, false, 0, 0.2),
      // ...outweighed by fresh successes against the same ball.
      shot(-26, true, 0, 1.0), shot(-24, true, 0, 1.0), shot(-27, true, 0, 0.95),
    ];
    const r = computeSpinScouting(shots);
    expect(r.weakness).toBeNull();
  });

  test('pre-schema (8-field) records are skipped, not misclassed', () => {
    const legacy = [{ shot_id: 1, success: 0, swing_lateness_ms: 400, weight: 1 }];
    const r = computeSpinScouting(legacy);
    expect(r.classes.backspin.mass).toBe(0);
    expect(r.classes.flat.mass).toBe(0);
    expect(r.weakness).toBeNull();
  });

  test('lateness alone (reached but always late) can brand a class', () => {
    const shots = [
      shot(-25, true, 350), shot(-28, true, 300), shot(-30, true, 400), shot(-26, true, 380),
      shot(40, true, 20), shot(35, true, 30), shot(45, true, 10),
    ];
    // backspin avg ≈ -0.3 + 3.5·2/... per shot: -0.3 + (350/100)*2 ≈ 6.7 — dominant.
    expect(computeSpinScouting(shots).weakness).toBe('backspin');
  });
});
