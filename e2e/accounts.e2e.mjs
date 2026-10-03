// End-to-end: accounts, free trial and the lifetime unlock, driven through
// the real landing page in headless Chromium against the real backend
// (functions/ in the Functions emulator) and real Auth / Firestore
// emulators. Only PayLayer + Razorpay are faked (e2e/fakePayLayer.mjs).
//
// Run with `npm run test:e2e` (e2e/run.mjs) — it starts the emulators and
// calls this file; on its own it expects them to be up already.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFakePayLayer } from './fakePayLayer.mjs';

const PROJECT = 'demo-tt';
const APP_URL = 'http://localhost:5180/';
const PAY_PORT = 8790;
const FIRESTORE = 'http://127.0.0.1:8189';
const WEBHOOK_URL = `http://127.0.0.1:5101/${PROJECT}/us-central1/api/webhooks/paylayer`;
const ARTIFACTS = process.env.E2E_ARTIFACTS || path.resolve('e2e/.artifacts');
const PASSWORD = 'correct-horse-9';

mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    throw err;
  }
}

// ── infrastructure ──────────────────────────────────────────────────────────

function startVite() {
  // Straight through node, not `npx` + a shell: on Windows killing the shell
  // leaves the real Vite process holding the port for the next run.
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'e2e', '--port', '5180', '--strictPort'], {
    env: { ...process.env, DEV_HTTP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.output = () => out;
  return child;
}

async function waitFor(url, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGKILL');
}

/** Admin write through the emulator REST API (bypasses rules). */
async function setTrialUsed(uid, usedMs) {
  const url = `${FIRESTORE}/v1/projects/${PROJECT}/databases/tabletennis/documents/users/${uid}?updateMask.fieldPaths=trial`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { trial: { mapValue: { fields: {
      usedMs: { integerValue: String(usedMs) }, lastTickMs: { nullValue: null }, leaseMs: { integerValue: '0' },
    } } } } }),
  });
  assert.equal(res.status, 200, `emulator PATCH failed: ${await res.text()}`);
}

