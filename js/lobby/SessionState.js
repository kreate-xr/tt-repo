// Serializable snapshot of the multiplayer session, used for reconnect
// restoration in Phase 4. Kept intentionally minimal: only the data that
// cannot be re-derived from the live RTCPeerConnection or signaling state.

export class SessionState {
  constructor() {
    this.scoreSelf = 0;
    this.scoreOpponent = 0;
    this.rallyCount = 0;
    this.ballOwner = null;     // 'self' | 'opponent' | null
    this.lastSeq = { game: 0, event: 0 };
  }

  serialize() {
    return {
      scoreSelf: this.scoreSelf,
      scoreOpponent: this.scoreOpponent,
      rallyCount: this.rallyCount,
      ballOwner: this.ballOwner,
      lastSeq: { ...this.lastSeq },
    };
  }

  static deserialize(snapshot) {
    const s = new SessionState();
    if (!snapshot) return s;
    s.scoreSelf = snapshot.scoreSelf | 0;
    s.scoreOpponent = snapshot.scoreOpponent | 0;
    s.rallyCount = snapshot.rallyCount | 0;
    s.ballOwner = snapshot.ballOwner ?? null;
    s.lastSeq = {
      game: (snapshot.lastSeq && snapshot.lastSeq.game) | 0,
      event: (snapshot.lastSeq && snapshot.lastSeq.event) | 0,
    };
    return s;
  }
}
