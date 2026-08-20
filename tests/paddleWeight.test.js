// Paddle weight — the presentation layer for "this bat has mass."
//
// The invariants that matter:
//   - the default class is a NO-OP. Every channel returns identity at 0.5, so
//     shipping this system changes nothing until someone moves the slider, and
//     A/B against the pre-weight feel is exact rather than approximate.
//   - heavier is monotonically stronger/longer/deeper on every channel, and in
//     the right DIRECTION (audio pitch is inverted — heavier rings lower).
//   - haptics move amplitude and duration ONLY. WebXR exposes no frequency
//     control, so a frequency term here would be a lie that never reaches the
//     motor.
//   - outputs stay inside what the actuator accepts: intensity in [0,1], a
//     duration that is a positive integer.
//   - weight does NOT enable visual tracking lag. That is the one cue that
//     trades control fidelity for feel, and it stays off.

const {
  WEIGHT_CLASSES, DEFAULT_WEIGHT, PADDLE_WEIGHT,
  setPaddleWeight, setPaddleWeightClass, paddleWeightGrams,
  hapticWeightEnvelope, audioWeightShape, recoilWeightScale,
  PSEUDO_INERTIA_ENABLED,
} = require('../js/physics/paddleWeight.js');

const P = require('../js/physics/constants.js');
const { recoilPeakForImpact, RECOIL_PEAK_M } = require('../js/xr/paddleRecoil.js');

const LIGHT = WEIGHT_CLASSES.light.weight;
const HEAVY = WEIGHT_CLASSES.heavy.weight;

// Restore the module-level scalar after any test that moves it, so ordering
// between tests can never matter.
afterEach(() => setPaddleWeight(DEFAULT_WEIGHT));

describe('the default class is a no-op', () => {
  test('module starts at the allround class', () => {
    expect(PADDLE_WEIGHT).toBe(DEFAULT_WEIGHT);
    expect(DEFAULT_WEIGHT).toBe(WEIGHT_CLASSES.allround.weight);
  });

  test('haptic envelope passes amplitude and duration through unchanged', () => {
    const env = hapticWeightEnvelope(0.7, 120, DEFAULT_WEIGHT);
    expect(env.intensity).toBeCloseTo(0.7, 12);
    expect(env.durationMs).toBe(120);
  });

  test('audio shape is all unity scales', () => {
    const s = audioWeightShape(DEFAULT_WEIGHT);
    expect(s.bodyFreqScale).toBeCloseTo(1, 12);
    expect(s.bodyDecayScale).toBeCloseTo(1, 12);
    expect(s.bodyGainScale).toBeCloseTo(1, 12);
  });

  test('recoil scale is unity, so the peak matches the bare speed formula', () => {
    expect(recoilWeightScale(DEFAULT_WEIGHT)).toBeCloseTo(1, 12);
    // And the recoil module's default arg agrees with the neutral scale.
    const speed = 4.0;
    expect(recoilPeakForImpact(speed, recoilWeightScale(DEFAULT_WEIGHT)))
      .toBeCloseTo(recoilPeakForImpact(speed), 12);
  });
});

describe('haptics — amplitude and duration only, in the right direction', () => {
  test('heavier is both stronger and longer than lighter', () => {
    const light = hapticWeightEnvelope(0.5, 120, LIGHT);
    const mid   = hapticWeightEnvelope(0.5, 120, DEFAULT_WEIGHT);
    const heavy = hapticWeightEnvelope(0.5, 120, HEAVY);

    expect(light.intensity).toBeLessThan(mid.intensity);
    expect(mid.intensity).toBeLessThan(heavy.intensity);
    expect(light.durationMs).toBeLessThan(mid.durationMs);
    expect(mid.durationMs).toBeLessThan(heavy.durationMs);
  });

  test('duration is the wider axis — it is the one the arm actually integrates', () => {
    const base = hapticWeightEnvelope(0.5, 120, DEFAULT_WEIGHT);
    const heavy = hapticWeightEnvelope(0.5, 120, HEAVY);
    const ampGain = heavy.intensity / base.intensity;
    const durGain = heavy.durationMs / base.durationMs;
    expect(durGain).toBeGreaterThan(ampGain);
  });

  test('exposes no frequency term — WebXR pulse() has nowhere to put one', () => {
    const env = hapticWeightEnvelope(0.5, 120, HEAVY);
    expect(Object.keys(env).sort()).toEqual(['durationMs', 'intensity']);
  });

  test('output stays inside what hapticActuator.pulse() accepts', () => {
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      for (const i of [0, 0.01, 0.5, 0.99, 1]) {
        const env = hapticWeightEnvelope(i, 60, w);
        expect(env.intensity).toBeGreaterThanOrEqual(0);
        expect(env.intensity).toBeLessThanOrEqual(1);
        expect(Number.isInteger(env.durationMs)).toBe(true);
        expect(env.durationMs).toBeGreaterThan(0);
      }
    }
  });

  test('a max-intensity hit on a heavy blade clamps instead of overflowing', () => {
    expect(hapticWeightEnvelope(1.0, 160, HEAVY).intensity).toBe(1);
  });

  test('a light blade never produces a zero-length pulse', () => {
    // Some runtimes read pulse(v, 0) as "cancel the current pulse" — a light
    // bat must still buzz, just less.
    expect(hapticWeightEnvelope(0.3, 1, LIGHT).durationMs).toBeGreaterThan(0);
  });
});