async function readDoc(docPath) {
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/tabletennis/documents/${docPath}`, {
    headers: { authorization: 'Bearer owner' },
  });
  return res.status === 200 ? res.json() : null;
}

// ── page helpers ────────────────────────────────────────────────────────────

const uidOf = (page) => page.evaluate(async () => {
  const m = await import('/js/network/firebaseClient.js');
  const auth = m.getFirebaseAuth();
  await auth.authStateReady();
  return auth.currentUser ? auth.currentUser.uid : null;
});

async function waitAccess(page, pattern) {
  await page.waitForFunction((src) => {
    const el = document.getElementById('access-text');
    const line = document.getElementById('access-line');
    return el && line && !line.hidden && new RegExp(src).test(el.textContent);
  }, pattern.source, { timeout: 20_000 });
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: false });
}

const modalView = (page) => page.evaluate(() => {
  const m = document.getElementById('account-modal');
  if (!m || m.hidden) return null;
  const v = [...m.querySelectorAll('[id^="acct-view-"]')].find((n) => !n.hidden);
  return v ? v.id.replace('acct-view-', '') : null;
});

// ── scenarios ───────────────────────────────────────────────────────────────

async function main() {
  const pay = await startFakePayLayer({ port: PAY_PORT, webhookUrl: WEBHOOK_URL, log: (m) => console.log(`    [paylayer] ${m}`) });
  const vite = startVite();
  // Playwright's own Chromium when it has been downloaded
  // (`npx playwright install chromium`), else the installed Google Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const consoleErrors = [];
  try {
    await waitFor(APP_URL);
    const email = `player${Date.now()}@example.com`;

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctxA.newPage();
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    let trialUid;
    await step('first visit: anonymous, full 10-minute trial shown', async () => {
      await page.goto(APP_URL);
      await waitAccess(page, /Free trial: 10:00 of play left/);
      assert.equal((await page.locator('#account-chip').textContent()).trim(), 'Sign in');
      assert.equal(await page.locator('#access-buy').isVisible(), true);
      trialUid = await uidOf(page);
      assert.ok(trialUid, 'anonymous uid');
      await shot(page, '01-landing-trial');
    });

    await step('trial lease from the browser bills real time on the server', async () => {
      const r = await page.evaluate(async () => {
        const api = await import('/js/account/api.js');
        const a = await api.postLease('start');
        await new Promise((res) => setTimeout(res, 2100));
        const b = await api.postLease('end');
        return { a, b };
      });
      assert.deepEqual(r.a, { entitled: false, leaseSec: 60, remainingSec: 600 });
      assert.ok(r.b.remainingSec <= 598 && r.b.remainingSec >= 590, `remaining after ~2 s: ${r.b.remainingSec}`);
      const user = await readDoc(`users/${trialUid}`);
      assert.ok(Number(user.fields.trial.mapValue.fields.usedMs.integerValue) >= 2000);
    });

    await step('venue button is allowed while trial remains (reaches the WebXR check)', async () => {
      await page.click('.enter-venue.primary');
      await page.waitForFunction(() => /WebXR not available|not supported on this device/.test(document.getElementById("status").textContent));
      assert.equal(await modalView(page), null);
    });

    await step('trial used up: landing says so and the venue opens the paywall', async () => {
      await setTrialUsed(trialUid, 600_000);
      await page.reload();
      await waitAccess(page, /free trial is over/);
      await page.click('.enter-venue.primary');
      await page.waitForFunction(() => !document.getElementById('account-modal').hidden);
      assert.equal(await modalView(page), 'signup');
      assert.match(await page.locator('#account-sub').textContent(), /10-minute free trial is over/);
      await shot(page, '02-paywall-signup');
    });

    await step('create account: short password rejected client-side', async () => {
      await page.fill('#acct-signup-email', email);
      await page.fill('#acct-signup-password', 'short');
      await page.click('#acct-signup-form button[type=submit]');
      assert.match(await page.locator('#account-status').textContent(), /at least 8 characters/);
    });

    await step('create account links the anonymous trial uid (same uid, now with email)', async () => {
      await page.fill('#acct-signup-password', PASSWORD);
      await page.click('#acct-signup-form button[type=submit]');
      await page.waitForFunction(() => !document.getElementById('acct-view-buy').hidden, null, { timeout: 20_000 });
      assert.equal(await uidOf(page), trialUid, 'linkWithCredential must keep the uid');
      assert.equal((await page.locator('#account-chip').textContent()).trim(), email);
      assert.equal((await page.locator('#acct-buy-email').textContent()).trim(), email);
      assert.match(await page.locator('#acct-buy-price').textContent(), /₹499.*\$9\.99/);
      await shot(page, '03-buy-form');
    });

    await step('checkout: invalid phone is refused by the backend', async () => {
      await page.fill('#acct-buy-name', 'Asha Rao');
      await page.fill('#acct-buy-phone', '98765');
      await page.click('#acct-buy-form button[type=submit]');
      await page.waitForFunction(() => /country code/.test(document.getElementById('account-status').textContent));
      assert.equal(pay.intents.size, 0);
    });

    await step('checkout: closing the payment window charges nothing', async () => {
      await page.evaluate(() => { window.__E2E_PAY_DISMISS = true; });
      await page.fill('#acct-buy-phone', '+91 98765 43210');
      await page.click('#acct-buy-form button[type=submit]');
      await page.waitForFunction(() => /nothing was charged/.test(document.getElementById('account-status').textContent));
      assert.equal(await modalView(page), 'buy');
      await page.evaluate(() => { window.__E2E_PAY_DISMISS = false; });
    });

    let paidIntent;
    await step('checkout: pay → signed webhook → entitlement → unlocked', async () => {
      await page.click('#acct-buy-form button[type=submit]');
      await page.waitForFunction(() => !document.getElementById('acct-view-done').hidden, null, { timeout: 30_000 });
      const intents = [...pay.intents.values()];
      paidIntent = intents.find((i) => i.status === 'paid');
      assert.ok(paidIntent, 'an intent was paid');
      assert.equal(paidIntent.amount, 49900);
      assert.equal(paidIntent.currency, 'INR');
      assert.deepEqual(paidIntent.customer, { name: 'Asha Rao', email, contact: '+919876543210' });
      assert.equal(paidIntent.idempotencyKey, paidIntent.siteReference);
      const ent = await readDoc(`entitlements/${trialUid}`);
      assert.equal(ent.fields.active.booleanValue, true);
      await shot(page, '04-unlocked');
      await page.click('#acct-done-close');
      await waitAccess(page, /Full game unlocked/);
      assert.equal(await page.locator('#access-buy').isVisible(), false);
      await shot(page, '05-landing-unlocked');
    });

    await step('unlocked: the venue button gets past the gate again', async () => {
      await page.evaluate(() => { document.getElementById('status').textContent = ''; });
      await page.click('.enter-venue.primary');
      await page.waitForFunction(() => /WebXR not available|not supported on this device/.test(document.getElementById("status").textContent));
      assert.equal(await modalView(page), null);
    });

    await step('account view shows the unlock; buying again is refused', async () => {
      await page.click('#account-chip');
      assert.equal(await modalView(page), 'account');
      assert.match(await page.locator('#acct-status-line').textContent(), /Full game unlocked/);
      assert.equal(await page.locator('#acct-buy').isVisible(), false);
      const r = await page.evaluate(async () => {
        const api = await import('/js/account/api.js');
        try { await api.postOrder({ name: 'A', phone: '+919876543210' }); return 'created'; } catch (e) { return e.code; }
      });
      assert.equal(r, 'already_owned');
      await page.keyboard.press('Escape');
      assert.equal(await modalView(page), null);
    });

    await step('new device: fresh trial, then sign-in restores the purchase', async () => {
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const pageB = await ctxB.newPage();
      await pageB.goto(APP_URL);
      await waitAccess(pageB, /Free trial: 10:00/);
      const anonB = await uidOf(pageB);
      assert.notEqual(anonB, trialUid);

      await pageB.click('#account-chip');
      assert.equal(await modalView(pageB), 'signin');
      await pageB.fill('#acct-signin-email', email);
      await pageB.fill('#acct-signin-password', 'wrong-password-1');
      await pageB.click('#acct-signin-form button[type=submit]');
      await pageB.waitForFunction(() => /incorrect/.test(document.getElementById('account-status').textContent));

      await pageB.fill('#acct-signin-password', PASSWORD);
      await pageB.click('#acct-signin-form button[type=submit]');
      await pageB.waitForFunction(() => !document.getElementById('acct-view-done').hidden, null, { timeout: 20_000 });
      assert.equal(await uidOf(pageB), trialUid);
      await pageB.click('#acct-done-close');
      await waitAccess(pageB, /Full game unlocked/);
      await shot(pageB, '06-restored-on-new-device');

      await step('sign out returns to a fresh anonymous identity', async () => {
        await pageB.click('#account-chip');
        await pageB.click('#acct-signout');
        await pageB.waitForFunction(() => document.getElementById('account-modal').hidden);
        await waitAccess(pageB, /Free trial/);
        assert.equal((await pageB.locator('#account-chip').textContent()).trim(), 'Sign in');
        const after = await uidOf(pageB);
        assert.ok(after && after !== trialUid);
      });

      await step('forgot password: neutral confirmation', async () => {
        await pageB.click('#account-chip');
        await pageB.click('#acct-view-signin [data-go=reset]');
        assert.equal(await modalView(pageB), 'reset');
        await pageB.fill('#acct-reset-email', email);
        await pageB.click('#acct-reset-form button[type=submit]');
        await pageB.waitForFunction(() => /reset link is on its way/.test(document.getElementById('account-status').textContent));
        await shot(pageB, '07-reset');
      });
      await ctxB.close();
    });

    await step('refund revokes the unlock', async () => {
      const r = await fetch(`http://127.0.0.1:${PAY_PORT}/__refund/${paidIntent.id}`, { method: 'POST' });
      assert.equal(r.status, 200);
      await page.reload();
      await waitAccess(page, /free trial is over/);
      const ent = await readDoc(`entitlements/${trialUid}`);
      assert.equal(ent.fields.active.booleanValue, false);
    });

    await step('no unexpected console errors', async () => {
      // The Auth emulator rejecting the wrong password, the failed orders and
      // a dismissed checkout are expected network errors, not page faults.
      const unexpected = consoleErrors.filter((e) => !/status of 4\d\d|Failed to load resource/.test(e));
      assert.deepEqual(unexpected, []);
    });

    await ctxA.close();
  } finally {
    await browser.close().catch(() => {});
    await pay.close().catch(() => {});
    killTree(vite);
    if (results.some((r) => !r.ok)) console.log(`\n--- vite output ---\n${vite.output().slice(-3000)}`);
  }
}

const started = Date.now();
// Every wait above has its own timeout; this is the backstop for a hang
// nobody anticipated, so a stuck run fails instead of sitting forever.
setTimeout(() => {
  console.log('\n✗ e2e watchdog: no result after 5 minutes — aborting');
  process.exit(1);
}, 5 * 60_000).unref();
main().then(() => {
  console.log(`\n${results.length} passed (${((Date.now() - started) / 1000).toFixed(1)} s) — screenshots in ${ARTIFACTS}`);
  process.exit(0);
}, () => {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
});
