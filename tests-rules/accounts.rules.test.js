// Security-rules tests for the accounts / trial / payments collections. The
// backend (functions/) writes all of them through the Admin SDK; the client
// may only READ its own users/{uid} and entitlements/{uid}. Any client write
// would be a self-granted purchase or a reset trial.

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

let env;

const ME = 'me-uid';
const OTHER = 'other-uid';

const db = (uid) => env.authenticatedContext(uid).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

describe.each(['users', 'entitlements'])('%s/{uid}', (col) => {
  beforeEach(() => seed(`${col}/${ME}`, { active: true, trial: { usedMs: 1000 } }));

  test('owner can read their own doc', async () => {
    await assertSucceeds(getDoc(doc(db(ME), `${col}/${ME}`)));
  });

  test('another user cannot read it', async () => {
    await assertFails(getDoc(doc(db(OTHER), `${col}/${ME}`)));
  });

  test('unauthenticated cannot read it', async () => {
    await assertFails(getDoc(doc(anonDb(), `${col}/${ME}`)));
  });

  test('list is denied', async () => {
    await assertFails(getDocs(collection(db(ME), col)));
  });

  test('owner cannot create, update or delete', async () => {
    await assertFails(setDoc(doc(db(ME), `${col}/${ME}-new`), { active: true }));
    await assertFails(setDoc(doc(db('fresh-uid'), `${col}/fresh-uid`), { active: true }));
    await assertFails(updateDoc(doc(db(ME), `${col}/${ME}`), { active: false }));
    await assertFails(deleteDoc(doc(db(ME), `${col}/${ME}`)));
  });
});

describe.each(['orders', 'paylayerEvents', 'trialIps'])('%s (server-only)', (col) => {
  beforeEach(() => seed(`${col}/x1`, { uid: ME }));

  test('no read, even for the uid it names', async () => {
    await assertFails(getDoc(doc(db(ME), `${col}/x1`)));
    await assertFails(getDocs(collection(db(ME), col)));
  });

  test('no write', async () => {
    await assertFails(setDoc(doc(db(ME), `${col}/x2`), { uid: ME }));
    await assertFails(updateDoc(doc(db(ME), `${col}/x1`), { uid: OTHER }));
    await assertFails(deleteDoc(doc(db(ME), `${col}/x1`)));
  });
});
