// Dump node/mesh names from a .glb without needing three.js. GLB = 12-byte
// header + JSON chunk + BIN chunk. We only need the JSON.
//
// Usage: node scripts/dump-glb-nodes.mjs <path-to-glb>

import fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: node dump-glb-nodes.mjs <file.glb>'); process.exit(1); }

const buf = fs.readFileSync(path);
const magic = buf.readUInt32LE(0);          // 'glTF'
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);
if (magic !== 0x46546c67) { console.error('not a GLB (bad magic)'); process.exit(2); }
console.log(`glb version ${version}, total ${total} bytes`);

// First chunk header at offset 12: chunkLength(u32), chunkType(u32), then data.
const chunkLen = buf.readUInt32LE(12);
const chunkType = buf.readUInt32LE(16);
if (chunkType !== 0x4e4f534a) { console.error('first chunk is not JSON'); process.exit(3); }
const jsonBytes = buf.subarray(20, 20 + chunkLen);
const json = JSON.parse(jsonBytes.toString('utf-8'));

console.log(`\n--- top-level scenes: ${json.scenes?.length ?? 0}, nodes: ${json.nodes?.length ?? 0}, meshes: ${json.meshes?.length ?? 0}`);

const nodes = json.nodes ?? [];
const meshes = json.meshes ?? [];

console.log('\n--- NODES (idx | name | meshIdx | children) ---');
nodes.forEach((n, i) => {
  console.log(`${String(i).padStart(3)} | ${(n.name || '(unnamed)').padEnd(40)} | mesh=${n.mesh ?? '-'} | ch=[${(n.children || []).join(',')}]`);
});

console.log('\n--- MESHES (idx | name | primCount) ---');
meshes.forEach((m, i) => {
  console.log(`${String(i).padStart(3)} | ${(m.name || '(unnamed)').padEnd(40)} | ${m.primitives?.length ?? 0} prim(s)`);
});

// Highlight any node whose name hints at a wall / banner / scoreboard mount.
const HINTS = ['wall', 'back', 'banner', 'score', 'board', 'screen', 'led', 'panel', 'sign', 'mount', 'billboard'];
const hits = nodes
  .map((n, i) => ({ i, name: n.name || '' }))
  .filter(({ name }) => HINTS.some((h) => name.toLowerCase().includes(h)));
console.log(`\n--- CANDIDATE MOUNT NODES (name matches ${HINTS.join('/')}) ---`);
if (hits.length === 0) console.log('  (none)');
else hits.forEach(({ i, name }) => console.log(`  #${i}  ${name}`));