describe('audio — heavier rings lower', () => {
  test('body pitch is inverted against weight', () => {
    expect(audioWeightShape(HEAVY).bodyFreqScale)
      .toBeLessThan(audioWeightShape(DEFAULT_WEIGHT).bodyFreqScale);
    expect(audioWeightShape(DEFAULT_WEIGHT).bodyFreqScale)
      .toBeLessThan(audioWeightShape(LIGHT).bodyFreqScale);
  });

  test('heavier also rings longer and louder, so the lower pitch is not thin', () => {
    const light = audioWeightShape(LIGHT);
    const heavy = audioWeightShape(HEAVY);
    expect(heavy.bodyDecayScale).toBeGreaterThan(light.bodyDecayScale);
    expect(heavy.bodyGainScale).toBeGreaterThan(light.bodyGainScale);
  });

  test('scales stay positive across the range — a zero would silence the body', () => {
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      const s = audioWeightShape(w);
      expect(s.bodyFreqScale).toBeGreaterThan(0);
      expect(s.bodyDecayScale).toBeGreaterThan(0);
      expect(s.bodyGainScale).toBeGreaterThan(0);
    }
  });

  test('the shift is audible but not a different instrument', () => {
    // A ±15% pitch move is about two semitones at the extremes — clearly
    // heard as "same bat, heavier" rather than "someone swapped the sample."
    const spread = audioWeightShape(LIGHT).bodyFreqScale / audioWeightShape(HEAVY).bodyFreqScale;
    expect(spread).toBeGreaterThan(1.15);
    expect(spread).toBeLessThan(1.6);
  });
});

describe('visual — pseudo-inertia stays off', () => {
  test('the flag is off', () => {
    expect(PSEUDO_INERTIA_ENABLED).toBe(false);
  });

  test('paddle pose smoothing ships at the weight-feel default', () => {
    // alpha 0.65 on both axes — ~17 ms of effective lag at 90 Hz, the
    // shipping trade of 1:1 fidelity for perceived blade weight. Both axes
    // must match: pos and rot disagreeing is what reads as a wobbly bat.
    expect(P.PADDLE_POS_SMOOTHING).toBe(0.65);
    expect(P.PADDLE_ROT_SMOOTHING).toBe(0.65);
  });

  test('moving the weight slider does not introduce tracking lag', () => {
    setPaddleWeight(HEAVY);
    expect(P.PADDLE_POS_SMOOTHING).toBe(0.65);
    expect(P.PADDLE_ROT_SMOOTHING).toBe(0.65);
  });

  test('recoil — the sanctioned visual cue — scales with weight and stays small', () => {
    const heavyPeak = recoilPeakForImpact(99, recoilWeightScale(HEAVY));
    const lightPeak = recoilPeakForImpact(99, recoilWeightScale(LIGHT));
    expect(heavyPeak).toBeGreaterThan(lightPeak);
    // Even the heaviest blade's saturated kick stays inside the 1 cm
    // contact-visual agreement budget's neighbourhood — the recoil pivots at
    // the hand, so this is blade-tip travel, not detachment.
    expect(heavyPeak).toBeLessThan(RECOIL_PEAK_M * 1.5);
  });

  test('a bad weight scale falls back to neutral rather than zeroing the kick', () => {
    expect(recoilPeakForImpact(4, 0)).toBeCloseTo(recoilPeakForImpact(4), 12);
    expect(recoilPeakForImpact(4, -1)).toBeCloseTo(recoilPeakForImpact(4), 12);
  });
});

