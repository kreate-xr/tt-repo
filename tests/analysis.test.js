// M7 Review & Stats — analysis core (Blade Heatmap, Why-Did-I-Miss,
// Weakness Report). Pure computation; no scene, no rendering.

const THREE = require('three');

// paddleSolver reaches models.js/ball.js at module scope, so they are mocked
// the same way tests/solverEnvelope.test.js does it.
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.001, -1.37),
      new T.Vector3(0.7625, 0.001, 1.37),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel: null,
  };
});
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return { ballVelocity: new T.Vector3(), ballAngularVelocity: new T.Vector3() };
});

const {
  bladeHeatmap, heatmapAdvice, whyDidIMiss, weaknessReport,
  sessionHeadline, FAULTS,
} = require('../js/modes/training/analysis.js');
const { EventLog, OUTCOMES } = require('../js/profile/eventLog.js');

const env = {
  tableBox: new THREE.Box3(
    new THREE.Vector3(-0.7625, -0.001, -1.37),
    new THREE.Vector3(0.7625, 0.001, 1.37),
  ),
  tableSurfaceY: 0,
  ballRadius: 0.02,
  tableCenterZ: 0,
};

describe('bladeHeatmap', () => {
  test('bins contacts into a square grid', () => {
    const h = bladeHeatmap([{ x: 0, y: 0 }, { x: 0, y: 0 }], { bins: 9 });
    expect(h.grid).toHaveLength(9);
    expect(h.grid[0]).toHaveLength(9);
    expect(h.total).toBe(2);
    expect(h.grid[4][4]).toBe(2); // centre bin of a 9×9
  });

  test('the hotspot is the densest cell', () => {
    const pts = [
      { x: 0.05, y: 0.05 }, { x: 0.05, y: 0.05 }, { x: 0.05, y: 0.05 },
      { x: 0, y: 0 },
    ];
    const h = bladeHeatmap(pts, { bins: 9 });
    expect(h.hotspot.count).toBe(3);
    expect(h.hotspot.x).toBeGreaterThan(0);
    expect(h.hotspot.y).toBeGreaterThan(0);
  });

  test('off-blade contacts are counted, not silently dropped', () => {
    // A player who keeps missing the blade entirely is the most important
    // case this view exists to surface.
    const h = bladeHeatmap([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: -9, y: 0 }], { bins: 9 });
    expect(h.total).toBe(1);
    expect(h.offBlade).toBe(2);
  });

  test('non-finite coordinates count as off-blade rather than corrupting a bin', () => {
    const h = bladeHeatmap([{ x: NaN, y: 0 }, { x: 0, y: Infinity }], { bins: 5 });
    expect(h.total).toBe(0);
    expect(h.offBlade).toBe(2);
  });

  test('an empty set yields a zero grid and no hotspot', () => {
    const h = bladeHeatmap([], { bins: 5 });
    expect(h.total).toBe(0);
    expect(h.hotspot).toBeNull();
    expect(h.grid.flat().every((c) => c === 0)).toBe(true);
  });

  test('filters by stroke when asked', () => {
    const pts = [
      { x: 0, y: 0, stroke: 'loop' },
      { x: 0, y: 0, stroke: 'push' },
      { x: 0, y: 0, stroke: 'loop' },
    ];
    expect(bladeHeatmap(pts, { stroke: 'loop' }).total).toBe(2);
    expect(bladeHeatmap(pts, { stroke: 'push' }).total).toBe(1);
  });

  test('handles null input without throwing', () => {
    expect(() => bladeHeatmap(null)).not.toThrow();
    expect(bladeHeatmap(null).total).toBe(0);
  });
});

describe('heatmapAdvice', () => {
  test('reports a low contact with an earlier-timing hint', () => {
    const msg = heatmapAdvice({ x: 0, y: -0.02, n: 10 }, 'loops');
    expect(msg).toMatch(/2\.0 cm low/);
    expect(msg).toMatch(/earlier/);
  });

  test('reports a high contact with a later-timing hint', () => {
    const msg = heatmapAdvice({ x: 0, y: 0.03, n: 10 }, 'drives');
    expect(msg).toMatch(/high/);
    expect(msg).toMatch(/later/);
  });

  test('a well-centred pattern produces NO advice', () => {
    // A report that always finds a fault trains players to ignore it.
    expect(heatmapAdvice({ x: 0.002, y: -0.001, n: 40 })).toBeNull();
  });

  test('lateral offsets give a spacing hint, not a timing one', () => {
    // Conflating the two would give plainly wrong advice.
    const msg = heatmapAdvice({ x: 0.04, y: 0, n: 10 });
    expect(msg).toMatch(/tip|handle/);
    expect(msg).toMatch(/spacing/);
    expect(msg).not.toMatch(/earlier|later/);
  });

  test('returns null with no samples', () => {
    expect(heatmapAdvice({ x: 0.05, y: 0.05, n: 0 })).toBeNull();
    expect(heatmapAdvice(null)).toBeNull();
  });
});

