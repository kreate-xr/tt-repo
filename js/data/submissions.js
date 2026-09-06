// The two things a player can send us from the post-session dialog: feedback,
// and an email address for the early-access list.
//
// ── WHY NO GOOGLE SIGN-IN ───────────────────────────────────────────────────
//
// An earlier cut upgraded the anonymous account with linkWithPopup, which had
// the nice property of preserving the uid. It is gone deliberately: a popup
// cannot be presented from inside an immersive session, its reliability in the
// Quest browser was never established, and it dragged in an auth-handler
// iframe (CSP frame-src), a third-party-cookie dependency on the authDomain,
// and a merge path for credential-already-in-use. That is a lot of moving
// parts and failure modes in front of "tell me when it launches".
//
// A typed address needs none of it. The row is still keyed by the anonymous
// uid, so it still joins to that player's sessions and feedback — we simply
// do not get a verified address or an identity that survives a storage clear.
// For a beta mailing list that is an acceptable trade.
//
// ── WRITE-ONLY ──────────────────────────────────────────────────────────────
//
// Everything here writes and never reads. firestore.rules denies `read` on all
// three collections, including to the author, so a player's own feedback and
// email are not fetchable by anyone who can open the app.

import { getDb, ensureAnonymousAuth } from '../network/firebaseClient.js';

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
 * Record early-access interest. One row per account: the doc id is the uid, so
 * an account can register exactly once — a second submit is refused by the
 * rules, which is the intended "already on the list" outcome, not an error to
 * surface as a failure.
 *
 * @param {string} email
 */
export async function saveSignup(email) {
  const address = String(email || '').trim();
  if (!isValidEmail(address)) throw new Error('INVALID_EMAIL');

  const [fs] = await Promise.all([import('firebase/firestore')]);
  const user = await ensureAnonymousAuth();
  const ref = fs.doc(getDb(), 'signups', user.uid);
  await fs.setDoc(ref, {
    email: address,
    method: 'manual',
    createdAt: fs.serverTimestamp(),
  });
  return user.uid;
}

/**
 * One feedback item. Rating and text are each optional on their own — a tap
 * with no note is the common case, and a note with no rating is valid too.
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
