// Slice 6 — DrillConfig validation + URL codec (P15 §M1 deep-link requirement).

const {
  SPIN_MAX_RAD_S, CONFIG_VERSION, INFINITE,
  SPIN_TYPES, DEPTHS, ARCS, FEED_ORIGINS, FIELD_SPECS, ARC_NET_CLEARANCE,
  defaultConfig, validateConfig, resolveSpinVector,
  encodeConfig, decodeConfig, parseDeepLink, buildDeepLink,
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
  // Two configs that FEED identically must ENCODE identically, or M5's
  // "seed the daily drill from the config string" property breaks.
  test('omega components are zeroed unless spinType is combo', () => {
    const c = validateConfig({ spinType: 'top', omegaX: 99, omegaY: 99, omegaZ: 99 });
    expect([c.omegaX, c.omegaY, c.omegaZ]).toEqual([0, 0, 0]);
  });

  test('combo preserves its omega components', () => {
    const c = validateConfig({ spinType: 'combo', omegaX: 30, omegaY: -20, omegaZ: 10 });
    expect([c.omegaX, c.omegaY, c.omegaZ]).toEqual([30, -20, 10]);
  });

  test('configs differing only in ignored omegas encode the same', () => {
    const a = { spinType: 'back', spinMagnitude: 100, omegaX: 5 };
    const b = { spinType: 'back', spinMagnitude: 100, omegaX: -80 };
    expect(encodeConfig(a)).toBe(encodeConfig(b));
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

describe('URL codec round-trip', () => {
  test('the default config round-trips exactly', () => {
    const c = defaultConfig();
    expect(decodeConfig(encodeConfig(c)).config).toEqual(c);
  });

  test('every spin type round-trips', () => {
    for (const spinType of SPIN_TYPES) {
      const c = validateConfig({ spinType, spinMagnitude: 90 });
      expect(decodeConfig(encodeConfig(c)).config).toEqual(c);
    }
  });

  test('every depth, arc and feed origin round-trips', () => {
    for (const depth of DEPTHS) {
      for (const arc of ARCS) {
        for (const feedOrigin of FEED_ORIGINS) {
          const c = validateConfig({ depth, arc, feedOrigin });
          expect(decodeConfig(encodeConfig(c)).config).toEqual(c);
        }
      }
    }
  });

  test('a fully custom config round-trips', () => {
    const c = validateConfig({
      speed: 17.5, spinType: 'combo',
      omegaX: 40, omegaY: -30, omegaZ: 20,
      placement: { kind: 'free', x: 0.25, z: -1.05 },
      scatterSigma: 0.23, depth: 'short', arc: 'lob',
      interval: 3.4, burstCount: 77, feedOrigin: 'R-near', audioCue: false,
    });
    expect(decodeConfig(encodeConfig(c)).config).toEqual(c);
  });

  test('infinite burst round-trips', () => {
    const c = validateConfig({ burstCount: INFINITE });
    const back = decodeConfig(encodeConfig(c)).config;
    expect(back.burstCount).toBe(INFINITE);
  });

  test('free-point placement round-trips including negative coords', () => {
    const c = validateConfig({ placement: { kind: 'free', x: -0.42, z: 1.33 } });
    expect(decodeConfig(encodeConfig(c)).config.placement)
      .toEqual({ kind: 'free', x: -0.42, z: 1.33 });
  });

  test('encoding is stable — re-encoding a decoded string is identical', () => {
    // Guards against float drift making a shared link change on every hop.
    const s = encodeConfig(validateConfig({ speed: 12.3, scatterSigma: 0.17, interval: 1.7 }));
    expect(encodeConfig(decodeConfig(s).config)).toBe(s);
  });

  test('encoded strings carry the version prefix and stay compact', () => {
    const s = encodeConfig(defaultConfig());
    expect(s.startsWith(`${CONFIG_VERSION}.`)).toBe(true);
    expect(s.length).toBeLessThan(80);
  });
});

describe('codec robustness', () => {
  test('empty and malformed strings yield a valid default config', () => {
    for (const bad of ['', 'nonsense', null, undefined, 42, '.....']) {
      const r = decodeConfig(bad);
      expect(r.ok).toBe(false);
      expect(r.config.speed).toBe(FIELD_SPECS.speed.default);
    }
  });

  test('a truncated string still produces a usable config', () => {
    // Half a link should still start a drill rather than dropping the player
    // into nothing.
    const r = decodeConfig('1.12,t,80');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('truncated');
    expect(r.config.speed).toBe(12);
    expect(r.config.spinType).toBe('top');
    expect(r.config.spinMagnitude).toBe(80);
    expect(r.config.interval).toBe(FIELD_SPECS.interval.default);
  });

  test('a future-version link decodes its stable leading fields', () => {
    const s = encodeConfig(validateConfig({ speed: 9.5, spinType: 'back' }));
    const future = `99.${s.slice(s.indexOf('.') + 1)}`;
    const r = decodeConfig(future);
    expect(r.reason).toBe('future-version');
    expect(r.config.speed).toBe(9.5);
    expect(r.config.spinType).toBe('back');
  });

  test('out-of-range values inside a link are clamped, not trusted', () => {
    // A hand-edited link must not be able to inject a 900 rad/s feed.
    const r = decodeConfig('1.999,t,900,0,0,0,z5,9,d,m,0.01,20,cf,1');
    expect(r.config.speed).toBe(25);
    expect(r.config.spinMagnitude).toBe(SPIN_MAX_RAD_S);
    expect(r.config.scatterSigma).toBe(0.4);
    expect(r.config.interval).toBe(0.8);
  });

  test('unknown enum codes in a link fall back to defaults', () => {
    const r = decodeConfig('1.8,ZZ,150,0,0,0,z5,0.05,QQ,XX,2,20,YY,1');
    expect(r.config.spinType).toBe('top');
    expect(r.config.depth).toBe('deep');
    expect(r.config.arc).toBe('medium');
    expect(r.config.feedOrigin).toBe('center-far');
  });

  test('decode never throws', () => {
    const nasties = ['1.', '1.,,,,,,,,,,,,,', '1.a,b,c,d,e,f,g,h,i,j,k,l,m,n', '-5.x', '1.'.repeat(50)];
    for (const s of nasties) expect(() => decodeConfig(s)).not.toThrow();
  });
});

describe('deep links', () => {
  const BASE = 'https://example.com/tt/';

  test('buildDeepLink then parseDeepLink round-trips', () => {
    const c = validateConfig({ speed: 14, spinType: 'side-L', spinMagnitude: 120 });
    const url = buildDeepLink(c, BASE);
    const parsed = parseDeepLink(url);
    expect(parsed.ok).toBe(true);
    expect(parsed.config).toEqual(c);
  });

  test('a URL with no drill param returns null (absent, not failed)', () => {
    expect(parseDeepLink(BASE)).toBeNull();
    expect(parseDeepLink(`${BASE}?other=1`)).toBeNull();
  });

  test('a malformed drill param returns a failed parse, not null', () => {
    const parsed = parseDeepLink(`${BASE}?drill=garbage`);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.config).toBeTruthy();
  });

  test('an unparseable href returns null rather than throwing', () => {
    expect(parseDeepLink('not a url')).toBeNull();
  });

  test('deep links survive URL encoding of the query string', () => {
    const c = validateConfig({ placement: { kind: 'free', x: -0.5, z: 1.2 }, burstCount: INFINITE });
    const url = buildDeepLink(c, BASE);
    expect(parseDeepLink(url).config).toEqual(c);
  });

  test('buildDeepLink preserves existing query params', () => {
    const url = buildDeepLink(defaultConfig(), `${BASE}?mode=ar`);
    expect(url).toContain('mode=ar');
    expect(parseDeepLink(url).ok).toBe(true);
  });
});
