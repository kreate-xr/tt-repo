// Slice 2 — seeded RNG. These tests pin the properties that M5's Daily Drill,
// M6's determinism clause and M11's parity clause all rest on.

const {
  mulberry32, hashSeed, deriveStream,
  uniform, int, pick, gaussianPair, gaussian, shuffle,
} = require('../js/util/rng.js');

describe('mulberry32', () => {
  test('same seed produces an identical sequence', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 200 }, () => a());
    const seqB = Array.from({ length: 200 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test('different seeds diverge', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  test('output stays in [0, 1)', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  // The generator must agree with the copy already embedded in
  // tests/imperfection.test.js, or porting those tests to the shared module
  // would silently change every expected value in them.
  test('matches the mulberry32 the existing tests hand-roll', () => {
    function legacy(seed) {
      let s = seed >>> 0;
      return function rng() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (const seed of [0, 1, 101, 504, 70000]) {
      const mine = mulberry32(seed);
      const theirs = legacy(seed);
      const a = Array.from({ length: 40 }, () => mine());
      const b = Array.from({ length: 40 }, () => theirs());
      expect(a).toEqual(b);
    }
  });

  test('mean of a large sample is close to 0.5', () => {
    const rng = mulberry32(4242);
    let sum = 0;
    const N = 100000;
    for (let i = 0; i < N; i++) sum += rng();
    expect(sum / N).toBeCloseTo(0.5, 2);
  });
});

describe('hashSeed', () => {
  test('is deterministic and returns a uint32', () => {
    const h = hashSeed('daily-2026-08-02');
    expect(h).toBe(hashSeed('daily-2026-08-02'));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  test('distinct strings give distinct seeds (no trivial collisions)', () => {
    const seeds = new Set(
      ['a', 'b', 'daily-2026-08-01', 'daily-2026-08-02', 'warmup', 'fh-topspin']
        .map(hashSeed),
    );
    expect(seeds.size).toBe(6);
  });
});

describe('deriveStream', () => {
  // This is the property that keeps a replay valid when one subsystem changes
  // its draw count: streams must not share a sequence.
  test('different names from one root seed are independent', () => {
    const feed = deriveStream(7, 'feed');
    const miss = deriveStream(7, 'miss');
    const seqFeed = Array.from({ length: 50 }, () => feed());
    const seqMiss = Array.from({ length: 50 }, () => miss());
    expect(seqFeed).not.toEqual(seqMiss);
  });

  test('same (root, name) reproduces exactly', () => {
    const a = deriveStream(99, 'scatter');
    const b = deriveStream(99, 'scatter');
    expect(Array.from({ length: 30 }, () => a()))
      .toEqual(Array.from({ length: 30 }, () => b()));
  });

  test('draws on one stream do not disturb another', () => {
    const rootA = deriveStream(5, 'feed');
    const expected = Array.from({ length: 10 }, () => rootA());

    // Re-derive, but hammer an unrelated stream in between.
    const rootB = deriveStream(5, 'feed');
    const other = deriveStream(5, 'other');
    for (let i = 0; i < 1000; i++) other();
    const actual = Array.from({ length: 10 }, () => rootB());

    expect(actual).toEqual(expected);
  });
});

describe('distribution helpers', () => {
  test('uniform respects bounds', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 5000; i++) {
      const v = uniform(rng, -0.4, 0.4);
      expect(v).toBeGreaterThanOrEqual(-0.4);
      expect(v).toBeLessThan(0.4);
    }
  });

  test('int is inclusive at both ends and covers the range', () => {
    const rng = mulberry32(12);
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = int(rng, 1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  test('pick returns undefined on an empty array rather than throwing', () => {
    const rng = mulberry32(13);
    expect(pick(rng, [])).toBeUndefined();
    expect(pick(rng, null)).toBeUndefined();
  });

  test('pick only ever returns members of the array', () => {
    const rng = mulberry32(14);
    const arr = ['top', 'back', 'sideL', 'sideR'];
    for (let i = 0; i < 1000; i++) {
      expect(arr).toContain(pick(rng, arr));
    }
  });

  test('gaussianPair has ~0 mean and ~1 stdev on both components', () => {
    const rng = mulberry32(2024);
    const N = 50000;
    let sx = 0, sy = 0, sx2 = 0, sy2 = 0;
    const out = { x: 0, y: 0 };
    for (let i = 0; i < N; i++) {
      gaussianPair(rng, out);
      sx += out.x; sy += out.y;
      sx2 += out.x * out.x; sy2 += out.y * out.y;
    }
    expect(sx / N).toBeCloseTo(0, 1);
    expect(sy / N).toBeCloseTo(0, 1);
    expect(Math.sqrt(sx2 / N)).toBeCloseTo(1, 1);
    expect(Math.sqrt(sy2 / N)).toBeCloseTo(1, 1);
  });

  test('gaussianPair components are uncorrelated', () => {
    const rng = mulberry32(2025);
    const N = 50000;
    let sxy = 0;
    const out = { x: 0, y: 0 };
    for (let i = 0; i < N; i++) {
      gaussianPair(rng, out);
      sxy += out.x * out.y;
    }
    expect(Math.abs(sxy / N)).toBeLessThan(0.02);
  });

  test('gaussian never returns NaN or Infinity', () => {
    const rng = mulberry32(31337);
    for (let i = 0; i < 20000; i++) {
      expect(Number.isFinite(gaussian(rng))).toBe(true);
    }
  });

  test('shuffle is a permutation and is reproducible', () => {
    const base = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(mulberry32(77), base.slice());
    const b = shuffle(mulberry32(77), base.slice());
    expect(a).toEqual(b);
    expect(a.slice().sort((p, q) => p - q)).toEqual(base);
  });
});
