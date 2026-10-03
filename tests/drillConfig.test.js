// DrillConfig validation (P15 §M1).

const {
  SPIN_MAX_RAD_S, INFINITE,
  SPIN_TYPES, DEPTHS, ARCS, FEED_ORIGINS, FIELD_SPECS, ARC_NET_CLEARANCE,
  defaultConfig, validateConfig, resolveSpinVector,
} = require('../js/modes/training/drillConfig.js');

describe('defaults match the M1 attribute table', () => {
  test('every documented default is honoured', () => {
    const c = defaultConfig();
    expect(c.speed).toBe(8);
    expect(c.spinType).toBe('top');
    expect(c.spinMagnitude).toBe(375);
    expect(c.scatterSigma).toBe(0.05);
    expect(c.depth).toBe('deep');
    expect(c.arc).toBe('medium');
    expect(c.interval).toBe(2.0);
    expect(c.burstCount).toBe(20);
    expect(c.feedOrigin).toBe('center-far');
    expect(c.audioCue).toBe(true);
    expect(c.placement).toEqual({ kind: 'zone', zone: 5 });
  });

  test('the default config is already valid (validate is a no-op on it)', () => {
    expect(validateConfig(defaultConfig())).toEqual(defaultConfig());
  });

  test('arc net-clearance targets match the spec (0.05 / 0.15 / 0.5)', () => {
    expect(ARC_NET_CLEARANCE.flat).toBe(0.05);
    expect(ARC_NET_CLEARANCE.medium).toBe(0.15);
    expect(ARC_NET_CLEARANCE.lob).toBe(0.5);
  });
});

describe('spin clamp to the feasible envelope', () => {
  // The session decision: cap at the measured solver limit rather than ship
  // the spec's 0-900 rad/s, whose top half cannot land.
  test(`spinMagnitude clamps at ${SPIN_MAX_RAD_S} rad/s`, () => {
    expect(validateConfig({ spinMagnitude: 900 }).spinMagnitude).toBe(SPIN_MAX_RAD_S);
    expect(validateConfig({ spinMagnitude: 1e6 }).spinMagnitude).toBe(SPIN_MAX_RAD_S);
    expect(validateConfig({ spinMagnitude: -50 }).spinMagnitude).toBe(0);
  });

  test('the default of 375 rad/s (spec 150 × 2.5 rescale) survives the clamp unchanged', () => {
    // If this ever fails, the clamp has been tightened past the documented
    // default and every out-of-the-box feed silently changed.
    expect(validateConfig({ spinMagnitude: 375 }).spinMagnitude).toBe(375);
    expect(SPIN_MAX_RAD_S).toBeGreaterThanOrEqual(375);
  });

  test('combo omega components clamp on both signs', () => {
    const c = validateConfig({ spinType: 'combo', omegaX: 900, omegaY: -900, omegaZ: 12 });
    expect(c.omegaX).toBe(SPIN_MAX_RAD_S);
    expect(c.omegaY).toBe(-SPIN_MAX_RAD_S);
    expect(c.omegaZ).toBe(12);
  });

  test('the clamp sits within the documented solver envelope (~±400 rad/s)', () => {
    // After the ×2.5 rescale to physical rad/s (MAGNUS_COEFFICIENT
    // 0.010 → 0.004) the AI spin economy tops out near ±64 rps
    // (≈ ±400 rad/s). The cap must not exceed that materially.
    expect(SPIN_MAX_RAD_S).toBeLessThanOrEqual(425);
  });
});

