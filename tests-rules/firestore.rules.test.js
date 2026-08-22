// Security-rules tests for firestore.rules — the entire security boundary of
// multiplayer. Runs against the Firestore emulator via `npm run test:rules`.
//
// The model under test (see firestore.rules):
//   - all access requires (anonymous) auth
//   - list is denied everywhere; get requires only sign-in (a signed-in user
//     who knows the exact code CAN read the room — documented gap, asserted
//     below so a future tightening shows up as a deliberate test change)
//   - create/update are shape-locked per role (host / guest) and freshness-
//     gated; expired rooms may be reclaimed by a new host
//   - ICE candidate subcollections are append-only, per-role, size-capped

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, deleteField,
  serverTimestamp, Timestamp,
} from 'firebase/firestore';

let env;

const HOST = 'host-uid';
const GUEST = 'guest-uid';
const OTHER = 'other-uid';

const db = (uid) => env.authenticatedContext(uid).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

// What SignalingClient writes on createRoom — must satisfy validHostDoc().
const hostDoc = (uid = HOST) => ({
  host: { joinedAt: serverTimestamp() },
  hostUid: uid,
  createdAt: serverTimestamp(),
});

// Seed a room bypassing rules. createdAt defaults to now (fresh); pass an
// old Timestamp to build an expired room.
async function seedRoom(code, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'rooms', code), data);
  });
}

const freshRoom = (extra = {}) => ({
  host: { joinedAt: Timestamp.now() },
  hostUid: HOST,
  createdAt: Timestamp.now(),
  ...extra,
});

const expiredRoom = () => ({
  host: { joinedAt: Timestamp.fromMillis(Date.now() - 3 * 3600 * 1000) },
  hostUid: HOST,
  createdAt: Timestamp.fromMillis(Date.now() - 3 * 3600 * 1000),
});