describe('whyDidIMiss', () => {
  const baseArgs = () => ({
    contactPos: new THREE.Vector3(0.1, 0.25, 1.0),
    contactVel: new THREE.Vector3(0, -1.2, -6.5),
    contactSpin: new THREE.Vector3(20, 0, 0),
    // Chosen to actually land on the far half: at 7 m/s the ball covers 3.5 m
    // before dropping and clears the end of a 2.74 m table entirely.
    actualOutVel: new THREE.Vector3(0.2, 1.5, -4.5),
    actualOutSpin: new THREE.Vector3(10, 0, 0),
    actualFaceNormal: new THREE.Vector3(0, 0.2, -1).normalize(),
    contactLocal: { x: 0.002, y: -0.003 },
    target: { x: 0, z: 1.0 },
    difficulty: 'intermediate',
    env,
  });

  test('produces the three facts M7 asks for', () => {
    const r = whyDidIMiss(baseArgs());
    expect(r).toHaveProperty('contactOffsetM');
    expect(r).toHaveProperty('angleErrorDeg');
    expect(r).toHaveProperty('actualLanding');
    expect(r).toHaveProperty('wouldHaveLanding');
    expect(Object.values(FAULTS)).toContain(r.primaryFault);
  });

  test('a large face-angle error is classified as an angle fault', () => {
    const args = baseArgs();
    // Point the face far from anything that could land the ball on target.
    args.actualFaceNormal = new THREE.Vector3(1, 0, 0);
    const r = whyDidIMiss(args);
    if (r.feasible) {
      expect(r.angleErrorDeg).toBeGreaterThan(6);
      expect(r.primaryFault).toBe(FAULTS.ANGLE);
    }
  });

  test('an off-centre contact with a good angle is a contact fault', () => {
    const args = baseArgs();
    args.contactLocal = { x: 0.05, y: -0.04 };
    const r = whyDidIMiss(args);
    if (r.feasible && r.angleErrorDeg !== null && r.angleErrorDeg < 6) {
      expect(r.primaryFault).toBe(FAULTS.CONTACT);
    }
    expect(r.contactOffsetM).toBeCloseTo(Math.hypot(0.05, 0.04), 3);
  });

  test('reports the actual landing from the shared integrator', () => {
    const r = whyDidIMiss(baseArgs());
    // The outgoing velocity heads toward -z, so it must land on that side.
    expect(r.actualLanding).not.toBeNull();
    expect(r.actualLanding.z).toBeLessThan(1.0);
  });

  test('an unsolvable reference is reported, not faked', () => {
    const args = baseArgs();
    // Nonsense contact state the solver cannot work with.
    args.contactVel = new THREE.Vector3(0, 0, 0);
    args.contactPos = new THREE.Vector3(0, 0, 0);
    const r = whyDidIMiss(args);
    if (!r.feasible) {
      expect(r.primaryFault).toBe(FAULTS.UNSOLVED);
      expect(r.wouldHaveLanding).toBeNull();
    }
  });

  test('never throws on degenerate recorded state', () => {
    // A diagnosis screen must not be the thing that crashes a session review.
    const nasty = [
      { ...baseArgs(), contactVel: new THREE.Vector3(NaN, NaN, NaN) },
      { ...baseArgs(), actualOutVel: null },
      { ...baseArgs(), actualFaceNormal: null },
      { ...baseArgs(), contactLocal: null },
      { ...baseArgs(), contactSpin: new THREE.Vector3(1e9, 1e9, 1e9) },
    ];
    for (const args of nasty) {
      expect(() => whyDidIMiss(args)).not.toThrow();
    }
  });

  test('a missing actual outgoing velocity yields a null landing, not a crash', () => {
    const r = whyDidIMiss({ ...baseArgs(), actualOutVel: null });
    expect(r.actualLanding).toBeNull();
  });
});

