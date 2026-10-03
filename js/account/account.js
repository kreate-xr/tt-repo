// Accounts and the lifetime unlock, browser side. Lazy-loaded by
// js/ui/accountPanel.js — it pulls in Firebase Auth/Firestore, which must stay
// out of the startup bundle (see vite.config.js chunkSizeWarningLimit).
//
// ── IDENTITY ────────────────────────────────────────────────────────────────
//
// Everyone starts anonymous (js/network/firebaseClient.js) and the free trial
// is metered against that uid. Creating an account LINKS email/password onto
// the same uid (linkWithCredential), so the trial already used, and any beta
// rows, stay with the player. Signing IN to an existing account switches to
// that account's uid instead — the anonymous trial uid is simply left behind.
//
// Email/password only, deliberately: no popup or redirect (the reason the
// Google link was dropped before — js/data/submissions.js), nothing to pay per
// sign-in (SMS). The phone number PayLayer needs is asked at checkout only.
//
// ── PURCHASE ────────────────────────────────────────────────────────────────
//
// POST /api/orders creates the PayLayer intent (server decides the price),
// PayLayer's SDK opens Razorpay Checkout, and the game unlocks when the
// webhook writes entitlements/{uid} — watched live here, never inferred from
// the browser callback.

import {
  EmailAuthProvider, linkWithCredential, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut as fbSignOut, sendPasswordResetEmail,
  sendEmailVerification,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { getFirebaseAuth, getDb, ensureAnonymousAuth } from '../network/firebaseClient.js';
import { fetchMe, postOrder, ApiError } from './api.js';

const PAYLAYER_URL = typeof __PAYLAYER_URL__ !== 'undefined' ? __PAYLAYER_URL__ : '';
const ENTITLEMENT_WAIT_MS = 90_000;

// ── access state ────────────────────────────────────────────────────────────

let access = null;
const listeners = new Set();

function publish(next) {
  access = next;
  for (const fn of listeners) {
    try { fn(access); } catch (err) { console.error('[account] listener failed:', err); }
  }
}

/**
 * Latest known access. null until the first /api/me answer.
 * { entitled, remainingSec, signedIn, email, emailVerified, hasCheckoutProfile }
 */
export function getAccess() { return access; }

export function subscribe(fn) {
  listeners.add(fn);
  if (access) fn(access);
  return () => listeners.delete(fn);
}

export async function refreshAccess() {
  const me = await fetchMe();
  publish({
    entitled: me.entitled === true,
    remainingSec: me.trial ? me.trial.remainingSec : 0,
    signedIn: !me.account.anonymous,
    email: me.account.email,
    emailVerified: me.account.emailVerified,
    hasCheckoutProfile: me.account.hasCheckoutProfile,
  });
  return access;
}

// ── auth ────────────────────────────────────────────────────────────────────

/** Firebase Auth error → a sentence a player can act on. */
export function authErrorMessage(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return 'An account with this email already exists — sign in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect.';
    case 'auth/invalid-email':
      return 'That email address does not look right.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Choose a stronger password (at least 8 characters).';
    case 'auth/too-many-requests':
      return 'Too many attempts — wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'No connection — check your network and try again.';
    case 'auth/requires-recent-login':
      return 'Please sign in again.';
    default:
      return 'Something went wrong — please try again.';
  }
}

/**
 * Create an account. Upgrades the current anonymous user in place when there
 * is one, so the trial clock and uid carry over.
 */
export async function signUp(email, password) {
  const auth = getFirebaseAuth();
  await auth.authStateReady();
  const current = auth.currentUser;
  let user;
  if (current && current.isAnonymous) {
    const cred = EmailAuthProvider.credential(email, password);
    user = (await linkWithCredential(current, cred)).user;
  } else {
    user = (await createUserWithEmailAndPassword(auth, email, password)).user;
  }
  // The email claim the backend checks appears only on a fresh ID token.
  await user.getIdToken(true);
  // Best effort: a typo'd address is the one way to lose a paid account (the
  // reset mail would go nowhere), so nudge them to confirm it.
  sendEmailVerification(user).catch((err) => console.warn('[account] verification mail failed:', err && err.code));
  return refreshAccess();
}

export async function signIn(email, password) {
  const auth = getFirebaseAuth();
  await signInWithEmailAndPassword(auth, email, password);
  return refreshAccess();
}

export async function signOut() {
  await fbSignOut(getFirebaseAuth());
  // Back to an anonymous identity, as on a first visit.
  await ensureAnonymousAuth();
  return refreshAccess();
}

/** Always resolves the same way, so the form cannot be used to probe accounts. */
export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email);
  } catch (err) {
    if (err && (err.code === 'auth/invalid-email' || err.code === 'auth/network-request-failed')) throw err;
  }
}

// ── purchase ────────────────────────────────────────────────────────────────

let paySdk = null;

function loadPaySdk() {
  if (window.Pay) return Promise.resolve(window.Pay);
  if (!PAYLAYER_URL) return Promise.reject(new Error('VITE_PAYLAYER_URL is not configured'));
  if (!paySdk) {
    paySdk = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${PAYLAYER_URL.replace(/\/+$/, '')}/sdk/v1/pay.js`;
      s.async = true;
      s.onload = () => (window.Pay ? resolve(window.Pay) : reject(new Error('Payment SDK unavailable')));
      s.onerror = () => { paySdk = null; s.remove(); reject(new Error('Could not load the payment page')); };
      document.head.appendChild(s);
    });
  }
  return paySdk;
}

/** Resolves true once entitlements/{uid} is active, false on timeout. */
function waitForEntitlement(uid, timeoutMs = ENTITLEMENT_WAIT_MS) {
  return new Promise((resolve) => {
    let unsub = () => {};
    const timer = setTimeout(() => { unsub(); resolve(false); }, timeoutMs);
    unsub = onSnapshot(doc(getDb(), 'entitlements', uid), (snap) => {
      if (snap.exists() && snap.data().active === true) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    }, () => { /* permission/network: the timeout decides */ });
  });
}

/**
 * Pay for the lifetime unlock.
 * @returns {Promise<'unlocked'|'pending'>} 'pending' = paid at Razorpay but the
 *          confirmation has not reached us yet (the webhook will still land).
 * @throws ApiError (e.g. already_owned, invalid_phone) or the SDK's PayError
 *         ('dismissed' when the player closes Checkout).
 */
export async function buyFullGame({ name, phone }) {
  const auth = getFirebaseAuth();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || user.isAnonymous && !user.email) throw new ApiError(403, 'account_required');

  const [order, Pay] = await Promise.all([postOrder({ name, phone }), loadPaySdk()]);
  await Pay.checkout({ intentId: order.intentId, clientSecret: order.clientSecret });
  const unlocked = await waitForEntitlement(user.uid);
  await refreshAccess().catch(() => {});
  return unlocked ? 'unlocked' : 'pending';
}
