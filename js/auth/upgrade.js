// Anonymous → permanent account, plus the two write paths behind the
// post-session panel (feedback, early-access signup).
//
// ── WHY LINK RATHER THAN STORE AN EMAIL STRING ──────────────────────────────
//
// linkWithPopup UPGRADES the existing anonymous account in place: the uid does
// not change. Everything already written under that uid —
// sessions/{uid}/runs/*, feedback/{uid}/items/* — stays attached, with no
// merge job and no orphaned analytics. firestore.rules needs no special case
// either, because request.auth.uid is identical either side of the upgrade;
// even a live multiplayer room survives it. A separately-stored email would
// have bought none of that.
//
// It also outlives a cleared browser profile or a second headset, which an
// anonymous uid does not — and that is the whole point of an early-access
// list that has to still work on launch day.
//
// ── THE TWO PATHS ───────────────────────────────────────────────────────────
//
//   Google  — full upgrade. Two taps, a verified address, and a real account.
//             The primary CTA: typing an email on the Quest floating keyboard
//             costs enough conversion to matter.
//   Manual  — records the typed address against the anonymous uid WITHOUT
//             upgrading it. Deliberate: the passwordless email-link flow needs
//             the player to leave for their inbox and come back, which is a
//             worse trade in a headset than simply keeping the address. These
//             rows are marked method:'manual' so the difference is visible
//             when the list is exported.
//
// ── QUEST BROWSER ───────────────────────────────────────────────────────────
//
// Only ever call linkGoogle() from the 2D overlay AFTER the XR session has
// ended. A popup cannot be presented from inside an immersive session, and
// popup support in the Quest browser is the main execution risk here — if it
// proves unreliable, the fallback is linkWithRedirect (costs page state) and
// the shape of this module does not change.

import { getAuth_, getDb, ensureAnonymousAuth } from '../network/firebaseClient.js';

const MAX_TEXT = 2000;

// Deliberately loose. Real validation is the confirmation mail we are not
// sending yet; a regex that rejects a valid address is worse than one that
// lets a typo through, and firestore.rules caps the length either way.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  const s = String(value || '').trim();
  return s.length > 3 && s.length <= 254 && EMAIL_RE.test(s);
}

/**
 * Upgrade the current anonymous account to a permanent Google one.
 *
 * @returns {Promise<{uid: string, email: string|null, merged: boolean}>}
 *   `merged` is true when the Google account was already attached to a
 *   DIFFERENT anonymous uid and we signed into that one instead.
 */
export async function linkGoogle() {
  const [{ GoogleAuthProvider, linkWithPopup, signInWithCredential }] =
    await Promise.all([import('firebase/auth')]);

  // Guarantees an anonymous account exists to upgrade. A player who only ever
  // played solo may not have one yet at this point.
  await ensureAnonymousAuth();
  const auth = getAuth_();
  const previousUid = auth.currentUser ? auth.currentUser.uid : null;

  const provider = new GoogleAuthProvider();
  try {
    const cred = await linkWithPopup(auth.currentUser, provider);
    return { uid: cred.user.uid, email: cred.user.email || null, merged: false };
  } catch (err) {
    const code = err && err.code;
    // The player already linked this Google account from another headset, or
    // after clearing storage. Unhandled, this both dead-ends the sign-in and
    // silently strands whatever they did in THIS session — so adopt the
    // existing account and leave a breadcrumb pointing at the uid we left
    // behind, which is enough to stitch the rows together server-side later.
    if (code === 'auth/credential-already-in-use'
        || code === 'auth/email-already-in-use') {
      const credential = GoogleAuthProvider.credentialFromError(err);
      if (!credential) throw err;
      const signedIn = await signInWithCredential(auth, credential);
      return {
        uid: signedIn.user.uid,
        email: signedIn.user.email || null,
        merged: true,
        previousUid,
      };
    }
    throw err;
  }
}

/** Human-readable reason for a failed link, for the panel's status line. */
export function friendlyAuthError(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window — allow popups for this site and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/network-request-failed':
      return 'Network problem during sign-in — check your connection and try again.';
    case 'auth/operation-not-allowed':
      // Almost always the Google provider not enabled in Identity Platform.
      return 'Google sign-in is not available right now. Try the email option instead.';
    default:
      return 'Sign-in failed — try the email option instead.';
  }
}

/**
 * Record early-access interest. One row per account: the doc id is the uid, so
 * a second submit overwrites nothing and is refused by the rules — which is
 * the intended "already on the list" outcome, not an error to surface.
 *
 * @param {string} email
 * @param {'google'|'manual'} method
 * @param {string|null} previousUid  set when linkGoogle() had to merge
 */
export async function saveSignup(email, method, previousUid = null) {
  const address = String(email || '').trim();
  if (!isValidEmail(address)) throw new Error('INVALID_EMAIL');

  const [fs] = await Promise.all([import('firebase/firestore')]);
  const user = await ensureAnonymousAuth();
  const ref = fs.doc(getDb(), 'signups', user.uid);
  await fs.setDoc(ref, {
    email: address,
    method,
    createdAt: fs.serverTimestamp(),
    ...(previousUid ? { mergedFrom: previousUid } : {}),
  });
  return user.uid;
}

/**
 * One feedback item. Rating and text are both optional on their own — the
 * in-XR card sends a rating with no text, the 2D panel can send either.
 *
 * @param {{rating?: number|null, text?: string, context?: object}} item
 */
export async function saveFeedback({ rating = null, text = '', context = null } = {}) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  const score = Number.isFinite(rating) ? Math.max(1, Math.min(5, Math.round(rating))) : null;
  if (score === null && !clean) return null; // nothing to say

  const [fs] = await Promise.all([import('firebase/firestore')]);
  const user = await ensureAnonymousAuth();
  const col = fs.collection(getDb(), 'feedback', user.uid, 'items');
  const payload = { createdAt: fs.serverTimestamp() };
  if (score !== null) payload.rating = score;
  if (clean) payload.text = clean;
  if (context && typeof context === 'object') payload.context = context;
  const written = await fs.addDoc(col, payload);
  return written.id;
}