const sdp = (kind) => ({ type: kind, sdp: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0' });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

describe('auth boundary', () => {
  test('unauthenticated: no get, no create', async () => {
    await seedRoom('AAAAAA', freshRoom());
    await assertFails(getDoc(doc(anonDb(), 'rooms/AAAAAA')));
    await assertFails(setDoc(doc(anonDb(), 'rooms/BBBBBB'), hostDoc()));
  });

  test('list is denied even signed in — codes cannot be enumerated', async () => {
    await seedRoom('AAAAAA', freshRoom());
    await assertFails(getDocs(collection(db(OTHER), 'rooms')));
  });

  test('KNOWN GAP: any signed-in user who knows the code can read the room', async () => {
    // Not a regression guard — documentation. If `allow get` is ever
    // tightened to participants-only, flip this to assertFails.
    await seedRoom('AAAAAA', freshRoom({ offer: sdp('offer') }));
    await assertSucceeds(getDoc(doc(db(OTHER), 'rooms/AAAAAA')));
  });
});

describe('room create', () => {
  test('valid host doc succeeds', async () => {
    await assertSucceeds(setDoc(doc(db(HOST), 'rooms/NEWAAA'), hostDoc()));
  });

  test('extra keys are rejected (the old _smoke marker)', async () => {
    await assertFails(setDoc(doc(db(HOST), 'rooms/NEWAAA'),
      { ...hostDoc(), _smoke: true }));
  });

  test('hostUid must be the caller', async () => {
    await assertFails(setDoc(doc(db(OTHER), 'rooms/NEWAAA'), hostDoc(HOST)));
  });

  test('createdAt must be request.time — no backdating past the expiry gate', async () => {
    await assertFails(setDoc(doc(db(HOST), 'rooms/NEWAAA'), {
      ...hostDoc(),
      createdAt: Timestamp.fromMillis(Date.now() - 3 * 3600 * 1000),
    }));
  });
});

describe('code reclamation', () => {
  test('a stranger can reclaim an EXPIRED room with a full host doc', async () => {
    await seedRoom('OLDAAA', expiredRoom());
    await assertSucceeds(setDoc(doc(db(OTHER), 'rooms/OLDAAA'), hostDoc(OTHER)));
  });

  test('a stranger cannot overwrite a FRESH room', async () => {
    await seedRoom('LIVEAA', freshRoom());
    await assertFails(setDoc(doc(db(OTHER), 'rooms/LIVEAA'), hostDoc(OTHER)));
  });

  test('the host may overwrite their own fresh room', async () => {
    await seedRoom('LIVEAA', freshRoom());
    await assertSucceeds(setDoc(doc(db(HOST), 'rooms/LIVEAA'), hostDoc(HOST)));
  });
});

describe('guest join', () => {
  test('guest adds exactly guest + guestUid while the slot is empty', async () => {
    await seedRoom('JOINAA', freshRoom());
    await assertSucceeds(updateDoc(doc(db(GUEST), 'rooms/JOINAA'), {
      guest: { joinedAt: serverTimestamp() }, guestUid: GUEST,
    }));
  });

  test('cannot join a full room (server-side room-size cap)', async () => {
    await seedRoom('FULLAA', freshRoom({ guest: {}, guestUid: GUEST }));
    await assertFails(updateDoc(doc(db(OTHER), 'rooms/FULLAA'), {
      guest: { joinedAt: serverTimestamp() }, guestUid: OTHER,
    }));
  });

  test('guestUid must be the caller', async () => {
    await seedRoom('JOINAA', freshRoom());
    await assertFails(updateDoc(doc(db(OTHER), 'rooms/JOINAA'), {
      guest: { joinedAt: serverTimestamp() }, guestUid: GUEST,
    }));
  });

  test('cannot join an expired room', async () => {
    await seedRoom('OLDAAA', expiredRoom());
    await assertFails(updateDoc(doc(db(GUEST), 'rooms/OLDAAA'), {
      guest: { joinedAt: serverTimestamp() }, guestUid: GUEST,
    }));
  });
});

describe('offer / answer', () => {
  const seedPair = (code) =>
    seedRoom(code, freshRoom({ guest: {}, guestUid: GUEST }));

  test('host writes a well-formed offer', async () => {
    await seedPair('SDPAAA');
    await assertSucceeds(updateDoc(doc(db(HOST), 'rooms/SDPAAA'),
      { offer: sdp('offer') }));
  });

  test('guest cannot write the offer; host cannot write the answer', async () => {
    await seedPair('SDPAAA');
    await assertFails(updateDoc(doc(db(GUEST), 'rooms/SDPAAA'),
      { offer: sdp('offer') }));
    await assertFails(updateDoc(doc(db(HOST), 'rooms/SDPAAA'),
      { answer: sdp('answer') }));
  });

  test('guest writes a well-formed answer', async () => {
    await seedPair('SDPAAA');
    await assertSucceeds(updateDoc(doc(db(GUEST), 'rooms/SDPAAA'),
      { answer: sdp('answer') }));
  });

  test('a third party who guessed the code cannot overwrite the offer', async () => {
    await seedPair('SDPAAA');
    await assertFails(updateDoc(doc(db(OTHER), 'rooms/SDPAAA'),
      { offer: sdp('offer') }));
  });

  test('descriptions are shape-locked: wrong type key, extra keys, oversized sdp', async () => {
    await seedPair('SDPAAA');
    const ref = doc(db(HOST), 'rooms/SDPAAA');
    await assertFails(updateDoc(ref, { offer: { type: 'answer', sdp: 'x' } }));
    await assertFails(updateDoc(ref, { offer: { ...sdp('offer'), evil: 1 } }));
    await assertFails(updateDoc(ref, { offer: { type: 'offer', sdp: 'x'.repeat(30000) } }));
  });
});

describe('leave / delete', () => {
  const seedPair = (code) =>
    seedRoom(code, freshRoom({ guest: {}, guestUid: GUEST, answer: sdp('answer') }));

  test('guest vacates by deleting guest/guestUid/answer', async () => {
    await seedPair('BYEAAA');
    await assertSucceeds(updateDoc(doc(db(GUEST), 'rooms/BYEAAA'), {
      guest: deleteField(), guestUid: deleteField(), answer: deleteField(),
    }));
  });

  test('a third party cannot vacate the guest', async () => {
    await seedPair('BYEAAA');
    await assertFails(updateDoc(doc(db(OTHER), 'rooms/BYEAAA'), {
      guest: deleteField(), guestUid: deleteField(), answer: deleteField(),
    }));
  });

  test('either participant may delete the room; a stranger may not', async () => {
    await seedPair('DELAAA');
    await assertFails(deleteDoc(doc(db(OTHER), 'rooms/DELAAA')));
    await assertSucceeds(deleteDoc(doc(db(GUEST), 'rooms/DELAAA')));
    await seedPair('DELBBB');
    await assertSucceeds(deleteDoc(doc(db(HOST), 'rooms/DELBBB')));
  });
});

describe('ICE candidates', () => {
  const CODE = 'ICEAAA';
  const cand = () => ({
    candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host',
    sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd',
  });
  const seedPair = () =>
    seedRoom(CODE, freshRoom({ guest: {}, guestUid: GUEST }));

  test('each role writes only its own collection', async () => {
    await seedPair();
    await assertSucceeds(setDoc(doc(db(HOST), `rooms/${CODE}/hostCandidates/c1`), cand()));
    await assertSucceeds(setDoc(doc(db(GUEST), `rooms/${CODE}/guestCandidates/c1`), cand()));
    await assertFails(setDoc(doc(db(GUEST), `rooms/${CODE}/hostCandidates/c2`), cand()));
    await assertFails(setDoc(doc(db(OTHER), `rooms/${CODE}/hostCandidates/c2`), cand()));
  });

  test('candidates are append-only and shape-locked', async () => {
    await seedPair();
    const ref = doc(db(HOST), `rooms/${CODE}/hostCandidates/c1`);
    await assertSucceeds(setDoc(ref, cand()));
    await assertFails(updateDoc(ref, { sdpMid: '1' }));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(doc(db(HOST), `rooms/${CODE}/hostCandidates/c2`),
      { ...cand(), evil: 1 }));
    await assertFails(setDoc(doc(db(HOST), `rooms/${CODE}/hostCandidates/c3`),
      { ...cand(), candidate: 'x'.repeat(2000) }));
  });

  test('participants read either collection; outsiders read neither', async () => {
    await seedPair();
    await seedRoom(`${CODE}-x`, freshRoom()); // unrelated room, same OTHER uid
    await assertSucceeds(getDocs(collection(db(GUEST), `rooms/${CODE}/hostCandidates`)));
    await assertSucceeds(getDocs(collection(db(HOST), `rooms/${CODE}/guestCandidates`)));
    await assertFails(getDocs(collection(db(OTHER), `rooms/${CODE}/hostCandidates`)));
  });
});
