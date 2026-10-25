// Landing-page side of accounts and the paywall: the nav account button, the
// trial / unlock line under the venue buttons, and one modal with every step
// (sign in, create account, reset password, checkout, done).
//
// Everything Firebase lives in js/account/account.js, imported lazily on the
// first idle moment after load — this module itself is in the startup bundle
// and must not pull the SDK in with it.
//
// The ENTRY GATE (canEnter) is synchronous on purpose: requestSession has to
// run inside the click's short user-activation window, which a network round
// trip could eat. So the gate reads the last /api/me answer and fails OPEN
// while that is unknown — the in-session trial clock (js/account/trialClock.js)
// closes the gap within one lease if the trial was in fact used up.

// Display only — the backend (functions/src/pricing.js) decides what is
// charged, from the phone number entered at checkout. Keep in step.
const PRICE_INR = '₹1,997';
const PRICE_USD = '$19.97';

/** The line under a price: the INR price includes GST, the USD price carries none. */
export function priceNote(price) {
  return price === PRICE_INR ? 'incl. GST · one-time · lifetime' : 'one-time · lifetime';
}

/** What the phone typed so far will be charged: +91 → INR, any other country code → USD. */
export function displayPrice(phone) {
  const p = String(phone || '').replace(/[\s-]/g, '');
  if (!p.startsWith('+') || p.length < 3) return PRICE_INR;
  return p.startsWith('+91') ? PRICE_INR : PRICE_USD;
}

/**
 * Best guess at what a visitor will pay, for the landing-page offer before
 * any phone is typed: an Indian time zone shows rupees, anywhere else dollars.
 * A guess only — checkout follows the phone number (displayPrice).
 */
export function guessPrice(timeZone) {
  let tz = timeZone;
  if (tz === undefined) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = ''; }
  }
  if (!tz) return PRICE_INR;
  return tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' ? PRICE_INR : PRICE_USD;
}

/** Pay stays disabled until the consent box is ticked (and while a request runs). */
export function payDisabled({ busy, consent }) {
  return !!busy || consent !== true;
}

// Why a refund is not available, for the account screen. Codes come from
// /api/me (functions/src/playtime.js refundBlock); the server decides.
const REFUND_REASONS = {
  refund_in_progress: 'Your refund is being processed. The unlock has been removed.',
  already_refunded: 'This purchase was refunded.',
  refund_used: 'Refund not available: this account has already used its one refund.',
  refund_window_expired: 'Refund not available: the 3-day refund window has passed.',
  played_too_long: 'Refund not available: refunds are only for less than 2 hours of play.',
};

/**
 * The refund block on the account screen: whether to show the button, and
 * the line above it. `refund` is /api/me's (null = never bought).
 * @returns {{ show: boolean, button: boolean, note: string }}
 */
export function refundState(refund, formatDate = (d) => d.toLocaleString()) {
  if (!refund) return { show: false, button: false, note: '' };
  if (refund.eligible) {
    const until = refund.refundableUntil ? new Date(refund.refundableUntil) : null;
    return {
      show: true,
      button: true,
      note: until ? `Refund available until ${formatDate(until)}.` : 'Refund available.',
    };
  }
  const note = REFUND_REASONS[refund.reason];
  return note ? { show: true, button: false, note } : { show: false, button: false, note: '' };
}

// Mirrors functions/src/trial.js TRIAL_MS, for the meter only.
const TRIAL_SEC = 10 * 60;
// The refund button asks twice: a refund takes the game away.
const REFUND_CONFIRM_MS = 6000;

let els = null;
let accountMod = null;
let loading = null;
let access = null;
let view = 'signin';
let busy = false;
let lastFocused = null;
// Why the modal was opened for a purchase, shown above the form.
let buyReason = '';
let refundConfirmUntil = 0;
let refundConfirmTimer = null;

function $(id) { return document.getElementById(id); }

