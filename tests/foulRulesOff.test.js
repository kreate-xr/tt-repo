// Foul Rules OFF ("free play") — the `foulsOn` switch on the shared rulebook.
//
// Off means: no rule break is called and the rally plays on. Ordinary scoring
// (out, double bounce, not returned) is untouched, and a serve that never
// gets into play still loses the point — as a miss, not a FOUL.

const THREE = require('three');

import { createRallyRules } from '../js/modes/rallyRules.js';
import { createMatchModel, createRallyTracker } from '../js/modes/multiplayer/matchModel.js';
import { SETTING_SPECS, coerceSetting } from '../js/profile/store.js';

const tableBox = new THREE.Box3(
  new THREE.Vector3(-0.7625, -0.01, -1.37),
  new THREE.Vector3(0.7625, 0.01, 1.37),
);
const NEAR_Z = 0.6;   // a bounce on the near ('player') half
const FAR_Z = -0.6;   // a bounce on the far ('ai') half
const v = (x, y, z) => ({ x, y, z });

function make(on) {
  let fouls = on;
  let t = 0;
  const rules = createRallyRules({
    near: 'player', far: 'ai',
    getGeometry: () => ({ tableBox, tableSurfaceY: 0 }),
    now: () => t,
    foulsOn: () => fouls,
  });
  return {
    rules,
    set: (x) => { fouls = x; },
    advance: (ms) => { t += ms; },
  };
}

// Player serves with a legal stroke and the serve gets into play.
function servedRally(h) {
  h.rules.beginRally({ server: 'player' });
  h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.5) });
  h.rules.registerBounce({ z: NEAR_Z });
  h.rules.registerBounce({ z: FAR_Z });
}

describe('foul rules ON is unchanged (control)', () => {
  test('serve struck over the table is a foul', () => {
    const h = make(true);
    h.rules.beginRally({ server: 'player' });
    const r = h.rules.registerHit('player', { contactPos: v(0, 0.3, 0.8) });
    expect(r).toMatchObject({ winner: 'ai', reason: 'serveFault', detail: 'overTable', foul: 'player' });
  });
});