describe('field clamping', () => {
  test('numeric fields clamp to their spec range', () => {
    expect(validateConfig({ speed: 1000 }).speed).toBe(25);
    expect(validateConfig({ speed: 0 }).speed).toBe(2);
    expect(validateConfig({ scatterSigma: 5 }).scatterSigma).toBe(0.4);
    expect(validateConfig({ scatterSigma: -1 }).scatterSigma).toBe(0);
    expect(validateConfig({ interval: 0.1 }).interval).toBe(0.8);
    expect(validateConfig({ interval: 99 }).interval).toBe(6);
  });

  test('non-finite numbers fall back to defaults rather than producing NaN', () => {
    const c = validateConfig({ speed: NaN, scatterSigma: 'abc', interval: undefined });
    expect(c.speed).toBe(FIELD_SPECS.speed.default);
    expect(c.scatterSigma).toBe(FIELD_SPECS.scatterSigma.default);
    expect(c.interval).toBe(FIELD_SPECS.interval.default);
    for (const v of Object.values(c)) expect(v).not.toBeNaN();
  });

  test('unknown enum values fall back to defaults', () => {
    expect(validateConfig({ spinType: 'corkscrew' }).spinType).toBe('top');
    expect(validateConfig({ depth: 'infinite' }).depth).toBe('deep');
    expect(validateConfig({ arc: 'parabolic' }).arc).toBe('medium');
    expect(validateConfig({ feedOrigin: 'moon' }).feedOrigin).toBe('center-far');
  });

  test('burst count clamps to 1-100 or the infinite sentinel', () => {
    expect(validateConfig({ burstCount: 500 }).burstCount).toBe(100);
    expect(validateConfig({ burstCount: 0 }).burstCount).toBe(1);
    expect(validateConfig({ burstCount: INFINITE }).burstCount).toBe(INFINITE);
    expect(validateConfig({ burstCount: 'inf' }).burstCount).toBe(INFINITE);
    expect(validateConfig({ burstCount: 37 }).burstCount).toBe(37);
  });

  test('garbage input yields a fully valid config', () => {
    for (const junk of [null, undefined, 'string', 42, [], { placement: 'bad' }]) {
      const c = validateConfig(junk);
      expect(SPIN_TYPES).toContain(c.spinType);
      expect(DEPTHS).toContain(c.depth);
      expect(ARCS).toContain(c.arc);
      expect(FEED_ORIGINS).toContain(c.feedOrigin);
      expect(c.placement.kind).toBe('zone');
    }
  });
});

describe('placement', () => {
  test('zones 1-9 are accepted', () => {
    for (let z = 1; z <= 9; z++) {
      expect(validateConfig({ placement: { kind: 'zone', zone: z } }).placement.zone).toBe(z);
    }
  });

  test('out-of-range zones fall back to the middle', () => {
    expect(validateConfig({ placement: { kind: 'zone', zone: 0 } }).placement.zone).toBe(5);
    expect(validateConfig({ placement: { kind: 'zone', zone: 10 } }).placement.zone).toBe(5);
    expect(validateConfig({ placement: { kind: 'zone', zone: 'x' } }).placement.zone).toBe(5);
  });

  test('free points are preserved', () => {
    const p = validateConfig({ placement: { kind: 'free', x: 0.3, z: -1.1 } }).placement;
    expect(p).toEqual({ kind: 'free', x: 0.3, z: -1.1 });
  });

  test('a free point with non-finite coords falls back to the default zone', () => {
    const p = validateConfig({ placement: { kind: 'free', x: NaN, z: 1 } }).placement;
    expect(p).toEqual({ kind: 'zone', zone: 5 });
  });
});

describe('canonicalisation', () => {
  // Two configs that FEED identically must compare equal.
  test('omega components are zeroed unless spinType is combo', () => {
    const c = validateConfig({ spinType: 'top', omegaX: 99, omegaY: 99, omegaZ: 99 });
    expect([c.omegaX, c.omegaY, c.omegaZ]).toEqual([0, 0, 0]);
  });

  test('combo preserves its omega components', () => {
    const c = validateConfig({ spinType: 'combo', omegaX: 30, omegaY: -20, omegaZ: 10 });
    expect([c.omegaX, c.omegaY, c.omegaZ]).toEqual([30, -20, 10]);
  });

  test('configs differing only in ignored omegas validate the same', () => {
    const a = { spinType: 'back', spinMagnitude: 100, omegaX: 5 };
    const b = { spinType: 'back', spinMagnitude: 100, omegaX: -80 };
    expect(validateConfig(a)).toEqual(validateConfig(b));
  });
});

describe('resolveSpinVector', () => {
  test('axis convention matches the existing feeder SPIN_AXES', () => {
    const at = (spinType) => resolveSpinVector(validateConfig({ spinType, spinMagnitude: 100 }));
    expect(at('top')).toEqual({ x: 100, y: 0, z: 0 });
    expect(at('back')).toEqual({ x: -100, y: 0, z: 0 });
    expect(at('side-R')).toEqual({ x: 0, y: 100, z: 0 });
    expect(at('side-L')).toEqual({ x: 0, y: -100, z: 0 });
    expect(at('none')).toEqual({ x: 0, y: 0, z: 0 });
  });

  test('combo returns the raw vector', () => {
    const c = validateConfig({ spinType: 'combo', omegaX: 10, omegaY: -20, omegaZ: 30 });
    expect(resolveSpinVector(c)).toEqual({ x: 10, y: -20, z: 30 });
  });

  test('resolved spin never exceeds the feasible envelope per axis', () => {
    const c = validateConfig({ spinType: 'combo', omegaX: 9e9, omegaY: -9e9, omegaZ: 9e9 });
    const v = resolveSpinVector(c);
    for (const comp of [v.x, v.y, v.z]) {
      expect(Math.abs(comp)).toBeLessThanOrEqual(SPIN_MAX_RAD_S);
    }
  });
});