function loadAccount() {
  if (!loading) {
    loading = import('../account/account.js').then((m) => {
      accountMod = m;
      m.subscribe((next) => { access = next; render(); });
      return m;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── page chrome ─────────────────────────────────────────────────────────────

function renderChrome() {
  if (!els) return;
  const signedIn = !!(access && access.signedIn);
  if (els.chip) {
    els.chip.textContent = signedIn ? access.email : 'Sign in';
    els.chip.title = signedIn ? 'Your account' : 'Sign in or create an account';
  }
  if (!els.line) return;
  // No answer yet (or no backend): the static intro copy in index.html stays.
  if (!access) return;
  let state, title, sub;
  if (access.entitled) {
    state = 'owned';
    title = 'Full game unlocked — thanks for your support!';
    sub = 'Unlimited play on any headset signed in to this account.';
  } else if (access.remainingSec > 0) {
    state = 'trial';
    title = `Free trial: ${formatClock(access.remainingSec)} of play left.`;
    sub = access.remainingSec >= TRIAL_SEC
      ? 'No sign-up needed. Only time in a rally counts — menus and setup are free.'
      : 'Enjoying it? Unlock unlimited play — pay once, keep it forever.';
  } else {
    state = 'over';
    title = 'Your free trial is over.';
    sub = 'Unlock the full game to keep playing — one payment, lifetime access.';
  }
  els.line.dataset.state = state;
  els.lineText.textContent = title;
  if (els.lineSub) els.lineSub.textContent = sub;
  if (els.lineCta) els.lineCta.hidden = state === 'owned';
  els.lineBuy.textContent = state === 'over' ? 'Unlock the full game' : 'Unlock full game';
  if (els.lineMeter) {
    els.lineMeter.hidden = state !== 'trial';
    const frac = Math.min(1, Math.max(0, access.remainingSec / TRIAL_SEC));
    if (els.lineMeterFill) els.lineMeterFill.style.width = `${(frac * 100).toFixed(1)}%`;
  }
}

// ── modal ───────────────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('error', !!isError);
}

function render() {
  renderChrome();
  if (!els || els.modal.hidden) return;
  for (const [name, node] of Object.entries(els.views)) node.hidden = name !== view;

  const signedIn = !!(access && access.signedIn);
  const titles = {
    signin: 'Sign in',
    signup: 'Create account',
    reset: 'Reset password',
    account: 'Your account',
    buy: 'Unlock full game',
    done: "You're all set!",
  };
  els.title.textContent = titles[view] || '';
  // The reason the paywall opened stays visible through the account steps
  // in front of checkout, not just on the checkout form itself.
  const inPurchase = view === 'buy' || ((view === 'signup' || view === 'signin') && buyReason);
  els.sub.textContent = inPurchase ? buyReason : '';

  if (view === 'account') {
    els.accountEmail.textContent = signedIn ? access.email : '';
    els.accountStatus.textContent = access && access.entitled
      ? 'Full game unlocked.'
      : `Free trial: ${formatClock(access ? access.remainingSec : 0)} of play left.`;
    els.accountBuy.hidden = !!(access && access.entitled);
    els.accountVerify.hidden = !(signedIn && !access.emailVerified);
    const refund = refundState(access && access.refund);
    els.refund.hidden = !refund.show;
    els.refundNote.textContent = refund.note;
    els.refundBtn.hidden = !refund.button;
    els.refundBtn.textContent = Date.now() < refundConfirmUntil
      ? 'Tap again to confirm: this removes the unlock'
      : 'Request a refund';
  }
  if (view === 'buy') {
    updateBuyPrice();
  }
  for (const b of els.busyButtons) b.disabled = busy;
  els.buySubmit.disabled = payDisabled({ busy, consent: els.buyConsent.checked });
}

function go(next) {
  view = next;
  setStatus('');
  render();
  const first = els.views[view] && els.views[view].querySelector('input:not([type=hidden])');
  if (first && first.focus) first.focus();
}

function onKeydown(e) {
  if (e.key === 'Escape' && !busy) close();
}

function open(startView) {
  if (!els) return;
  lastFocused = document.activeElement;
  els.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown);
  go(startView);
}

function close() {
  if (!els || els.modal.hidden) return;
  els.modal.hidden = true;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKeydown);
  buyReason = '';
  if (lastFocused && lastFocused.focus) {
    try { lastFocused.focus(); } catch { /* element may be gone */ }
  }
  lastFocused = null;
}

/** Run one async form action with the buttons locked and errors shown. */
async function run(action) {
  if (busy) return;
  busy = true;
  setStatus('');
  render();
  try {
    await action(await loadAccount());
  } catch (err) {
    setStatus(friendlyError(err), true);
  } finally {
    busy = false;
    render();
  }
}

function friendlyError(err) {
  const code = (err && err.code) || '';
  if (code.startsWith('auth/') && accountMod) return accountMod.authErrorMessage(err);
  switch (code) {
    case 'already_owned': return 'You already own the full game.';
    case 'invalid_phone': return 'Add the country code, e.g. +91 98765 43210.';
    case 'invalid_name': return 'Enter your name.';
    case 'consent_required': return 'Tick the box to agree before paying.';
    case 'account_required': return 'Create an account or sign in first.';
    case 'payment_unavailable': return 'Payments are unavailable — try again shortly.';
    case 'network_error': return 'No connection — check your network and try again.';
    case 'dismissed': return 'Checkout closed — nothing was charged.';
    default: return (err && err.message) || 'Something went wrong — please try again.';
  }
}

function updateBuyPrice() {
  const price = displayPrice(els.buyPhone && els.buyPhone.value);
  if (els.buyPrice) els.buyPrice.textContent = price;
  if (els.buyPriceNote) els.buyPriceNote.textContent = priceNote(price);
  if (els.buySubmit) els.buySubmit.textContent = `Pay ${price}`;
}

function value(input) { return input ? input.value.trim() : ''; }

/** The purchase path: an account first, then the checkout form. */
function startPurchase(reason) {
  buyReason = reason || '';
  if (access && access.entitled) { open('account'); return; }
  open(access && access.signedIn ? 'buy' : 'signup');
}

function wireForms() {
  els.signinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async (m) => {
      const next = await m.signIn(value(els.signinEmail), els.signinPassword.value);
      els.signinPassword.value = '';
      go(next.entitled ? 'done' : (buyReason ? 'buy' : 'account'));
    });
  });

  els.signupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const password = els.signupPassword.value;
    if (password.length < 8) { setStatus('Choose a password of at least 8 characters.', true); return; }
    run(async (m) => {
      const next = await m.signUp(value(els.signupEmail), password);
      els.signupPassword.value = '';
      go(next.entitled ? 'done' : 'buy');
    });
  });

  els.resetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async (m) => {
      await m.resetPassword(value(els.resetEmail));
      setStatus('If that email has an account, a reset link is on its way.');
    });
  });

  els.buyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!els.buyConsent.checked) return;
    run(async (m) => {
      setStatus('Opening secure checkout…');
      const result = await m.buyFullGame({
        name: value(els.buyName),
        phone: value(els.buyPhone).replace(/[\s-]/g, ''),
        consent: els.buyConsent.checked,
      }, {
        // Checkout's own success is display only: the unlock waits for the server.
        onPaid: () => setStatus('Payment received, unlocking…'),
      });
      if (result === 'unlocked') {
        go('done');
      } else {
        setStatus('Payment received — unlocking shortly.');
      }
    });
  });

  els.buyPhone.addEventListener('input', updateBuyPrice);
  els.buyConsent.addEventListener('change', render);

  els.refundBtn.addEventListener('click', () => {
    if (busy) return;
    if (Date.now() >= refundConfirmUntil) {
      refundConfirmUntil = Date.now() + REFUND_CONFIRM_MS;
      clearTimeout(refundConfirmTimer);
      refundConfirmTimer = setTimeout(render, REFUND_CONFIRM_MS);
      render();
      return;
    }
    refundConfirmUntil = 0;
    run(async (m) => {
      setStatus('Requesting your refund…');
      await m.requestRefund();
      setStatus('Refund requested. The unlock has been removed and the payment goes back to your original payment method.');
    });
  });

  for (const b of els.modal.querySelectorAll('[data-go]')) {
    b.addEventListener('click', () => { if (!busy) go(b.dataset.go); });
  }
  els.accountBuy.addEventListener('click', () => go('buy'));
  els.signout.addEventListener('click', () => run(async (m) => { await m.signOut(); close(); }));
  els.doneClose.addEventListener('click', close);
  els.dismiss.addEventListener('click', () => { if (!busy) close(); });
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal && !busy) close(); });
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Synchronous entry gate for the venue buttons. false = the trial is used up
 * and the paywall was opened instead.
 */
