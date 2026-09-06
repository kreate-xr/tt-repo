// js/data/submissions.js — the two writes behind the post-session dialog.
//
// Both are write-only and both are shape-locked by firestore.rules, so the
// bounds asserted here (1..5 rating, 2000-char note, 254-char address) are not
// cosmetic: a value that slips past this module is not saved with a warning,
// it is rejected server-side and the player's feedback is silently lost.

const mockSetDoc = jest.fn();
const mockAddDoc = jest.fn();

jest.mock('firebase/firestore', () => ({
  doc: (...path) => ({ path: path.slice(1).join('/') }),
  collection: (...path) => ({ path: path.slice(1).join('/') }),
  setDoc: (...a) => mockSetDoc(...a),
  addDoc: (...a) => mockAddDoc(...a),
  serverTimestamp: () => 'SERVER_TIME',
}), { virtual: true });

// Only `mock`-prefixed names may cross into a jest.mock factory.
const mockAuthState = { currentUser: { uid: 'anon-uid-1' } };
jest.mock('../js/network/firebaseClient.js', () => ({
  getDb: () => ({}),
  ensureAnonymousAuth: () => Promise.resolve(mockAuthState.currentUser),
}));

const { isValidEmail, saveSignup, saveFeedback } = require('../js/data/submissions.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.currentUser = { uid: 'anon-uid-1' };
});

describe('isValidEmail', () => {
  test.each(['a@b.co', 'first.last+tag@sub.example.com'])(
    'accepts %s', (v) => expect(isValidEmail(v)).toBe(true));

  test.each(['', '   ', 'nope', 'no@domain', '@example.com', 'two@@at.com',
    'spaces in@it.com', null, undefined])(
    'rejects %p', (v) => expect(isValidEmail(v)).toBe(false));

  test('rejects an address longer than the 254-char rules cap', () => {
    expect(isValidEmail(`${'x'.repeat(250)}@example.com`)).toBe(false);
  });

  test('trims before judging — a pasted address usually carries whitespace', () => {
    expect(isValidEmail('  player@example.com  ')).toBe(true);
  });
});

describe('saveSignup', () => {
  test('writes one row keyed by uid, always method manual', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('player@example.com');
    const [ref, data] = mockSetDoc.mock.calls[0];
    // The doc id IS the uid — that is the whole rate limit, and firestore.rules
    // denies update, so a second submit is refused rather than overwriting.
    expect(ref.path).toBe('signups/anon-uid-1');
    expect(data).toEqual({
      email: 'player@example.com',
      method: 'manual',
      createdAt: 'SERVER_TIME',
    });
  });

  test('trims the address before storing it', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('  p@e.co  ');
    expect(mockSetDoc.mock.calls[0][1].email).toBe('p@e.co');
  });

  test('refuses an invalid address without touching the network', async () => {
    await expect(saveSignup('nope')).rejects.toThrow('INVALID_EMAIL');
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  test('writes no sign-in metadata — there is no linked account any more', async () => {
    mockSetDoc.mockResolvedValue();
    await saveSignup('p@e.co');
    expect(mockSetDoc.mock.calls[0][1]).not.toHaveProperty('mergedFrom');
  });
});

describe('saveFeedback', () => {
  test('writes rating, note and context under the uid', async () => {
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

  test('a rating with no note is valid — that is the one-tap path', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ rating: 5 });
    expect(mockAddDoc.mock.calls[0][1]).not.toHaveProperty('text');
  });

  test('a note with no rating is valid too', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ text: 'the net looks wrong' });
    expect(mockAddDoc.mock.calls[0][1]).not.toHaveProperty('rating');
  });

  test('writes nothing when there is nothing to say', async () => {
    const out = await saveFeedback({ rating: null, text: '   ' });
    expect(out).toBeNull();
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  test('truncates a note to the 2000-char rules cap', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ text: 'z'.repeat(5000) });
    expect(mockAddDoc.mock.calls[0][1].text.length).toBe(2000);
  });

  test('omits an absent context rather than writing null', async () => {
    mockAddDoc.mockResolvedValue({ id: 'x' });
    await saveFeedback({ rating: 3 });
    expect(mockAddDoc.mock.calls[0][1]).not.toHaveProperty('context');
  });
});
