// js/network/appCheck.js — the App Check attestation that stands between the
// public Firebase config and our Firestore bill.
//
// The failure this guards is silent and one-directional: a build that ships
// with App Check OFF keeps working right up until enforcement is switched on
// in the console, and then every write is permission-denied with no client-
// side hint. So the plan — which mode, from which inputs — is a pure function
// and is pinned here, along with the two invariants that matter most: the
// debug token is honoured ONLY on the dev server, and the SDK global is set
// BEFORE initializeAppCheck runs (the SDK reads it inside that call).

jest.mock('firebase/app-check', () => ({
  initializeAppCheck: jest.fn(),
  ReCaptchaEnterpriseProvider: class { constructor(k) { this.siteKey = k; } },
}));

import {
  planAppCheck, installAppCheck, _resetAppCheckForTests,
} from '../js/network/appCheck.js';

beforeEach(() => _resetAppCheckForTests());

describe('planAppCheck', () => {
  test('production build with a site key → recaptcha', () => {
    expect(planAppCheck({ siteKey: 'abc' })).toEqual({ mode: 'recaptcha', siteKey: 'abc' });
  });

  test('production build without a site key → off, with a warning', () => {
    const p = planAppCheck({ siteKey: '' });
    expect(p.mode).toBe('off');
    expect(p.warning).toMatch(/VITE_RECAPTCHA_ENTERPRISE_SITE_KEY/);
  });

  test('a debug token never turns a production build into debug mode', () => {
    expect(planAppCheck({ siteKey: 'abc', debugToken: 'tok' }).mode).toBe('recaptcha');
    expect(planAppCheck({ siteKey: '', debugToken: 'tok' }).mode).toBe('off');
  });

  test('dev server → debug, with the fixed token when one is configured', () => {
    const p = planAppCheck({ siteKey: 'abc', debugToken: ' tok ', isDevServer: true });
    expect(p.mode).toBe('debug');
    expect(p.debugToken).toBe('tok');
    expect(p.warning).toBeUndefined();
  });

  test('dev server without a fixed token warns that the headset cannot show it', () => {
    const p = planAppCheck({ isDevServer: true });
    expect(p.mode).toBe('debug');
    expect(p.debugToken).toBe('');
    expect(p.warning).toMatch(/headset/);
  });
});

describe('installAppCheck', () => {
  function harness(cfg) {
    const calls = [];
    const globals = {};
    const app = { name: 'app' };
    const initialize = jest.fn((a, opts) => {
      // Capture what the SDK would see at the moment it runs.
      calls.push({ app: a, opts, globalAtInit: globals.FIREBASE_APPCHECK_DEBUG_TOKEN });
    });
    const warn = jest.fn();
    class Provider { constructor(k) { this.siteKey = k; } }
    const result = installAppCheck(app, { ...cfg, globals, initialize, Provider, warn });
    return { result, calls, globals, warn, app };
  }

  test('recaptcha: provider gets the site key, auto-refresh is on, no debug global', () => {
    const h = harness({ siteKey: 'site', debugToken: '', isDevServer: false });
    expect(h.result.mode).toBe('recaptcha');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].app).toBe(h.app);
    expect(h.calls[0].opts.provider.siteKey).toBe('site');
    expect(h.calls[0].opts.isTokenAutoRefreshEnabled).toBe(true);
    expect(h.globals.FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
    expect(h.warn).not.toHaveBeenCalled();
  });

  test('debug: the SDK global is set BEFORE initializeAppCheck is called', () => {
    const h = harness({ siteKey: '', debugToken: 'fixed-token', isDevServer: true });
    expect(h.result.mode).toBe('debug');
    expect(h.calls[0].globalAtInit).toBe('fixed-token');
  });

  test('debug without a fixed token asks the SDK to mint one (global === true)', () => {
    const h = harness({ siteKey: '', debugToken: '', isDevServer: true });
    expect(h.calls[0].globalAtInit).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  test('off: nothing is initialized, the warning is loud', () => {
    const h = harness({ siteKey: '', debugToken: '', isDevServer: false });
    expect(h.result.mode).toBe('off');
    expect(h.calls).toHaveLength(0);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  test('an SDK throw is contained: warned, reported as off, never rethrown', () => {
    const warn = jest.fn();
    const result = installAppCheck({}, {
      siteKey: 'site', isDevServer: false, warn,
      initialize: () => { throw new Error('boom'); },
      Provider: class {},
    });
    expect(result.mode).toBe('off');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/initialization failed/), 'boom');
  });

  test('idempotent: a second call is a no-op', () => {
    const initialize = jest.fn();
    const opts = { siteKey: 'site', isDevServer: false, initialize, Provider: class {}, warn: jest.fn() };
    installAppCheck({}, opts);
    expect(installAppCheck({}, opts).mode).toBe('already');
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
