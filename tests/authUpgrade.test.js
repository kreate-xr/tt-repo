// js/auth/upgrade.js — anonymous → permanent account, and the two writes
// behind the post-session card.
//
// The behaviour worth pinning down is the merge path. When a player links a
// Google account that is ALREADY attached to a different anonymous uid — they
// played on a second headset, or cleared storage — Firebase throws
// auth/credential-already-in-use. Unhandled, that both dead-ends the sign-in
// and silently strands everything they did in the current session. The module
// must instead adopt the existing account and report the uid it left behind.

const mockLinkWithPopup = jest.fn();
const mockSignInWithCredential = jest.fn();
const mockCredentialFromError = jest.fn();
const mockSetDoc = jest.fn();
const mockAddDoc = jest.fn();

// The provider class is built INSIDE the factory: jest hoists jest.mock above
// the file's other declarations and only lets a factory close over names
// prefixed `mock`, so an out-of-scope class here is a hard error.
jest.mock('firebase/auth', () => {
  class FakeGoogleProvider {}
  FakeGoogleProvider.credentialFromError = (...a) => mockCredentialFromError(...a);
  return {
    GoogleAuthProvider: FakeGoogleProvider,
    linkWithPopup: (...a) => mockLinkWithPopup(...a),
    signInWithCredential: (...a) => mockSignInWithCredential(...a),
  };
}, { virtual: true });

jest.mock('firebase/firestore', () => ({
  doc: (...path) => ({ path: path.slice(1).join('/') }),
  collection: (...path) => ({ path: path.slice(1).join('/') }),
  setDoc: (...a) => mockSetDoc(...a),
  addDoc: (...a) => mockAddDoc(...a),
  serverTimestamp: () => 'SERVER_TIME',
}), { virtual: true });

// Same hoisting rule: only `mock`-prefixed names may cross into a factory.
const mockAuthState = { currentUser: { uid: 'anon-uid-1' } };
jest.mock('../js/network/firebaseClient.js', () => ({
  getAuth_: () => mockAuthState,
  getDb: () => ({}),
  ensureAnonymousAuth: () => Promise.resolve(mockAuthState.currentUser),
}));

const {
  isValidEmail, linkGoogle, saveSignup, saveFeedback, friendlyAuthError,
} = require('../js/auth/upgrade.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.currentUser = { uid: 'anon-uid-1' };
});

describe('isValidEmail', () => {
  test.each([
    'a@b.co',
    'first.last+tag@sub.example.com',
  ])('accepts %s', (v) => expect(isValidEmail(v)).toBe(true));

  test.each([
    '', '   ', 'nope', 'no@domain', '@example.com', 'two@@at.com', 'spaces in@it.com', null, undefined,
  ])('rejects %p', (v) => expect(isValidEmail(v)).toBe(false));

  test('rejects an address longer than the 254-char rules cap', () => {
    expect(isValidEmail(`${'x'.repeat(250)}@example.com`)).toBe(false);
  });

  test('trims before judging — a pasted address usually carries whitespace', () => {
    expect(isValidEmail('  player@example.com  ')).toBe(true);
  });
});

describe('linkGoogle', () => {
  test('happy path upgrades in place and PRESERVES the uid', async () => {
    mockLinkWithPopup.mockResolvedValue({
      user: { uid: 'anon-uid-1', email: 'player@example.com' },
    });
    const out = await linkGoogle();
    // The uid surviving is the entire reason this is a link and not a signup:
    // every sessions/{uid}/runs/* row written anonymously stays attached.
    expect(out.uid).toBe('anon-uid-1');
    expect(out.email).toBe('player@example.com');
    expect(out.merged).toBe(false);
  });

  test('credential-already-in-use signs into the existing account and reports the abandoned uid', async () => {
    const err = new Error('taken');
    err.code = 'auth/credential-already-in-use';
    mockLinkWithPopup.mockRejectedValue(err);
    mockCredentialFromError.mockReturnValue({ token: 'google-cred' });
    mockSignInWithCredential.mockResolvedValue({
      user: { uid: 'existing-uid-9', email: 'player@example.com' },
    });

    const out = await linkGoogle();
    expect(mockSignInWithCredential).toHaveBeenCalled();
    expect(out.uid).toBe('existing-uid-9');
    expect(out.merged).toBe(true);
    // The breadcrumb that makes the two sets of rows stitchable later.
    expect(out.previousUid).toBe('anon-uid-1');
  });

  test('email-already-in-use takes the same merge path', async () => {
    const err = new Error('taken');
    err.code = 'auth/email-already-in-use';
    mockLinkWithPopup.mockRejectedValue(err);
    mockCredentialFromError.mockReturnValue({ token: 'c' });
    mockSignInWithCredential.mockResolvedValue({ user: { uid: 'u2', email: 'a@b.co' } });
    await expect(linkGoogle()).resolves.toMatchObject({ merged: true });
  });

  test('rethrows when no credential can be recovered — silently swallowing would strand the player', async () => {
    const err = new Error('taken');
    err.code = 'auth/credential-already-in-use';
    mockLinkWithPopup.mockRejectedValue(err);
    mockCredentialFromError.mockReturnValue(null);
    await expect(linkGoogle()).rejects.toThrow('taken');
  });

  test('rethrows an unrelated failure rather than pretending it merged', async () => {
    const err = new Error('popup gone');
    err.code = 'auth/popup-closed-by-user';
    mockLinkWithPopup.mockRejectedValue(err);
    await expect(linkGoogle()).rejects.toThrow('popup gone');
  });
});

