// Client for our own backend (functions/, served on this origin under /api
// by the Firebase Hosting rewrite in firebase.json). Every call carries the
// Firebase ID token — anonymous or email/password, the backend accepts both
// and decides what each may do — plus an App Check token when App Check runs.

import { ensureAnonymousAuth } from '../network/firebaseClient.js';
import { getAppCheckTokenString } from '../network/appCheck.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body) {
  const user = await ensureAnonymousAuth();
  const [idToken, appCheckToken] = await Promise.all([user.getIdToken(), getAppCheckTokenString()]);
  const headers = { authorization: `Bearer ${idToken}` };
  if (appCheckToken) headers['x-firebase-appcheck'] = appCheckToken;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json && json.error) || {};
    throw new ApiError(res.status, err.code || 'http_error', err.message);
  }
  return json;
}

/** { entitled, trial: { remainingSec }, account: { anonymous, email, emailVerified, hasCheckoutProfile } } */
export const fetchMe = () => call('GET', '/api/me');

/** @param {'start'|'renew'|'end'} action → { entitled, leaseSec, remainingSec } */
export const postLease = (action) => call('POST', '/api/trial/lease', { action });

/** → { orderId, intentId, clientSecret, amount, currency } */
export const postOrder = ({ name, phone }) => call('POST', '/api/orders', { name, phone });