export function canEnter() {
  if (!access || access.entitled || access.remainingSec > 0) return true;
  startPurchase('Your free trial has ended.');
  return false;
}

/** Called by js/modes/inGame.js when the trial ran out inside the headset. */
export function showTrialOver(reason) {
  const text = reason === 'ip_limit'
    ? 'Free trials from this network are used up today.'
    : 'Your free trial has ended.';
  loadAccount().then((m) => m.refreshAccess()).catch(() => {});
  startPurchase(text);
}

/**
 * Called by js/modes/inGame.js when paid play that is still refundable could
 * not reach the server for too long (js/account/trialClock.js fails closed).
 */
export function showReconnect() {
  loadAccount().then((m) => m.refreshAccess()).catch(() => {});
  open('account');
  setStatus('Reconnect to keep playing. While your purchase can still be refunded, '
    + 'play time has to reach our server.', true);
}

/** Last /api/me says paid play is metered (fail closed when offline). */
export function isPlayMetered() {
  return !!(access && access.metered);
}

/** Re-read access (e.g. after a session, when the trial clock moved). */
export function refreshAccessSoon() {
  loadAccount().then((m) => m.refreshAccess()).catch((err) => {
    console.warn('[account] could not refresh access:', err && (err.code || err.message));
  });
}

/** Idempotent DOM wiring. Safe to call when the markup is absent. */
export function wireAccountPanel() {
  const modal = $('account-modal');
  if (!modal || els) return;
  els = {
    modal,
    dialog: modal.querySelector('.modal'),
    dismiss: $('account-dismiss'),
    title: $('account-title'),
    sub: $('account-sub'),
    status: $('account-status'),
    chip: $('account-chip'),
    line: $('access-line'),
    lineText: $('access-text'),
    lineBuy: $('access-buy'),
    lineSub: $('access-sub'),
    lineCta: $('access-cta'),
    lineMeter: $('access-meter'),
    lineMeterFill: $('access-meter-fill'),
    views: {
      signin: $('acct-view-signin'),
      signup: $('acct-view-signup'),
      reset: $('acct-view-reset'),
      account: $('acct-view-account'),
      buy: $('acct-view-buy'),
      done: $('acct-view-done'),
    },
    signinForm: $('acct-signin-form'),
    signinEmail: $('acct-signin-email'),
    signinPassword: $('acct-signin-password'),
    signupForm: $('acct-signup-form'),
    signupEmail: $('acct-signup-email'),
    signupPassword: $('acct-signup-password'),
    resetForm: $('acct-reset-form'),
    resetEmail: $('acct-reset-email'),
    accountEmail: $('acct-email'),
    accountStatus: $('acct-status-line'),
    accountVerify: $('acct-verify-note'),
    accountBuy: $('acct-buy'),
    refund: $('acct-refund'),
    refundNote: $('acct-refund-note'),
    refundBtn: $('acct-refund-btn'),
    signout: $('acct-signout'),
    buyForm: $('acct-buy-form'),
    buyName: $('acct-buy-name'),
    buyPhone: $('acct-buy-phone'),
    buyPrice: $('acct-buy-price'),
    buyPriceNote: $('acct-buy-price-note'),
    buySubmit: $('acct-buy-submit'),
    buyConsent: $('acct-buy-consent'),
    doneClose: $('acct-done-close'),
  };
  els.busyButtons = Array.from(modal.querySelectorAll('button[type=submit], #acct-signout, #acct-refund-btn'));
  if (els.dialog) els.dialog.tabIndex = -1;
  wireForms();

  if (els.chip) {
    els.chip.addEventListener('click', () => open(access && access.signedIn ? 'account' : 'signin'));
  }
  if (els.lineBuy) els.lineBuy.addEventListener('click', () => startPurchase(''));
  const offerPrice = $('access-price');
  const offerNote = $('access-price-note');
  const guess = guessPrice();
  if (offerPrice) offerPrice.textContent = guess;
  if (offerNote) offerNote.textContent = priceNote(guess);

  // First /api/me on an idle moment: never on the path of the first paint or
  // of the venue buttons arming.
  const kick = () => refreshAccessSoon();
  if ('requestIdleCallback' in window) window.requestIdleCallback(kick, { timeout: 2000 });
  else setTimeout(kick, 300);
}