describe('friendlyAuthError', () => {
  test('names the popup-blocked case, which is the likely Quest failure', () => {
    expect(friendlyAuthError({ code: 'auth/popup-blocked' })).toMatch(/popup/i);
  });

  test('points at the email fallback when the provider is not enabled', () => {
    expect(friendlyAuthError({ code: 'auth/operation-not-allowed' })).toMatch(/email/i);
  });

  test('has a default for an unknown code', () => {
    expect(friendlyAuthError({ code: 'auth/whatever' })).toBeTruthy();
    expect(friendlyAuthError(null)).toBeTruthy();
  });
});

describe('saveSignup', () => {
  test('writes one row keyed by uid', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('player@example.com', 'google');
    const [ref, data] = mockSetDoc.mock.calls[0];
    expect(ref.path).toBe('signups/anon-uid-1');
    expect(data).toMatchObject({ email: 'player@example.com', method: 'google' });
    expect(data.createdAt).toBe('SERVER_TIME');
    expect(data).not.toHaveProperty('mergedFrom');
  });

  test('records mergedFrom when the link had to adopt another account', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('p@e.co', 'google', 'old-uid-3');
    expect(mockSetDoc.mock.calls[0][1].mergedFrom).toBe('old-uid-3');
  });

  test('trims the address before storing it', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('  p@e.co  ', 'manual');
    expect(mockSetDoc.mock.calls[0][1].email).toBe('p@e.co');
  });

  test('refuses an invalid address without touching the network', async () => {
    await expect(saveSignup('nope', 'manual')).rejects.toThrow('INVALID_EMAIL');
    expect(mockSetDoc).not.toHaveBeenCalled();
  });
});

describe('saveFeedback', () => {
  test('writes rating and text under the uid', async () => {
    mockAddDoc.mockResolvedValue({ id: 'fb1' });
    await saveFeedback({ rating: 4, text: 'good fun', context: { shots: 10 } });
    const [col, data] = mockAddDoc.mock.calls[0];
    expect(col.path).toBe('feedback/anon-uid-1/items');
    expect(data).toMatchObject({ rating: 4, text: 'good fun', context: { shots: 10 } });
  });

  test('clamps a rating into the 1..5 the rules accept', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ rating: 99 });
    expect(mockAddDoc.mock.calls[0][1].rating).toBe(5);
    await saveFeedback({ rating: -3 });
    expect(mockAddDoc.mock.calls[1][1].rating).toBe(1);
  });

  test('rounds a fractional rating', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ rating: 3.7 });
    expect(mockAddDoc.mock.calls[0][1].rating).toBe(4);
  });

  test('a rating with no text is valid — that is the whole one-tap path', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ rating: 5 });
    expect(mockAddDoc.mock.calls[0][1]).not.toHaveProperty('text');
  });

  test('text with no rating is valid too', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ text: 'the net looks wrong' });
    expect(mockAddDoc.mock.calls[0][1]).not.toHaveProperty('rating');
  });

  test('writes nothing when there is nothing to say', async () => {
    const out = await saveFeedback({ rating: null, text: '   ' });
    expect(out).toBeNull();
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  test('truncates text to the 2000-char rules cap', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ text: 'z'.repeat(5000) });
    expect(mockAddDoc.mock.calls[0][1].text.length).toBe(2000);
  });
});
