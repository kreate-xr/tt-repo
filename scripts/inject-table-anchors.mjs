// Re-inject the anchor empties that models.js requires into Table.glb.
//
// Background: the 2026-08-29 combined table+net export (net baked in as a
// textured node named 'Net', standalone Net.glb retired) was re-authored
// without the anchor empties the previous asset carried. models.js reads
// Edge_Left/Edge_Right/Edge_Far/Edge_Near/TableCenter/NetCenter at load and
// fail-louds on a missing one — by design, a GLB without anchors is a broken
// asset (same policy as Paddle.glb). This script repairs the asset instead of
// weakening that contract.
//
// Anchor positions are the EXACT world-space values from the pre-2026-08-29
// asset (parent 'TableTennis' translation + each empty's local translation;
// that parent had no rotation/scale). Physics tolerances, AI envelopes and the
// ITTF conformance check were all tuned against these numbers, and the new
// export's felt/net geometry matches them to <1 mm — verified against the new
// felt primitive's accessor bounds (surface Y 0.78002 vs TableCenter 0.78000,
// felt X -0.8307..0.6847 vs Edge_Left/Right -0.8302/0.6841).
//
// Anchors are appended as ROOT scene nodes (not children of 'TableTennis'):
// the new export puts a x0.01 scale on that node, which would rescale child
// translations, and models.js getObjectByName finds them anywhere under the
// loaded scene. Idempotent — skips names that already exist.
//
// Usage: node scripts/inject-table-anchors.mjs [path-to-glb]
//        (defaults to public/models/Table.glb)

import fs from 'node:fs';

// World positions from the old asset: parent translation
// [-0.0724235251545906, 0.5102682709693909, -0.0007677088724449277]
// plus each empty's local translation, summed at full float precision.
const PARENT = [-0.0724235251545906, 0.5102682709693909, -0.0007677088724449277];
const LOCAL = {
  BallSpawn_Opponent:       [0, 0.4597317576408386, -0.49923229217529297],
  BallSpawn_Player:         [0, 0.4597317576408386, 0.500767707824707],
  BounceZone_OpponentLeft:  [-0.34807640314102173, 0.27973175048828125, -0.5509710311889648],
  BounceZone_OpponentRight: [0.3480895757675171, 0.27973175048828125, -0.5509710311889648],
  BounceZone_PlayerLeft:    [-0.34999340772628784, 0.27973175048828125, 0.5509459972381592],
  BounceZone_PlayerRight:   [0.3500065803527832, 0.27973175048828125, 0.5509459972381592],
  CameraFocus:              [0, 0.689731776714325, 0.0007677088724449277],
  Edge_Far:                 [0, 0.27973175048828125, -1.3650223016738892],
  Edge_Left:                [-0.757798433303833, 0.27973175048828125, 0.0007677088724449277],
  Edge_Near:                [0, 0.27973175048828125, 1.3665590286254883],
  Edge_Right:               [0.7565220594406128, 0.27973175048828125, 0.0007677088724449277],
  NetCenter:                [0, 0.4222317337989807, 0.0007677088724449277],
  TableCenter:              [0, 0.26973170042037964, 0],
};

const path = process.argv[2] || 'public/models/Table.glb';
const buf = fs.readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error('not a GLB (bad magic)'); process.exit(2); }

const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== 0x4e4f534a) { console.error('first chunk is not JSON'); process.exit(3); }
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf-8'));
const rest = buf.subarray(20 + jsonLen); // BIN chunk (header + data), byte-preserved

json.nodes ??= [];
json.scenes ??= [{ nodes: [] }];
const scene = json.scenes[json.scene ?? 0];
scene.nodes ??= [];

const existing = new Set(json.nodes.map((n) => n.name));
let added = 0;
for (const [name, local] of Object.entries(LOCAL)) {
  if (existing.has(name)) { console.log(`skip ${name} (already present)`); continue; }
  const translation = local.map((v, i) => v + PARENT[i]);
  scene.nodes.push(json.nodes.length);
  json.nodes.push({ name, translation });
  added++;
}
if (added === 0) { console.log('nothing to do'); process.exit(0); }

// Reassemble: JSON chunk padded to 4 bytes with spaces (glTF 2.0 spec).
let jsonOut = Buffer.from(JSON.stringify(json), 'utf-8');
const pad = (4 - (jsonOut.length % 4)) % 4;
if (pad) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(pad, 0x20)]);

const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);                       // 'glTF'
header.writeUInt32LE(buf.readUInt32LE(4), 4);              // version
header.writeUInt32LE(20 + jsonOut.length + rest.length, 8); // total length
header.writeUInt32LE(jsonOut.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);                      // 'JSON'

fs.writeFileSync(path, Buffer.concat([header, jsonOut, rest]));
console.log(`injected ${added} anchor node(s) into ${path}`);