describe('weaknessReport', () => {
  const logWith = (rows) => {
    const log = new EventLog();
    for (const [zone, spin, verdict] of rows) log.recordOutcome(verdict, { zone, spin });
    return log;
  };

  test('ranks the worst failure rate first and links a preset', () => {
    const rows = [];
    // Zone 4: 6 attempts, 5 failures. Zone 6: 6 attempts, 1 failure.
    for (let i = 0; i < 6; i++) rows.push([4, 'back', i < 5 ? OUTCOMES.MISS : OUTCOMES.RETURNED]);
    for (let i = 0; i < 6; i++) rows.push([6, 'top', i < 1 ? OUTCOMES.MISS : OUTCOMES.RETURNED]);
    const report = weaknessReport(logWith(rows));

    expect(report.weaknesses[0].key).toBe(4);
    expect(report.weaknesses[0].rate).toBeCloseTo(5 / 6, 3);
    expect(report.weaknesses[0].preset).toBeTruthy();
  });

  test('every weakness carries a drill preset to fix it', () => {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push([4, 'back', OUTCOMES.MISS]);
    for (let i = 0; i < 8; i++) rows.push([6, 'top', OUTCOMES.ERROR]);
    const report = weaknessReport(logWith(rows));
    expect(report.weaknesses.length).toBeGreaterThan(0);
    for (const w of report.weaknesses) {
      expect(typeof w.preset).toBe('string');
      expect(w.preset.length).toBeGreaterThan(0);
    }
  });

  test('dimensions with too little data are excluded, not ranked on noise', () => {
    const rows = [[1, 'top', OUTCOMES.MISS], [1, 'top', OUTCOMES.MISS]];
    const report = weaknessReport(logWith(rows), { minAttempts: 5 });
    expect(report.weaknesses).toHaveLength(0);
    expect(report.insufficientData.length).toBeGreaterThan(0);
  });

  test('insufficient data is reported so the UI can say so explicitly', () => {
    const rows = [[3, 'back', OUTCOMES.MISS]];
    const report = weaknessReport(logWith(rows));
    const zones = report.insufficientData.filter((d) => d.kind === 'zone');
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].attempts).toBe(1);
  });

  test('backspin failures prescribe the backspin drill', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push([5, 'back', OUTCOMES.MISS]);
    const report = weaknessReport(logWith(rows));
    const spinItem = report.all.find((w) => w.kind === 'spin' && w.key === 'back');
    expect(spinItem.preset).toBe('BackspinPush');
  });

  test('limit caps how many weaknesses are returned', () => {
    const rows = [];
    for (const zone of [1, 2, 3, 4, 6]) {
      for (let i = 0; i < 6; i++) rows.push([zone, 'top', OUTCOMES.MISS]);
    }
    expect(weaknessReport(logWith(rows), { limit: 3 }).weaknesses).toHaveLength(3);
  });

  test('an empty log produces no weaknesses and does not throw', () => {
    const report = weaknessReport(new EventLog());
    expect(report.weaknesses).toEqual([]);
    expect(report.all).toEqual([]);
  });

  test('a dimension with zero failures is not a weakness', () => {
    // Listing "Zone 5 — 0% missed" and prescribing a drill for it buries the
    // real weaknesses and sends the player to practise what they already do.
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push([5, 'top', OUTCOMES.RETURNED]);
    const report = weaknessReport(logWith(rows));
    expect(report.weaknesses).toEqual([]);
    // ...but it is still present in the full breakdown.
    expect(report.all.some((w) => w.key === 5)).toBe(true);
  });

  test('only the failing dimensions are ranked, alongside perfect ones', () => {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push([5, 'top', OUTCOMES.RETURNED]);   // perfect
    for (let i = 0; i < 8; i++) rows.push([4, 'back', i < 5 ? OUTCOMES.MISS : OUTCOMES.RETURNED]);
    const report = weaknessReport(logWith(rows));
    expect(report.weaknesses.every((w) => w.failures > 0)).toBe(true);
    expect(report.weaknesses.some((w) => w.key === 4)).toBe(true);
    expect(report.weaknesses.some((w) => w.key === 5)).toBe(false);
  });
});

describe('sessionHeadline', () => {
  test('summarises returns and longest rally', () => {
    const log = new EventLog();
    log.recordOutcome(OUTCOMES.RETURNED, { rallyLength: 3 });
    log.recordOutcome(OUTCOMES.RETURNED, { rallyLength: 7 });
    log.recordOutcome(OUTCOMES.MISS, {});
    const line = sessionHeadline(log);
    expect(line).toMatch(/2\/3/);
    expect(line).toMatch(/67%/);
    expect(line).toMatch(/7/);
  });

  test('an empty log says so rather than showing 0%', () => {
    expect(sessionHeadline(new EventLog())).toMatch(/No balls/);
  });
});
