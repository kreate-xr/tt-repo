// Firestore-backed signaling. Each "room" is a single Firestore document
// plus two subcollections of ICE candidates — one per role. Real-time
// listeners (onSnapshot) push updates to both peers without any server in
// the middle. Replaces the previous WebSocket transport entirely.
//
//   Document layout:
//     rooms/{code} {
//       host:       { joinedAt: Timestamp }              // present when host has joined
//       guest:      { joinedAt: Timestamp }              // present when guest has joined
//       offer:      { type, sdp }                        // host writes
//       answer:     { type, sdp }                        // guest writes
//       createdAt:  Timestamp
//     }
//     rooms/{code}/hostCandidates/{auto-id}   ICE candidate JSON
//     rooms/{code}/guestCandidates/{auto-id}  ICE candidate JSON
//
// Role assignment is atomic via runTransaction:
//   - connect(code, { create: true })  → I become 'host'; the doc is written
//     fresh (full overwrite), clearing any stale guest/offer/answer left by
//     an earlier session on the same code
//   - connect(code)                    → join: room must exist with a host
//     (else ROOM_NOT_FOUND) and no guest (else ROOM_FULL); I become 'guest'
//
// Public API matches the previous WebSocket client so the rest of the stack
// (NetworkManager, LobbyManager) is unchanged:
//   const sig = new SignalingClient();
//   const { role } = await sig.connect(roomCode);
//   sig.on('peerReady' | 'offer' | 'answer' | 'ice' | ...);
//   sig.sendOffer(sdp); sig.sendAnswer(sdp); sig.sendIce(candidate);
//   sig.close();

import {
  doc, collection, addDoc, setDoc, onSnapshot,
  runTransaction, serverTimestamp, deleteDoc, deleteField, updateDoc,
} from 'firebase/firestore';
import { getDb, ensureAnonymousAuth } from './firebaseClient.js';

export class SignalingClient {
  constructor() {
    this.room = null;
    this.role = null;            // 'host' | 'guest'
    this.roomRef = null;
    this.myCandidatesRef = null; // collection ref where I write my ICE
    this.unsubscribers = [];
    this.closed = false;

    this._peerReadyEmitted = false;
    this._offerEmitted = false;
    this._answerEmitted = false;

    this.listeners = {
      joined: [], peerReady: [],
      offer: [], answer: [], ice: [],
      roomFull: [], peerDisconnected: [],
      close: [], error: [],
    };
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
  }

