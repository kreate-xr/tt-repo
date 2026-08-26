// Room-code format, shared by LobbyManager (generation + validation) and the
// in-XR lobby keyboard (which renders exactly this alphabet as its keys).
// Lives in its own module so UI code can import the format without dragging
// in the signaling / WebRTC stack behind LobbyManager.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit easily-confused chars
export const ROOM_CODE_LEN = 6;

export function generateRoomCode() {
  let out = '';
  const a = ROOM_CODE_ALPHABET;
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += a[Math.floor(Math.random() * a.length)];
  }
  return out;
}