describe('foul rules OFF', () => {
  test('a serve struck over the table stands', () => {
    const h = make(false);
    h.rules.beginRally({ server: 'player' });
    expect(h.rules.registerHit('player', { contactPos: v(0, 0.3, 0.8) })).toBeNull();
    expect(h.rules.registerBounce({ z: NEAR_Z })).toBeNull();
    expect(h.rules.registerBounce({ z: FAR_Z })).toBeNull();
    expect(h.rules.isServeStrokeActive()).toBe(false);   // in play
  });

  test('a serve straight onto the far half (no own bounce) is accepted', () => {
    const h = make(false);
    h.rules.beginRally({ server: 'player' });
    h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.5) });
    expect(h.rules.registerBounce({ z: FAR_Z })).toBeNull();
    // ...and then it is an ordinary ball: a second far bounce is the
    // receiver's double bounce, not a foul.
    expect(h.rules.registerBounce({ z: FAR_Z }))
      .toMatchObject({ winner: 'player', reason: 'doubleBounce', foul: null });
  });

  test('a net-cord serve that lands good plays on instead of a let', () => {
    const h = make(false);
    h.rules.beginRally({ server: 'player' });
    h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.5) });
    h.rules.registerBounce({ z: NEAR_Z });
    h.rules.registerNetHit();
    expect(h.rules.registerBounce({ z: FAR_Z })).toBeNull();
  });

  test("a serve that dies on the server's half still loses the point, but not as a foul", () => {
    const h = make(false);
    h.rules.beginRally({ server: 'player' });
    h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.5) });
    h.rules.registerBounce({ z: NEAR_Z });
    expect(h.rules.registerBounce({ z: NEAR_Z }))
      .toMatchObject({ winner: 'ai', reason: 'serveFault', detail: 'doubleOwnBounce', foul: null });
  });

  test('a serve lost off the table is a miss, not a foul', () => {
    const h = make(false);
    h.rules.beginRally({ server: 'player' });
    h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.5) });
    expect(h.rules.registerBallLost())
      .toMatchObject({ winner: 'ai', reason: 'serveFault', foul: null });
  });

  test('a volley is allowed', () => {
    const h = make(false);
    servedRally(h);
    h.rules.registerHit('ai', { contactPos: v(0, 0.3, -1.4) });
    // Ball still heading for the player's half, struck before it bounced.
    const r = h.rules.registerHit('player', {
      contactPos: v(0, 0.25, 0.3), inVel: v(0, -0.5, 3),
    });
    expect(r).toBeNull();
    // With fouls on the same contact is obstruction.
    const on = make(true);
    servedRally(on);
    on.rules.registerHit('ai', { contactPos: v(0, 0.3, -1.4) });
    expect(on.rules.registerHit('player', {
      contactPos: v(0, 0.25, 0.3), inVel: v(0, -0.5, 3),
    })).toMatchObject({ reason: 'illegalVolley' });
  });

  test('swatting a ball already going long still scores to the swatter', () => {
    const h = make(false);
    servedRally(h);
    h.rules.registerHit('ai', { contactPos: v(0, 0.3, -1.4) });
    const r = h.rules.registerHit('player', {
      contactPos: v(0, 0.5, 1.6), inVel: v(0, 0, 6),
    });
    expect(r).toMatchObject({ winner: 'player', reason: 'ballOut', foul: null });
  });

  test('a double hit is allowed', () => {
    const h = make(false);
    servedRally(h);
    h.rules.registerHit('ai', { contactPos: v(0, 0.3, -1.4) });
    h.rules.registerBounce({ z: NEAR_Z });
    h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.4) });
    h.advance(400);
    expect(h.rules.registerHit('player', { contactPos: v(0, 0.3, 1.4) })).toBeNull();
  });

  test('touching the net is not called', () => {
    const h = make(false);
    servedRally(h);
    expect(h.rules.registerNetTouch('player')).toBeNull();
    h.set(true);
    expect(h.rules.registerNetTouch('player')).toMatchObject({ reason: 'netTouch', foul: 'player' });
  });

  test('ordinary scoring is untouched', () => {
    const h = make(false);
    servedRally(h);
    h.rules.registerHit('ai', { contactPos: v(0, 0.3, -1.4) });
    // The AI's return never landed: out.
    expect(h.rules.registerBallLost())
      .toMatchObject({ winner: 'player', reason: 'ballLost', detail: 'out' });
  });

  test('the switch is read live, per event', () => {
    const h = make(true);
    h.rules.beginRally({ server: 'player' });
    h.set(false);
    expect(h.rules.registerHit('player', { contactPos: v(0, 0.3, 0.8) })).toBeNull();
  });
});

describe('profile setting', () => {
  test('foulRules is a boolean, on by default', () => {
    expect(SETTING_SPECS.foulRules).toEqual({ type: 'boolean', default: true });
    expect(coerceSetting('foulRules', 'nope')).toBe(true);
    expect(coerceSetting('foulRules', false)).toBe(false);
  });
});

describe("multiplayer: the host's setting is the room's", () => {
  test('match state carries it; the guest adopts it from the host snapshot', () => {
    const host = createMatchModel({ foulRules: false });
    const guest = createMatchModel();
    expect(guest.getState().foulRules).toBe(true);
    guest.restore(host.serialize());
    expect(guest.getState().foulRules).toBe(false);
    host.setFoulRules(true);
    guest.restore(host.serialize());
    expect(guest.getState().foulRules).toBe(true);
  });

  test('a snapshot from a host without the field means fouls are called', () => {
    const guest = createMatchModel({ foulRules: false });
    const snap = { ...createMatchModel().serialize() };
    delete snap.foulRules;
    guest.restore(snap);
    expect(guest.getState().foulRules).toBe(true);
  });

  test("a rematch keeps the room's rules", () => {
    const m = createMatchModel({ foulRules: false });
    m.reset();
    expect(m.getState().foulRules).toBe(false);
  });

  test("the tracker judges by the match's value", () => {
    const match = createMatchModel({ foulRules: false });
    const t = createRallyTracker({
      tableCenterZ: 0, tableBox, foulsOn: () => match.getState().foulRules,
    });
    t.reset({ server: 'self' });
    t.registerHit('self', { contactPos: v(0, 0.3, 1.5) });
    t.registerBounce(0.6);
    t.registerBounce(-0.6);
    expect(t.registerNetTouch('self')).toBeNull();
    match.setFoulRules(true);
    expect(t.registerNetTouch('self')).toMatchObject({ reason: 'netTouch' });
  });
});
