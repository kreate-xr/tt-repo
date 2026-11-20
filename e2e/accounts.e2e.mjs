// End-to-end: accounts, the free version and the lifetime unlock, driven through
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
    // 'intro' is the static copy in index.html: wait for the /api/me answer.
    return el && line && !line.hidden && line.dataset.state !== 'intro'
      && new RegExp(src).test(el.textContent);
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

    let uidA;
    await step('first visit: anonymous, free version shown — no clock, full-game items marked', async () => {
      await page.goto(APP_URL);
      await waitAccess(page, /Free to play/);
      assert.doesNotMatch(await page.locator('#access-line').textContent(), /trial|of play left/i);
      assert.equal((await page.locator('#account-chip').textContent()).trim(), 'Sign in');
      assert.equal(await page.locator('#access-buy').isVisible(), true);
      const arena = page.locator('.enter-venue[data-mode="vr-arena"]');
      assert.match(await arena.getAttribute('class'), /\blocked\b/);
      assert.match(await arena.locator('.venue-sub').textContent(), /full game/);
      assert.doesNotMatch(await page.locator('.enter-venue[data-mode="ar"]').getAttribute('class'), /\blocked\b/);
      assert.match(await page.locator('#create-room').textContent(), /full game/);
      uidA = await uidOf(page);
      assert.ok(uidA, 'anonymous uid');
      await shot(page, '01-landing-free');
    });

    await step('free play is never metered: a lease is answered and nothing is written', async () => {
      const r = await page.evaluate(async () => {
        const api = await import('/js/account/api.js');
        const a = await api.postLease('start');
        await new Promise((res) => setTimeout(res, 1100));
        const b = await api.postLease('end');
        return { a, b };
      });
      assert.deepEqual(r.a, { entitled: false, metered: false, leaseSec: 60, remainingSec: 600 });
      assert.deepEqual(r.b, r.a);
      assert.equal(await readDoc(`users/${uidA}`), null, 'no user doc for a free player');
    });

    await step('free venues pass the gate (reach the WebXR check)', async () => {
      for (const mode of ['ar', 'vr-focus']) {
        await page.evaluate(() => { document.getElementById('status').textContent = ''; });
        await page.click(`.enter-venue[data-mode="${mode}"]`);
        await page.waitForFunction(() => /WebXR not available|not supported on this device/.test(document.getElementById('status').textContent));
        assert.equal(await modalView(page), null, mode);
      }
    });

    await step('hosting a room opens the unlock dialog; no room is created', async () => {
      await page.click('#create-room');
      await page.waitForFunction(() => !document.getElementById('account-modal').hidden);
      assert.equal(await modalView(page), 'signup');
      assert.match(await page.locator('#account-sub').textContent(), /Hosting a room is in the full game/);
      assert.doesNotMatch(await page.locator('#multiplayer-status').textContent(), /Room code/);
      await page.keyboard.press('Escape');
      assert.equal(await modalView(page), null);
    });

    await step('the Arena opens the unlock dialog on the free version', async () => {
      await page.click('.enter-venue[data-mode="vr-arena"]');
      await page.waitForFunction(() => !document.getElementById('account-modal').hidden);
      assert.equal(await modalView(page), 'signup');
      assert.match(await page.locator('#account-sub').textContent(), /The Arena is in the full game/);
      // No stadium download started behind the dialog.
      assert.equal(await page.locator('#loading').isVisible(), false);
      await shot(page, '02-unlock-signup');
    });

    await step('create account: short password rejected client-side', async () => {
      await page.fill('#acct-signup-email', email);
      await page.fill('#acct-signup-password', 'short');
      await page.click('#acct-signup-form button[type=submit]');
      assert.match(await page.locator('#account-status').textContent(), /at least 8 characters/);
    });

    await step('create account links the anonymous uid (same uid, now with email)', async () => {
      await page.fill('#acct-signup-password', PASSWORD);
      await page.click('#acct-signup-form button[type=submit]');
      await page.waitForFunction(() => !document.getElementById('acct-view-buy').hidden, null, { timeout: 20_000 });
      assert.equal(await uidOf(page), uidA, 'linkWithCredential must keep the uid');
      assert.equal((await page.locator('#account-chip').textContent()).trim(), email);
      assert.equal((await page.locator('#acct-buy-price').textContent()).trim(), '₹1,997');
      // The price and the button follow the phone typed: +91 → INR, else USD.
      await page.fill('#acct-buy-phone', '+1 415 555 0100');
      assert.equal((await page.locator('#acct-buy-price').textContent()).trim(), '$19.97');
      assert.equal((await page.locator('#acct-buy-submit').textContent()).trim(), 'Pay $19.97');
      await page.fill('#acct-buy-phone', '+91 98765 43210');
      assert.equal((await page.locator('#acct-buy-submit').textContent()).trim(), 'Pay ₹1,997');
      await page.fill('#acct-buy-phone', '');
      await shot(page, '03-buy-form');
    });

    await step('paywall fits a short (zoomed) viewport without scrolling', async () => {
      // About a 1280x860 window at 150% zoom — the report behind the compact layout.
      await page.setViewportSize({ width: 853, height: 573 });
      const fit = await page.evaluate(() => {
        const d = document.querySelector('#account-modal .modal');
        return { scroll: d.scrollHeight, client: d.clientHeight, top: d.getBoundingClientRect().top };
      });
      assert.ok(fit.scroll <= fit.client, `dialog scrolls: ${fit.scroll} > ${fit.client}`);
      assert.ok(fit.top >= 0, 'dialog top is off-screen');
      await shot(page, '03b-buy-form-zoomed');
      await page.setViewportSize({ width: 1280, height: 860 });
    });

    await step('checkout: Pay stays disabled until the consent box is ticked', async () => {
      const consent = page.locator('#acct-buy-consent');
      const payBtn = page.locator('#acct-buy-submit');
      assert.equal(await consent.isChecked(), false, 'unticked by default');
      assert.equal(await payBtn.isDisabled(), true);
      assert.match(await page.locator('label.acct-consent').textContent(),
        /I agree that the game unlocks immediately after payment and that I lose my 14-day right of withdrawal once it does\./);
      assert.equal((await page.locator('.acct-refund-terms').textContent()).trim(),
        "Refunds: within 3 days of purchase if you've played less than 2 hours since buying, less the payment gateway's processing charges (around 2–3%). A refund removes the unlock. One refund per account.");
      assert.match(await page.locator('.acct-legal').textContent(), /By paying you agree to our/);
      await consent.check();
      assert.equal(await payBtn.isDisabled(), false);
      await consent.uncheck();
      assert.equal(await payBtn.isDisabled(), true);
      await consent.check();
      await shot(page, '03c-buy-consent');
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
      assert.equal(paidIntent.amount, 199700);
      assert.equal(paidIntent.currency, 'INR');
      assert.deepEqual(paidIntent.customer, { name: 'Asha Rao', email, contact: '+919876543210' });
      assert.equal(paidIntent.idempotencyKey, paidIntent.siteReference);
      const ent = await readDoc(`entitlements/${uidA}`);
      assert.equal(ent.fields.active.booleanValue, true);
      // The refund's two hours count from the purchase; nothing was played before it.
      assert.equal(ent.fields.playAtGrantMs.integerValue, '0');
      await shot(page, '04-unlocked');
      await page.click('#acct-done-close');
      await waitAccess(page, /Full game unlocked/);
      assert.equal(await page.locator('#access-buy').isVisible(), false);
      await shot(page, '05-landing-unlocked');
    });

    await step('unlocked: the full-game markers are gone and venues pass the gate', async () => {
      const arena = page.locator('.enter-venue[data-mode="vr-arena"]');
      assert.doesNotMatch(await arena.getAttribute('class'), /\blocked\b/);
      assert.equal((await arena.locator('.venue-sub').textContent()).trim(), 'stadium VR');
      assert.equal((await page.locator('#create-room').textContent()).trim(), 'Create Multiplayer Room');
      await page.evaluate(() => { document.getElementById('status').textContent = ''; });
      await page.click('.enter-venue.primary');
      await page.waitForFunction(() => /WebXR not available|not supported on this device/.test(document.getElementById("status").textContent));
      assert.equal(await modalView(page), null);
      // The tier the in-headset menus read survives a reload.
      assert.equal(await page.evaluate(() => localStorage.getItem('tt.fullVersion')), '1');
    });

    await step('account view shows the unlock; buying again is refused', async () => {
      await page.click('#account-chip');
      assert.equal(await modalView(page), 'account');
      assert.match(await page.locator('#acct-status-line').textContent(), /Full game unlocked/);
      assert.equal(await page.locator('#acct-buy').isVisible(), false);
      const r = await page.evaluate(async () => {
        const api = await import('/js/account/api.js');
        const order = async (consent) => {
          try { await api.postOrder({ name: 'A', phone: '+919876543210', consent }); return 'created'; } catch (e) { return e.code; }
        };
        const me = await api.fetchMe();
        return { owned: await order(true), noConsent: await order(undefined), metered: me.metered, refund: me.refund };
      });
      assert.equal(r.owned, 'already_owned');
      // The server re-checks consent; the browser's checkbox is not enough.
      assert.equal(r.noConsent, 'consent_required');
      // Refundable, so paid play is metered.
      assert.equal(r.metered, true);
      assert.equal(r.refund.eligible, true);
      assert.match(await page.locator('#acct-refund-note').textContent(), /Refund available until/);
      assert.equal(await page.locator('#acct-refund-btn').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await modalView(page), null);
    });

    await step('new device: free version, then sign-in restores the purchase', async () => {
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const pageB = await ctxB.newPage();
      await pageB.goto(APP_URL);
      await waitAccess(pageB, /Free to play/);
      const anonB = await uidOf(pageB);
      assert.notEqual(anonB, uidA);

      await pageB.click('#account-chip');
      assert.equal(await modalView(pageB), 'signin');
      await pageB.fill('#acct-signin-email', email);
      await pageB.fill('#acct-signin-password', 'wrong-password-1');
      await pageB.click('#acct-signin-form button[type=submit]');
      await pageB.waitForFunction(() => /incorrect/.test(document.getElementById('account-status').textContent));

      await pageB.fill('#acct-signin-password', PASSWORD);
      await pageB.click('#acct-signin-form button[type=submit]');
      await pageB.waitForFunction(() => !document.getElementById('acct-view-done').hidden, null, { timeout: 20_000 });
      assert.equal(await uidOf(pageB), uidA);
      await pageB.click('#acct-done-close');
      await waitAccess(pageB, /Full game unlocked/);
      await shot(pageB, '06-restored-on-new-device');

      await step('sign out returns to a fresh anonymous identity', async () => {
        await pageB.click('#account-chip');
        await pageB.click('#acct-signout');
        await pageB.waitForFunction(() => document.getElementById('account-modal').hidden);
        await waitAccess(pageB, /Free to play/);
        assert.equal((await pageB.locator('#account-chip').textContent()).trim(), 'Sign in');
        const after = await uidOf(pageB);
        assert.ok(after && after !== uidA);
        // Signing out takes the full version off this browser too.
        assert.equal(await pageB.evaluate(() => localStorage.getItem('tt.fullVersion')), null);
        assert.match(await pageB.locator('.enter-venue[data-mode="vr-arena"] .venue-sub').textContent(), /full game/);
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

    await step('self-service refund: two taps, unlock removed, refund.processed finalises', async () => {
      await page.click('#account-chip');
      assert.equal(await modalView(page), 'account');
      const btn = page.locator('#acct-refund-btn');
      await btn.click();
      assert.match(await btn.textContent(), /Tap again to confirm/);
      assert.equal(pay.refunds.length, 0, 'the first tap only asks to confirm');
      await btn.click();
      await page.waitForFunction(() => /Refund of /.test(document.getElementById('account-status').textContent), null, { timeout: 20_000 });
      // 199700 paise paid; the fake gateway keeps 2.36 %.
      assert.match(await page.textContent('#account-status'),
        /Refund of ₹1,949\.88 to your original payment method \(₹47\.12 payment processing charges deducted\) initiated/);
      assert.equal(pay.refunds.length, 1);
      assert.equal(pay.refunds[0].intentId, paidIntent.id);
      assert.equal(pay.refunds[0].idempotencyKey, `refund-${paidIntent.id}`);
      assert.equal(pay.refunds[0].body.amount, undefined);
      await shot(page, '08-refund-requested');

      // The webhook lands just after: refundUsed is set, the unlock stays off.
      const end = Date.now() + 15_000;
      let user;
      while (Date.now() < end) {
        user = await readDoc(`users/${uidA}`);
        if (user && user.fields.refundUsed && user.fields.refundUsed.booleanValue) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(user.fields.refundUsed.booleanValue, true);
      const ent = await readDoc(`entitlements/${uidA}`);
      assert.equal(ent.fields.active.booleanValue, false);

      await page.keyboard.press('Escape');
      await page.reload();
      await waitAccess(page, /Free to play/);
      // Back on the free version: the Arena is marked again.
      assert.match(await page.locator('.enter-venue[data-mode="vr-arena"] .venue-sub').textContent(), /full game/);
      await page.click('#account-chip');
      assert.match(await page.locator('#acct-refund-note').textContent(), /was refunded/);
      assert.equal(await page.locator('#acct-refund-btn').isVisible(), false);
      await shot(page, '09-refunded');
      await page.keyboard.press('Escape');
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
