// Human-readable lobby failure messages, shared by the 2D start screen
// (ui/overlay.js) and the in-XR multiplayer panel (scene/multiplayerMenu.js).
// One copy so the wording can't drift between the two surfaces.

export function friendlyLobbyError(err, code) {
  const msg = String((err && err.message) || err || '');
  if (msg.includes('ROOM_NOT_FOUND')) return `Room ${code} not found — double-check the code with your friend.`;
  if (msg.includes('ROOM_FULL')) return `Room ${code} already has two players. Ask your friend to create a new room.`;
  if (msg.includes('ICE_TIMEOUT')) return 'Could not connect to the other player (network issue). Both of you: try again with a new room.';
  // Only reachable after LobbyManager has burned all its re-rolls, which in
  // practice means the rules rejected every create — not a real collision run.
  if (msg.includes('ROOM_CODE_COLLISION')) return 'Could not reserve a room code — please try creating a room again.';
  // Unrecognized failure: keep the raw SDK/SDP error out of the UI.
  console.error('lobby error:', err);
  return 'Connection failed — check your internet connection and try again.';
}