describe('setters and classes', () => {
  test('setPaddleWeight clamps to the usable range', () => {
    setPaddleWeight(5);
    expect(hapticWeightEnvelope(0.5, 100).durationMs)
      .toBe(hapticWeightEnvelope(0.5, 100, HEAVY).durationMs);
    setPaddleWeight(-5);
    expect(hapticWeightEnvelope(0.5, 100).durationMs)
      .toBe(hapticWeightEnvelope(0.5, 100, LIGHT).durationMs);
  });

  test('garbage input lands on light rather than NaN-poisoning every channel', () => {
    setPaddleWeight(undefined);
    const env = hapticWeightEnvelope(0.5, 100);
    expect(Number.isFinite(env.intensity)).toBe(true);
    expect(Number.isInteger(env.durationMs)).toBe(true);
  });

  test('setPaddleWeightClass resolves names and falls back to allround', () => {
    expect(setPaddleWeightClass('heavy')).toBe(HEAVY);
    expect(setPaddleWeightClass('light')).toBe(LIGHT);
    expect(setPaddleWeightClass('nonsense')).toBe(DEFAULT_WEIGHT);
  });

  test('grams span a range a player would actually notice off a rack', () => {
    expect(paddleWeightGrams(LIGHT)).toBe(WEIGHT_CLASSES.light.grams);
    expect(paddleWeightGrams(HEAVY)).toBe(WEIGHT_CLASSES.heavy.grams);
    expect(paddleWeightGrams(DEFAULT_WEIGHT)).toBe(WEIGHT_CLASSES.allround.grams);
    // Real competition bats sit in this band — an ASSEMBLED racket, blade plus
    // two rubber sheets, which is what the player holds. The bounds used to be
    // 65–105 g, which is the mass of a bare blade: a sheet of rubber with its
    // sponge adds ~45–50 g per side, so a playable bat is never under ~150 g.
    // The old band also contradicted the mass physics/paddleSpec.js derives
    // from the geometry (~188 g) by a factor of two.
    expect(WEIGHT_CLASSES.light.grams).toBeGreaterThanOrEqual(150);
    expect(WEIGHT_CLASSES.heavy.grams).toBeLessThanOrEqual(220);
  });
});

