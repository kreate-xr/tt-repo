// PhysicsTuner panel + the physicsParams metadata table.
//
// This file had no test at all before the A/B/C restructure, which mattered
// because the panel is the only consumer of every setter in constants.js: a
// deleted setter left a KNOBS row whose '+' press threw at runtime, in VR,
// where nobody sees a console.
//
// What is pinned here is the STRUCTURE the sections promise, not their values:
//   - Section A renders no controls at all. If a locked physical constant ever
//     grows a stepper, that is the bug this catches.
//   - A Section B stepper moves the live binding, and reset restores the ITTF
//     default — the two halves of every tunable row.
//   - Presets apply as a complete set, so switching cannot accumulate state.
//   - Stored-settings migration discards deleted rows rather than
//     reinterpreting them, and clamps the two rows whose model changed.

const THREE = require('three');
jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
function makeCtx(){ return new Proxy({}, { get:(t,p)=>{ if(p==='measureText') return ()=>({width:10});
  if(p==='canvas') return {width:720,height:900}; return ()=>{}; }, set:()=>true }); }
beforeAll(()=>{ globalThis.document = { createElement: () => ({ width:0, height:0, getContext: () => makeCtx() }) }; });
const { PhysicsTuner } = require('../js/scene/physicsTuner.js');
const PP = require('../js/physics/physicsParams.js');
const P = require('../js/physics/constants.js');
test('panel builds, all three sections render, controls work', () => {
  const t = new PhysicsTuner();
  expect(t.mesh).toBeInstanceOf(THREE.Mesh);
  for (const s of ['A','B','C']) {
    t.activate({ kind:'tab', section:s });
    expect(t.buttons.some(b=>b.id===`tab-${s}`)).toBe(true);
  }
  // Section A must expose no steppers (locked, display-only).
  t.activate({ kind:'tab', section:'A' });
  expect(t.buttons.filter(b=>['minus','plus','reset'].includes(b.kind)).length).toBe(0);
  // Section B stepper changes the live binding; reset restores it.
  t.activate({ kind:'tab', section:'B' });
  const row = PP.EQUIPMENT_ROWS.find(r=>r.id==='tableMu');
  const before = P.TABLE_MU;
  PP.stepRow(row, +1);
  expect(P.TABLE_MU).toBeCloseTo(before + 0.01, 6);
  PP.resetRow(row);
  expect(P.TABLE_MU).toBeCloseTo(0.25, 6);
  // Presets.
  P.applyPhysicsPreset('lively'); expect(P.PADDLE_E0).toBeCloseTo(0.90, 6);
  P.applyPhysicsPreset('dead');   expect(P.PADDLE_E0).toBeCloseTo(0.80, 6);
  P.applyPhysicsPreset('ittf');   expect(P.PADDLE_E0).toBeCloseTo(0.878, 6);
  // Migration: deleted rows discarded, old #1/#4 mapped and clamped.
  const rep = PP.migrateStoredPhysics({ gravity:-12, drag:0.10, contactCap:6.5, paddleRest:0.82, tableRest:0.75 });
  expect(rep.discarded).toEqual(expect.arrayContaining(['gravity','drag','contactCap']));
  expect(P.PADDLE_E0).toBeCloseTo(0.82, 6);
  expect(P.TABLE_EN_0).toBeCloseTo(0.90, 6);       // 0.75 clamps up into range
  expect(rep.clamped.some(c=>c.key==='tableRest')).toBe(true);
  P.applyPhysicsPreset('ittf');
});
