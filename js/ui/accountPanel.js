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
// charged, from the phone number entered at checkout.
const PRICE_LABEL = '₹499 in India · $9.99 everywhere else';

let els = null;
let accountMod = null;
let loading = null;
let access = null;
let view = 'signin';
let busy = false;
let lastFocused = null;
// Why the modal was opened for a purchase, shown above the form.
let buyReason = '';

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
  if (!access) {
    els.line.hidden = true;
    return;
  }
  els.line.hidden = false;
  if (access.entitled) {
    els.lineText.textContent = 'Full game unlocked — thanks for your support!';
    els.lineBuy.hidden = true;
  } else if (access.remainingSec > 0) {
    els.lineText.textContent = `Free trial: ${formatClock(access.remainingSec)} of play left.`;
    els.lineBuy.hidden = false;
    els.lineBuy.textContent = 'Unlock full game';
  } else {
    els.lineText.textContent = 'Your free trial is over.';
    els.lineBuy.hidden = false;
    els.lineBuy.textContent = 'Unlock the full game';
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
    signup: 'Create your account',
    reset: 'Reset your password',
    account: 'Your account',
    buy: 'Unlock the full game',
    done: "You're all set!",
  };
  els.title.textContent = titles[view] || '';
  // The reason the paywall opened stays visible through the account steps
  // in front of checkout, not just on the checkout form itself.
  const inPurchase = view === 'buy' || ((view === 'signup' || view === 'signin') && buyReason);
  els.sub.textContent = inPurchase ? (buyReason || 'One payment, yours for life.') : '';

  if (view === 'account') {
    els.accountEmail.textContent = signedIn ? access.email : '';
    els.accountStatus.textContent = access && access.entitled
      ? 'Full game unlocked.'
      : `Free trial: ${formatClock(access ? access.remainingSec : 0)} of play left.`;
    els.accountBuy.hidden = !!(access && access.entitled);
    els.accountVerify.hidden = !(signedIn && !access.emailVerified);
  }
  if (view === 'buy') {
    els.buyPrice.textContent = PRICE_LABEL;
    els.buyEmail.textContent = signedIn ? access.email : '';
  }
  for (const b of els.busyButtons) b.disabled = busy;
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
    case 'invalid_phone': return 'Enter your phone number with the country code, e.g. +919876543210.';
    case 'invalid_name': return 'Enter your name as it should appear on the receipt.';
    case 'account_required': return 'Create an account or sign in first.';
    case 'payment_unavailable': return 'Payments are unavailable right now — please try again shortly.';
    case 'network_error': return 'No connection — check your network and try again.';
    case 'dismissed': return 'Checkout closed — nothing was charged.';
    default: return (err && err.message) || 'Something went wrong — please try again.';
  }
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
    run(async (m) => {
      setStatus('Opening secure checkout…');
      const result = await m.buyFullGame({
        name: value(els.buyName),
        phone: value(els.buyPhone).replace(/[\s-]/g, ''),
      });
      if (result === 'unlocked') {
        go('done');
      } else {
        setStatus('Payment received — confirming it can take a minute. The game unlocks automatically.');
      }
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
  startPurchase('Your 10-minute free trial is over. Unlock the full game to keep playing.');
  return false;
}

/** Called by js/modes/inGame.js when the trial ran out inside the headset. */
export function showTrialOver(reason) {
  const text = reason === 'ip_limit'
    ? 'Too many free trials have started from this network today. Unlock the full game to play now.'
    : 'Your 10-minute free trial is over. Unlock the full game to keep playing.';
  loadAccount().then((m) => m.refreshAccess()).catch(() => {});
  startPurchase(text);
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
    signout: $('acct-signout'),
    buyForm: $('acct-buy-form'),
    buyName: $('acct-buy-name'),
    buyPhone: $('acct-buy-phone'),
    buyPrice: $('acct-buy-price'),
    buyEmail: $('acct-buy-email'),
    doneClose: $('acct-done-close'),
  };
  els.busyButtons = Array.from(modal.querySelectorAll('button[type=submit], #acct-signout'));
  if (els.dialog) els.dialog.tabIndex = -1;
  wireForms();

  if (els.chip) {
    els.chip.addEventListener('click', () => open(access && access.signedIn ? 'account' : 'signin'));
  }
  if (els.lineBuy) els.lineBuy.addEventListener('click', () => startPurchase(''));

  // First /api/me on an idle moment: never on the path of the first paint or
  // of the venue buttons arming.
  const kick = () => refreshAccessSoon();
  if ('requestIdleCallback' in window) window.requestIdleCallback(kick, { timeout: 2000 });
  else setTimeout(kick, 300);
}