describe('adapter presets — published defaults for known geometry', () => {
  const {
    PRESETS, ADAPTER_PRESETS, presetWeightClass, getPresetCopy,
  } = require('../js/xr/calibrationPresets.js');

  test('every adapter preset names a real weight class', () => {
    expect(ADAPTER_PRESETS.length).toBeGreaterThan(0);
    for (const name of ADAPTER_PRESETS) {
      const cls = presetWeightClass(name);
      expect(WEIGHT_CLASSES[cls]).toBeDefined();
    }
  });

  test('bare-controller presets claim no weight — the player picks', () => {
    expect(presetWeightClass('default')).toBeNull();
    expect(presetWeightClass('shakehand')).toBeNull();
    expect(presetWeightClass('penhold')).toBeNull();
    expect(presetWeightClass('nonexistent')).toBeNull();
  });

  test('a blade adapter is heavier than a plastic shell — controller plus real wood', () => {
    expect(presetWeightClass('adapter_blade')).toBe('heavy');
    expect(WEIGHT_CLASSES[presetWeightClass('adapter_blade')].grams)
      .toBeGreaterThan(WEIGHT_CLASSES[presetWeightClass('adapter_shell')].grams);
  });

  test('adapters stand the blade further from the grip than a bare hand does', () => {
    // The controller sits below/inside the mount, so the blade center is
    // further out than the bare-grip presets place it. Getting this wrong is
    // what makes an adapter user swing through the ball.
    const bare = PRESETS.shakehand.posOffset.length();
    for (const name of ADAPTER_PRESETS) {
      expect(PRESETS[name].posOffset.length()).toBeGreaterThan(bare);
    }
  });

  test('getPresetCopy carries the weight hint and does not alias the preset', () => {
    const copy = getPresetCopy('adapter_blade');
    expect(copy.weightClass).toBe('heavy');
    expect(copy.isAdapter).toBe(true);
    copy.posOffset.set(9, 9, 9);
    expect(PRESETS.adapter_blade.posOffset.x).not.toBe(9);
  });

  test('calibration presets stay free of physics imports (spec C6)', () => {
    // Adapters are allowed to HINT a weight class by name, but the moment this
    // module imports the feel constants, calibration gains the power to change
    // how the blade behaves rather than only where it is.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/xr/calibrationPresets.js'), 'utf8',
    );
    expect(src).not.toMatch(/from ['"].*physics\//);
    expect(src).not.toMatch(/require\s*\(\s*['"].*physics\//);
  });
});

// ---------------------------------------------------------------------------
// Swing inertia — the channel that actually carries perceived blade weight.
// ---------------------------------------------------------------------------
describe('swing inertia haptic', () => {
  const {
    inertialSwingIntensity, setPaddleWeight, DEFAULT_WEIGHT, WEIGHT_CLASSES,
    SWING_INERTIA_ACCEL_MIN, SWING_INERTIA_MAX_INTENSITY,
  } = require('../js/physics/paddleWeight.js');

  afterEach(() => setPaddleWeight(DEFAULT_WEIGHT));

  test('is silent below the deadzone, so a still hand does not buzz', () => {
    expect(inertialSwingIntensity(0)).toBe(0);
    expect(inertialSwingIntensity(SWING_INERTIA_ACCEL_MIN)).toBe(0);
  });

  test('rises with acceleration and saturates', () => {
    const a = inertialSwingIntensity(20);
    const b = inertialSwingIntensity(40);
    expect(b).toBeGreaterThan(a);
    expect(inertialSwingIntensity(1e6)).toBeCloseTo(SWING_INERTIA_MAX_INTENSITY, 6);
  });

  test('a heavier blade fights the hand harder at the same acceleration', () => {
    setPaddleWeight(WEIGHT_CLASSES.light.weight);
    const light = inertialSwingIntensity(40);
    setPaddleWeight(WEIGHT_CLASSES.allround.weight);
    const mid = inertialSwingIntensity(40);
    setPaddleWeight(WEIGHT_CLASSES.heavy.weight);
    const heavy = inertialSwingIntensity(40);
    expect(light).toBeLessThan(mid);
    expect(mid).toBeLessThan(heavy);
    // The spread has to be big enough to actually feel — this is the whole
    // point of the channel, so a token difference is a failure.
    expect(heavy / light).toBeGreaterThan(2.5);
  });

  test('the cue is driven by acceleration, not speed', () => {
    // The regression this guards: a swing held at constant velocity must
    // produce NO inertia term. Mass is felt when velocity changes. If this
    // ever starts returning a non-zero value for zero acceleration, the
    // channel has silently become another drag cue.
    expect(inertialSwingIntensity(0, WEIGHT_CLASSES.heavy.weight)).toBe(0);
  });
});

describe('swing inertia — cross-modal and tunability', () => {
  const W = require('../js/physics/paddleWeight.js');
  const PP = require('../js/physics/physicsParams.js');

  afterEach(() => {
    W.setSwingInertiaAccelMin(10);
    W.setSwingInertiaAccelMax(120);
    W.setSwingInertiaMaxIntensity(0.30);
    W.setPaddleWeight(W.DEFAULT_WEIGHT);
  });

  test('the band covers real stroke accelerations without pegging', () => {
    // The failure this guards: a band that saturates below the accelerations
    // people actually swing at. Everything within a stroke then feels
    // identical and the cue reads as an on/off buzz rather than as mass.
    // Reference points: drive ~50, wrist snap ~80, reversal ~100+ m/s².
    const drive = W.swingInertiaNorm(50);
    const snap = W.swingInertiaNorm(80);
    expect(drive).toBeGreaterThan(0.2);
    expect(drive).toBeLessThan(0.6);
    expect(snap).toBeGreaterThan(drive + 0.15);
  });

  test('hand and ear read the same effort value', () => {
    // Cross-modal agreement is the mechanism, so it must not be possible for
    // the haptic to fire while the whoosh reports no effort.
    for (const a of [0, 5, 30, 90, 500]) {
      const norm = W.swingInertiaNorm(a);
      const haptic = W.inertialSwingIntensity(a);
      expect(norm > 0).toBe(haptic > 0);
    }
  });

  test('survives an inverted band without producing NaN', () => {
    // The three rows are set independently, so a user can put MIN above MAX
    // mid-tune. A NaN reaching pulse() throws and kills haptics for the
    // session — far worse than a degenerate but finite value.
    W.setSwingInertiaAccelMax(20);
    W.setSwingInertiaAccelMin(60);
    for (const a of [0, 30, 200]) {
      expect(Number.isFinite(W.swingInertiaNorm(a))).toBe(true);
      expect(Number.isFinite(W.inertialSwingIntensity(a))).toBe(true);
    }
  });

  test('all three rows are reachable and resettable from the panel', () => {
    const ids = ['inertiaMin', 'inertiaMax', 'inertiaPeak', 'paddleWeight'];
    for (const id of ids) {
      const row = PP.FEEL_ROWS.find((r) => r.id === id);
      expect(row).toBeDefined();
      PP.stepRow(row, +1);
      expect(PP.resetRow(row)).toBe(true);
    }
    expect(W.SWING_INERTIA_ACCEL_MIN).toBe(10);
    expect(W.SWING_INERTIA_ACCEL_MAX).toBe(120);
    expect(W.SWING_INERTIA_MAX_INTENSITY).toBeCloseTo(0.30, 6);
  });
});