  _emit(event, payload) {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) {
      try { fn(payload); } catch (e) { console.error(`signaling listener for ${event} threw:`, e); }
    }
  }

  async connect(roomCode, { create = false } = {}) {
    if (this.roomRef) throw new Error('SignalingClient already connected');
    this.room = roomCode;

    await ensureAnonymousAuth();
    const db = getDb();
    this.roomRef = doc(db, 'rooms', roomCode);

    // Atomic role assignment.
    let assignedRole;
    try {
      assignedRole = await runTransaction(db, async (txn) => {
        const snap = await txn.get(this.roomRef);
        if (create) {
          // Fresh room, full overwrite: room codes are random, so anything
          // already at this code is leftover from a dead session — wiping the
          // stale guest/offer/answer fields here is what lets the same code
          // be reused after a reload or a failed attempt.
          txn.set(this.roomRef, {
            host: { joinedAt: serverTimestamp() },
            createdAt: serverTimestamp(),
          });
          return 'host';
        }
        // Join: never create a room implicitly. A mistyped code used to make
        // the guest silently become host of an empty room and hang forever.
        if (!snap.exists() || !snap.data().host) return 'notFound';
        if (snap.data().guest) return 'full';
        txn.update(this.roomRef, { guest: { joinedAt: serverTimestamp() } });
        return 'guest';
      });
    } catch (err) {
      this._emit('error', err);
      throw err;
    }

    if (assignedRole === 'notFound') {
      throw new Error('ROOM_NOT_FOUND');
    }
    if (assignedRole === 'full') {
      this._emit('roomFull', {});
      throw new Error('ROOM_FULL');
    }
    this.role = assignedRole;

    const otherRoleField = assignedRole === 'host' ? 'guest' : 'host';
    const myCandidatesCol = assignedRole === 'host' ? 'hostCandidates' : 'guestCandidates';
    const otherCandidatesCol = assignedRole === 'host' ? 'guestCandidates' : 'hostCandidates';

    this.myCandidatesRef = collection(this.roomRef, myCandidatesCol);

    // --- Room doc listener: peerReady, offer (guest), answer (host) ---
    const roomUnsub = onSnapshot(this.roomRef, (snap) => {
      if (this.closed) return;
      const data = snap.data();
      if (!data) {
        // Doc was deleted while we were live — treat as peer dropout.
        this._emit('peerDisconnected', {});
        return;
      }
      if (data[otherRoleField] && !this._peerReadyEmitted) {
        this._peerReadyEmitted = true;
        this._emit('peerReady', {});
      }
      if (assignedRole === 'guest' && data.offer && !this._offerEmitted) {
        this._offerEmitted = true;
        this._emit('offer', { sdp: data.offer });
      }
      if (assignedRole === 'host' && data.answer && !this._answerEmitted) {
        this._answerEmitted = true;
        this._emit('answer', { sdp: data.answer });
      }
    }, (err) => this._emit('error', err));
    this.unsubscribers.push(roomUnsub);

    // --- Other peer's ICE candidates: each new sub-doc is one candidate. ---
    const otherCandidatesRef = collection(this.roomRef, otherCandidatesCol);
    const candUnsub = onSnapshot(otherCandidatesRef, (snap) => {
      if (this.closed) return;
      snap.docChanges().forEach((change) => {
        if (change.type === 'added') {
          this._emit('ice', { candidate: change.doc.data() });
        }
      });
    }, (err) => this._emit('error', err));
    this.unsubscribers.push(candUnsub);

    this._emit('joined', { role: assignedRole });
    return { role: assignedRole };
  }

  sendOffer(sdp) {
    if (!this.roomRef) return;
    // Firestore needs plain objects; RTCSessionDescriptionInit IS one.
    setDoc(this.roomRef, { offer: { type: sdp.type, sdp: sdp.sdp } }, { merge: true })
      .catch((err) => this._emit('error', err));
  }

  sendAnswer(sdp) {
    if (!this.roomRef) return;
    setDoc(this.roomRef, { answer: { type: sdp.type, sdp: sdp.sdp } }, { merge: true })
      .catch((err) => this._emit('error', err));
  }

  sendIce(candidate) {
    if (!this.myCandidatesRef || !candidate) return;
    // RTCIceCandidate has a toJSON() that returns a plain object Firestore
    // can store. Older browsers / shims may not — fall back to a manual copy.
    const payload = typeof candidate.toJSON === 'function'
      ? candidate.toJSON()
      : {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        };
    addDoc(this.myCandidatesRef, payload)
      .catch((err) => this._emit('error', err));
  }

  // Best-effort cleanup on the way out so the code becomes reusable:
  //   host  → delete the room doc (peer's snapshot sees it as peerDisconnected)
  //   guest → vacate the guest slot + stale answer so the host's room can be
  //           joined again after a failed attempt
  async deleteRoom() {
    if (!this.roomRef) return;
    try { await deleteDoc(this.roomRef); } catch { /* best-effort */ }
  }

  async leaveRoom() {
    if (!this.roomRef) return;
    try {
      await updateDoc(this.roomRef, { guest: deleteField(), answer: deleteField() });
    } catch { /* best-effort — room may already be gone */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch {}
    }
    this.unsubscribers = [];
    this._emit('close', null);
    // Room doc + candidate subcollections are left in Firestore. A Cloud
    // Functions scheduled cleanup (TTL or cron) is the right way to prune
    // them in production — covered as a follow-up task, not blocking play.
  }
}
