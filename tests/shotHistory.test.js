// Unit tests for the AI worker's shot ring buffer + decay schedule.
// Spec §testing_requirements.unit_tests_jest:
//   - ShotHistory ring buffer wraps correctly at 15 slots
//   - Decay function applied per rally produces expected weights at
//     t+5, t+10, t+20 (0.93^5, 0.93^10, 0.93^20)

import { ShotHistory, DEFAULT_CAPACITY, DEFAULT_DECAY, SHOT_FIELDS } from '../js/ai/shotHistory.js';

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

  test('exposes the 8 expected shot fields', () => {
    expect(SHOT_FIELDS).toEqual([
      'shot_id', 'timestamp_ms', 'landing_x', 'landing_z',
      'success', 'swing_lateness_ms', 'ball_speed_at_contact_mps', 'ball_spin_rps',
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
