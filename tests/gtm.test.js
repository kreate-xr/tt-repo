// js/analytics/gtm.js — the Google Tag Manager container bootstrap.
//
// The failure this guards against is a silent one. GTM's own snippet is an
// inline <script>, which firebase.json's `script-src 'self'
// https://www.googletagmanager.com` blocks outright — the page would look
// perfectly healthy while collecting nothing at all. This module does the same
// work without an inline block, so the shape of what it pushes and injects has
// to stay exactly what GTM expects.
//
// The environment is injected rather than read off globals: this project has
// no jsdom (jest runs the `node` environment), so a fake window/document is the
// only way to exercise any of it.

import { initGtm, grantConsent } from '../js/analytics/gtm.js';

// dataLayer holds two shapes: plain objects for events ({event: 'gtm.js'}) and
// `arguments` objects for consent commands (['consent', 'default', {...}]).
// Only the former has .event, which is what separates them.
const eventsIn = (dl) => Array.from(dl).filter((e) => e && e.event);
const consentIn = (dl, kind) =>
  Array.from(dl)
    .filter((e) => e && !e.event && e[0] === 'consent' && e[1] === kind)
    .map((e) => e[2]);

function fakeEnv() {
  const scripts = [];
  const win = {};
  const doc = {
    createElement: () => ({ tagName: 'SCRIPT' }),
    head: { appendChild: (el) => { scripts.push(el); return el; } },
  };
  return { win, doc, scripts };
}

describe('initGtm', () => {
  test('injects gtm.js for the given container', () => {
    const env = fakeEnv();
    expect(initGtm('GTM-ABC1234', env)).toBe(true);
    expect(env.scripts).toHaveLength(1);
    expect(env.scripts[0].src).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234');
    // Async so the container never blocks first paint — the head is already
    // busy preloading three GLBs and three sounds.
    expect(env.scripts[0].async).toBe(true);
  });

  test('pushes the gtm.start / gtm.js event the container needs to initialise', () => {
    const env = fakeEnv();
    initGtm('GTM-ABC1234', env);
    expect(Array.isArray(env.win.dataLayer)).toBe(true);
    const [start] = eventsIn(env.win.dataLayer);
    // Not boilerplate: without the gtm.js event the container never starts,
    // and gtm.start is what GTM measures container load time against.
    expect(start.event).toBe('gtm.js');
    expect(typeof start['gtm.start']).toBe('number');
  });

  test('does nothing without a container id — an unset env var is not an error', () => {
    const env = fakeEnv();
    expect(initGtm('', env)).toBe(false);
    expect(env.scripts).toHaveLength(0);
    expect(env.win.dataLayer).toBeUndefined();
  });

  test('is idempotent — a second call would double every event GTM fires', () => {
    const env = fakeEnv();
    expect(initGtm('GTM-ABC1234', env)).toBe(true);
    expect(initGtm('GTM-ABC1234', env)).toBe(false);
    expect(env.scripts).toHaveLength(1);
    // Two consent defaults + the gtm.js event, pushed once and once only.
    expect(env.win.dataLayer).toHaveLength(3);
  });

  test('preserves an existing dataLayer rather than replacing it', () => {
    const env = fakeEnv();
    env.win.dataLayer = [{ event: 'earlier' }];
    initGtm('GTM-ABC1234', env);
    expect(env.win.dataLayer[0].event).toBe('earlier');
    expect(eventsIn(env.win.dataLayer).map((e) => e.event))
      .toEqual(['earlier', 'gtm.js']);
  });

  test('url-encodes the container id so a stray value cannot break out of the query', () => {
    const env = fakeEnv();
    initGtm('GTM-A&foo=bar', env);
    expect(env.scripts[0].src)
      .toBe('https://www.googletagmanager.com/gtm.js?id=GTM-A%26foo%3Dbar');
  });

  test('never throws into app startup', () => {
    const env = fakeEnv();
    env.doc.head.appendChild = () => { throw new Error('CSP blocked'); };
    expect(() => initGtm('GTM-ABC1234', env)).not.toThrow();
    expect(initGtm('GTM-ABC1234', env)).toBe(false);
  });

  test('no-ops with no document at all, rather than throwing', () => {
    expect(initGtm('GTM-ABC1234', { win: {}, doc: null })).toBe(false);
  });
});

describe('consent mode v2', () => {
  test('declares both defaults BEFORE the gtm.js event', () => {
    const env = fakeEnv();
    initGtm('GTM-ABC1234', env);
    const kinds = Array.from(env.win.dataLayer)
      .map((e) => (e && e.event ? 'event' : e[1]));
    // A default that lands after the container boots is ignored, and by then
    // a cookie has already been written. Order is the whole guarantee.
    expect(kinds).toEqual(['default', 'default', 'event']);
  });

  test('grants analytics but denies every ad signal outside the EEA', () => {
    const env = fakeEnv();
    initGtm('GTM-ABC1234', env);
    const [global] = consentIn(env.win.dataLayer, 'default');
    expect(global.region).toBeUndefined();
    expect(global.analytics_storage).toBe('granted');
    // The privacy notice promises no ad profiling; this is where that is true
    // on the wire rather than only in the container's config.
    expect(global.ad_storage).toBe('denied');
    expect(global.ad_user_data).toBe('denied');
    expect(global.ad_personalization).toBe('denied');
  });

  test('denies storage by default across the EEA, the UK and Switzerland', () => {
    const env = fakeEnv();
    initGtm('GTM-ABC1234', env);
    const regional = consentIn(env.win.dataLayer, 'default')[1];
    expect(regional.analytics_storage).toBe('denied');
    expect(regional.region).toEqual(expect.arrayContaining(['DE', 'FR', 'IE', 'GB', 'CH', 'NO']));
    // 27 EU + 3 EEA + UK + CH. A missing country is a country tracked without
    // consent, so the count is worth pinning.
    expect(regional.region).toHaveLength(32);
  });

  test('grantConsent raises analytics only, leaving the ad signals denied', () => {
    const env = fakeEnv();
    initGtm('GTM-ABC1234', env);
    expect(grantConsent(env)).toBe(true);
    const [update] = consentIn(env.win.dataLayer, 'update');
    expect(update).toEqual({ analytics_storage: 'granted' });
  });

  test('grantConsent no-ops before the container has booted', () => {
    // No banner exists yet; when one does, it must not be able to push an
    // update into a dataLayer that is not there.
    expect(grantConsent({ win: {} })).toBe(false);
  });
});
