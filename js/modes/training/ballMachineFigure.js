// BallMachineFigure — the physical ball machine for M1.
//
// M1 is a BALL MACHINE, and it originally shipped with the legacy feeder's
// ServerFigure: a human-server animation, a paddle that winds up and swings.
// That read as an opponent serving, not as a machine feeding, and it
// misrepresented what the mode is. This class replaced it, and when the
// legacy feed path was deleted the ServerFigure went entirely — its
// contact-pose helper now lives here as computeContactPose.
//
// The API names (beginSwing / showHeldBall / emitter) are inherited from
// that swap — kept because renaming them buys nothing and every call site
// would churn. The animation itself is a machine's, not a server's:
// wheels spin up → release (~0.25 s), no backswing. LAUNCH_LEAD_SEC below
// is what FeedEngine subtracts from the interval, and it must track the
// animation actually played or the feed rhythm drifts.

import * as THREE from 'three';
import { scene, ballEnvMap } from '../../scene/sceneSetup.js';
import { ballRadius } from '../../scene/models.js';
import { FLOOR_LEVEL_Y } from '../../physics/constants.js';

/**
 * Pose at the moment of launch: face center at the spawn position, facing
 * along the HORIZONTAL launch direction with a small upward tilt. The
 * launch velocity's Y component is deliberately ignored — it is large
 * (the ball arcs), and aiming the whole head along it reads as a toss
 * rather than a shot.
 *
 * Moved here from the deleted ServerFigure when the legacy feed path went:
 * this is pure math over the feed, and the machine is its only consumer —
 * the drill uses it to aim the barrel, beginSwing to point the head.
 */
export function computeContactPose(spawnPos, launchVelocity) {
  const horiz = new THREE.Vector3(launchVelocity.x, 0, launchVelocity.z);
  if (horiz.lengthSq() < 1e-6) horiz.set(0, 0, 1);
  horiz.normalize();
  const normal = horiz.clone();
  normal.y = 0.18;  // slight upward tilt — matches the arc's launch feel
  normal.normalize();
  return { position: spawnPos.clone(), normal };
}

// Wheels visibly accelerate before the ball leaves, which is the machine's
// equivalent of a backswing: it tells the player a feed is imminent.
export const SPINUP_DURATION = 0.25;
// Brief settle so consecutive feeds don't look like one continuous stream.
export const RECOVER_DURATION = 0.15;
export const LAUNCH_LEAD_SEC = SPINUP_DURATION;
export const FEED_CYCLE_SEC = SPINUP_DURATION + RECOVER_DURATION;

// Look.
//
// The machine is modelled on a real two-wheel table tennis robot: a throwing
// head (two sponge wheels, one above and one below the ball path, each with
// its own motor, held between two side plates) on a ball joint, a telescopic
// column on a three-leg caster base, a clear ball bucket behind, and a small
// control box. It replaced a grey drum with an orange band, which read as a
// placeholder.
//
// Three things the earlier passes learned still hold, and shape the palette:
//   - It is the furthest object the player looks at, and it has to read in a
//     dark arena and through passthrough alike. So the big surface (the head
//     housing) is light, and the saturated colour sits on the wheels, which
//     are also the part that moves.
//   - MeshStandardMaterial is entirely lighting-dependent, and in
//     `immersive-ar` the scene lights are a guess at the real room. Every
//     part keeps a small EMISSIVE floor so it cannot come out black.
//   - Metal with nothing to reflect renders dark. The metal parts therefore
//     take the ball's studio environment map (sceneSetup.js ballEnvMap),
//     which is independent of the scene lights. Without it (unit tests) they
//     fall back to low-metalness greys.
const SHELL_COLOR = 0xe4e8ed;     // painted housing — light, reads at distance
const SHELL_EMISSIVE = 0x2a2e34;
const FRAME_COLOR = 0x444b55;     // anodised side plates, column sleeve, base
const FRAME_EMISSIVE = 0x101318;
const STEEL_COLOR = 0xc9cfd8;     // motors, inner column, fasteners
const STEEL_EMISSIVE = 0x1c2026;
const ACCENT_COLOR = 0xff7a2e;    // sponge wheels + housing stripe
const ACCENT_EMISSIVE = 0x4a1e08;
const RUBBER_COLOR = 0x191b1f;    // hubs, hose, casters, knobs
const BALL_COLOR = 0xf4a83a;
const LIGHT_IDLE = 0x224422;
const LIGHT_ARMED = 0x33ff66;

// Barrel mouth position in HEAD-LOCAL space. The head is what rotates, so the
// mouth must be expressed in its frame: placing the machine by a world-space
// horizontal offset instead leaves the mouth swinging away from the spawn
// point as soon as the barrel elevates, which is why the ball appeared to
// come from beside the machine rather than out of its hole.
const MUZZLE_LOCAL_Z = 0.19;

// Throwing wheels. The gap between them is a touch under one ball diameter,
// as on the real thing: the sponge has to grip the ball to throw it.
const WHEEL_RADIUS = 0.046;
const WHEEL_WIDTH = 0.034;
const WHEEL_Z = 0.100;
const WHEEL_Y = WHEEL_RADIUS + ballRadius * 0.9;

// Stand. The head's height comes from the solved feed origin (FeedEngine puts
// the muzzle 0.38 m above the table), so the column is telescopic: a steel
// inner tube hangs from the head and slides inside a sleeve that stands on
// the floor. groundStand() moves the floor half every time the head moves, so
// the casters stay on FLOOR_LEVEL_Y instead of hovering. The clamp keeps the
// two tubes overlapping (and the sleeve out of the head) if the floor is
// somewhere unexpected.
const INNER_TUBE_TOP = -0.09;
const INNER_TUBE_LEN = 0.72;
const SLEEVE_BOTTOM = 0.07;      // above the floor
const SLEEVE_TOP = 0.52;         // above the floor
const STAND_DROP_MIN = 0.75;
const STAND_DROP_MAX = 1.30;

// Glide — how the machine travels between feed origins (Rapid Fire's sweep).
// The widest hop (L-far → R-far, ~0.92 m) must fit the shortest glide window
// the scheduler allows: interval 0.8 s minus the 0.25 s spin-up freeze
// (RECOVER also glides). At these values it takes ~0.52 s — cruise covers
// 0.74 m, then the arrive rate damps the last stretch so the machine settles
// rather than stopping dead. Lowering ARRIVE_RATE stretches that tail
// exponentially (ln(residual ratio)/rate), so re-check the window if tuning.
const GLIDE_MAX_SPEED = 1.8;    // m/s
const GLIDE_ARRIVE_RATE = 10;   // 1/s

// Module scratch — aim() runs once per feed, but allocating a Vector3 per call
// on a path that also runs during the render loop is avoidable noise. The
// glide gets its own scratch: it runs every frame from update(), a different
// call path than aim() in the same frame.
const _muzzleOffset = new THREE.Vector3();
const _glideGroupTarget = new THREE.Vector3();
const _glideOffset = new THREE.Vector3();
const _glideDelta = new THREE.Vector3();

function roundedRectShape(w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

/**
 * A box with rounded corners and bevelled faces, centred on the origin:
 * `w` × `h` across, `d` deep along Z. Hard-edged boxes are most of what made
 * the old machine look like a placeholder — real housings and plates have
 * radiused edges, and the bevel is what catches a highlight.
 */
function roundedBox(w, h, d, r, bevel = 0.004) {
  const geom = new THREE.ExtrudeGeometry(
    roundedRectShape(w - 2 * bevel, h - 2 * bevel, Math.max(r - bevel, 0.001)),
    {
      depth: d - 2 * bevel, bevelEnabled: true, bevelThickness: bevel,
      bevelSize: bevel, bevelSegments: 2, curveSegments: 5,
    },
  );
  geom.translate(0, 0, -(d - 2 * bevel) / 2);
  return geom;
}

// A cylinder lying along X (motors, axles, spacers).
function cylinderX(rTop, rBottom, length, segments = 20) {
  const geom = new THREE.CylinderGeometry(rTop, rBottom, length, segments);
  geom.rotateZ(Math.PI / 2);
  return geom;
}

// A cylinder lying along Z (the feed nozzle and muzzle).
function cylinderZ(rTop, rBottom, length, segments = 24, open = false) {
  const geom = new THREE.CylinderGeometry(rTop, rBottom, length, segments, 1, open);
  geom.rotateX(Math.PI / 2);
  return geom;
}

// Scratch for baking a part's placement into its vertices.
const _bake = new THREE.Object3D();
const _bakeColor = new THREE.Color();

/**
 * Queue one static part: a geometry, its material, and where it sits in the
 * parent's frame. `within` is an extra parent matrix (a leg inside its arm);
 * `color` paints the part's vertices, for materials that use vertexColors.
 */
function part(list, geom, mat, x = 0, y = 0, z = 0, {
  rx = 0, ry = 0, rz = 0, within = null, color = null,
} = {}) {
  _bake.position.set(x, y, z);
  _bake.rotation.set(rx, ry, rz);
  _bake.updateMatrix();
  const matrix = _bake.matrix.clone();
  if (within) matrix.premultiply(within);
  list.push({ geom, mat, matrix, color });
}

/**
 * Turn the queued parts into ONE mesh per material, parented to `parent`.
 *
 * The machine is some seventy separate shapes. Drawn as seventy meshes that
 * is seventy draw calls (doubled in stereo on the headset) for an object at
 * the far end of the table; merged, it is one per material. Nothing here
 * moves relative to its parent, so nothing is lost by baking.
 * Returns Map<material, mesh>.
 */
function mergeParts(list, parent) {
  const byMat = new Map();
  for (const p of list) {
    if (!byMat.has(p.mat)) byMat.set(p.mat, []);
    byMat.get(p.mat).push(p);
  }
  const meshes = new Map();
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const [mat, parts] of byMat) {
    let vertCount = 0;
    let indexCount = 0;
    for (const p of parts) {
      const n = p.geom.attributes.position.count;
      vertCount += n;
      indexCount += p.geom.index ? p.geom.index.count : n;
    }
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const colors = mat.vertexColors ? new Float32Array(vertCount * 3) : null;
    const indices = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const pos = p.geom.attributes.position;
      const nor = p.geom.attributes.normal;
      normalMatrix.getNormalMatrix(p.matrix);
      if (colors) _bakeColor.set(p.color == null ? 0xffffff : p.color);
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(p.matrix);
        positions[(vo + k) * 3] = v.x;
        positions[(vo + k) * 3 + 1] = v.y;
        positions[(vo + k) * 3 + 2] = v.z;
        v.fromBufferAttribute(nor, k).applyMatrix3(normalMatrix).normalize();
        normals[(vo + k) * 3] = v.x;
        normals[(vo + k) * 3 + 1] = v.y;
        normals[(vo + k) * 3 + 2] = v.z;
        if (colors) {
          colors[(vo + k) * 3] = _bakeColor.r;
          colors[(vo + k) * 3 + 1] = _bakeColor.g;
          colors[(vo + k) * 3 + 2] = _bakeColor.b;
        }
      }
      if (p.geom.index) {
        const idx = p.geom.index;
        for (let k = 0; k < idx.count; k++) indices[io + k] = idx.getX(k) + vo;
        io += idx.count;
      } else {
        for (let k = 0; k < pos.count; k++) indices[io + k] = vo + k;
        io += pos.count;
      }
      vo += pos.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
    const mesh = new THREE.Mesh(merged, mat);
    parent.add(mesh);
    meshes.set(mat, mesh);
  }
  // The sources were never drawn; release them now rather than leaving them
  // to the garbage collector.
  for (const p of list) p.geom.dispose();
  list.length = 0;
  return meshes;
}

// Deterministic 0..1 scatter for the bucket's balls: the pile must look the
// same every session, or screenshots cannot be compared.
function scatter(n) {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

export class BallMachineFigure {
  constructor() {
    this.state = 'IDLE';
    this.timeInState = 0;
    this.contactPose = null;
    this.onContact = null;
    this.wheelSpin = 0;
    this.wheelRate = 0;
    this.glideTarget = null;

    this.group = this.build();
    this.emitter = this.group;
  }

  get isIdle() { return this.state === 'IDLE'; }

  build() {
    const group = new THREE.Group();
    const env = ballEnvMap || null;
    // Metalness only where there is something to reflect (see "Look" above).
    const metal = (withEnv, without) => (env ? withEnv : without);

    const shellMat = new THREE.MeshStandardMaterial({
      color: SHELL_COLOR, roughness: 0.36, metalness: 0.0,
      emissive: SHELL_EMISSIVE, envMap: env, envMapIntensity: 0.55,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: FRAME_COLOR, roughness: 0.38, metalness: metal(0.8, 0.15),
      emissive: FRAME_EMISSIVE, envMap: env, envMapIntensity: 1.0,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: STEEL_COLOR, roughness: 0.26, metalness: metal(1.0, 0.2),
      emissive: STEEL_EMISSIVE, envMap: env, envMapIntensity: 1.0,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: ACCENT_COLOR, roughness: 0.5, metalness: 0.0,
      emissive: ACCENT_EMISSIVE, envMap: env, envMapIntensity: 0.3,
    });
    // Wheels: fully rough, no reflection — the contrast with the plates
    // around them is what makes the sponge read as a soft material. Tyre,
    // hub and tread stripes are one mesh, told apart by vertex colour.
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0.0,
      emissive: 0x2a1408,
    });
    const rubberMat = new THREE.MeshStandardMaterial({
      color: RUBBER_COLOR, roughness: 0.7, metalness: 0.0,
      emissive: 0x08090b, envMap: env, envMapIntensity: 0.35,
    });
    const boreMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d10, roughness: 1.0, metalness: 0.0,
      side: THREE.BackSide,          // see the inner wall, so it reads deep
    });
    const ballMat = new THREE.MeshStandardMaterial({
      color: BALL_COLOR, roughness: 0.55,
      emissive: 0x3a2708, envMap: env, envMapIntensity: 0.25,
    });

    this.buildHead(group, {
      shellMat, frameMat, steelMat, accentMat, wheelMat, rubberMat, boreMat,
    });
    this.buildStand(group, {
      shellMat, frameMat, steelMat, accentMat, rubberMat, ballMat, env,
    });

    scene.add(group);
    return group;
  }

  // Head — the part that aims. Everything that must point along the launch
  // direction is parented here, so aiming is one quaternion set. Its origin
  // is the ball joint; +Z is the firing axis.
  buildHead(group, m) {
    this.head = new THREE.Group();
    group.add(this.head);
    const parts = [];
    const add = (geom, mat, x = 0, y = 0, z = 0) => part(parts, geom, mat, x, y, z);

    // Housing behind the wheels: ball feeder and electronics.
    add(roundedBox(0.124, 0.124, 0.160, 0.030, 0.007), m.shellMat, 0, 0, -0.035);
    // One saturated stripe. A uniform light shape reads as scenery at table
    // length, especially in passthrough where it competes with furniture.
    add(roundedBox(0.128, 0.128, 0.022, 0.032, 0.003), m.accentMat, 0, 0, -0.060);
    // Rear cap, where the ball hose would enter.
    add(roundedBox(0.090, 0.090, 0.012, 0.022, 0.003), m.frameMat, 0, 0, -0.119);
    // Feed nozzle: hands the ball from the housing to the wheels.
    add(cylinderZ(0.027, 0.040, 0.022, 24), m.frameMat, 0, 0, 0.055);
    // Its mouth is dark. Looking down the muzzle the player sees straight
    // through to here, and a light housing behind the bore turns the hole
    // into something that reads as a lens.
    add(new THREE.CircleGeometry(0.0262, 24), m.rubberMat, 0, 0, 0.0665);

    // Side plates. They carry both axles and the muzzle, and they are what
    // the motors bolt to.
    const plateGeom = roundedBox(0.168, 0.236, 0.006, 0.034, 0.0015);
    plateGeom.rotateY(Math.PI / 2);
    for (const side of [-1, 1]) {
      add(plateGeom, m.frameMat, side * 0.046, 0, 0.104);
    }
    // Spacer rods at the four corners hold the plates apart.
    const rodGeom = cylinderX(0.0045, 0.0045, 0.098, 10);
    for (const ry of [-0.100, 0.100]) {
      for (const rz of [0.038, 0.170]) add(rodGeom, m.steelMat, 0, ry, rz);
    }

    // Muzzle: a short guide ring past the wheels. This is what the ball
    // visibly leaves, so it is built to read as an opening — a metal sleeve
    // around a black bore, finished with a lip. Without the dark interior the
    // hole looks like a flat cap.
    const MUZZLE_LEN = 0.040;
    const muzzleZ = MUZZLE_LOCAL_Z - MUZZLE_LEN / 2;
    add(cylinderZ(0.031, 0.031, MUZZLE_LEN, 28, true), m.steelMat, 0, 0, muzzleZ);
    add(cylinderZ(0.0255, 0.0255, MUZZLE_LEN, 28, true), m.boreMat, 0, 0, muzzleZ);
    add(new THREE.TorusGeometry(0.0283, 0.0030, 10, 28), m.steelMat, 0, 0, MUZZLE_LOCAL_Z - 0.002);
    add(new THREE.TorusGeometry(0.0283, 0.0030, 10, 28), m.frameMat, 0, 0, MUZZLE_LOCAL_Z - MUZZLE_LEN);
    // Lugs joining the muzzle sleeve to the plates.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.014, 0.018, 0.030), m.frameMat, side * 0.0375, 0, muzzleZ);
    }

    // Throwing wheels, one above and one below the ball path, each driven by
    // its own motor. Their spin is what sells the machine as powered, and
    // their rate tracks the feed cycle.
    const tyreGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 32);
    const hubGeom = new THREE.CylinderGeometry(0.019, 0.019, WHEEL_WIDTH + 0.006, 20);
    const hubCapGeom = new THREE.CylinderGeometry(0.010, 0.010, WHEEL_WIDTH + 0.012, 14);
    // Tread stripes — a plain orange disc gives no cue that it is turning.
    // From the player's side the wheels are seen tread-on, so the stripes go
    // across the tread, not on the faces the plates hide.
    const stripeGeom = new THREE.BoxGeometry(0.004, WHEEL_WIDTH + 0.0006, 0.011);
    const motorGeom = cylinderX(0.021, 0.021, 0.052, 22);
    const motorCapGeom = cylinderX(0.0225, 0.0225, 0.008, 22);
    const nutGeom = cylinderX(0.008, 0.008, 0.010, 6);
    const STRIPES = 5;

    this.wheels = [];
    for (const side of [-1, 1]) {   // -1 = lower wheel, +1 = upper wheel
      // The wheel sits in a HOLDER that carries the axle orientation, and
      // spins about its own local Y inside it.
      //
      // Setting rotation.z (to lay the axle across the head) and rotation.y
      // (to spin it) on the same mesh does NOT work: with Euler order 'XYZ'
      // the z-rotation is applied first, so the subsequent y-rotation turns
      // the wheel about the WORLD vertical and it tumbles end-over-end
      // instead of spinning on its axle.
      const holder = new THREE.Group();
      holder.rotation.z = Math.PI / 2;
      holder.position.set(0, side * WHEEL_Y, WHEEL_Z);
      const wheelParts = [];
      part(wheelParts, tyreGeom.clone(), m.wheelMat, 0, 0, 0, { color: ACCENT_COLOR });
      part(wheelParts, hubGeom.clone(), m.wheelMat, 0, 0, 0, { color: RUBBER_COLOR });
      part(wheelParts, hubCapGeom.clone(), m.wheelMat, 0, 0, 0, { color: STEEL_COLOR });
      for (let k = 0; k < STRIPES; k++) {
        const a = (k / STRIPES) * Math.PI * 2;
        part(
          wheelParts, stripeGeom.clone(), m.wheelMat,
          Math.cos(a) * (WHEEL_RADIUS - 0.0015), 0, Math.sin(a) * (WHEEL_RADIUS - 0.0015),
          { ry: -a, color: 0xfff1dc },
        );
      }
      const wheel = mergeParts(wheelParts, holder).get(m.wheelMat);
      this.head.add(holder);
      this.wheels.push({ mesh: wheel, dir: side });

      // Motor outboard of one plate, axle nut on the other. The two motors
      // sit on opposite sides, as they do on a real head, which also keeps
      // the silhouette from looking mirrored and toy-like.
      add(motorGeom, m.steelMat, side * 0.075, side * WHEEL_Y, WHEEL_Z);
      add(motorCapGeom, m.rubberMat, side * 0.104, side * WHEEL_Y, WHEEL_Z);
      add(nutGeom, m.steelMat, -side * 0.053, side * WHEEL_Y, WHEEL_Z);
    }

    // Status light — dim at rest, bright while a feed is arming. A silent
    // visual cue that pairs with the audio tick. Sits on the housing's front
    // top edge, in a dark bezel so the lit dome has something to contrast
    // with on a light housing.
    add(new THREE.CylinderGeometry(0.019, 0.021, 0.008, 18), m.rubberMat, 0, 0.065, 0.012);
    mergeParts(parts, this.head);
    for (const g of [tyreGeom, hubGeom, hubCapGeom, stripeGeom]) g.dispose();

    this.lightMat = new THREE.MeshStandardMaterial({
      color: LIGHT_IDLE, emissive: LIGHT_IDLE, emissiveIntensity: 0.6,
    });
    this.light = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 10), this.lightMat);
    this.light.position.set(0, 0.069, 0.012);
    this.head.add(this.light);
  }

  // Stand — everything that does NOT aim. Not parented to the head, so
  // tilting the head doesn't swing the legs into the air. Two halves: the
  // part that hangs from the head (ball joint, inner tube, control box, ball
  // bucket) and the part that stands on the floor (sleeve, legs, casters).
  buildStand(group, m) {
    this.stand = new THREE.Group();
    group.add(this.stand);
    const parts = [];
    const add = (geom, mat, x, y, z, opts) => part(parts, geom, mat, x, y, z, opts);

    // Ball joint under the housing, in its clamp.
    add(new THREE.SphereGeometry(0.036, 20, 14), m.steelMat, 0, -0.066, 0);
    add(new THREE.CylinderGeometry(0.040, 0.027, 0.036, 24), m.frameMat, 0, -0.098, 0);
    add(cylinderX(0.006, 0.006, 0.050, 10), m.steelMat, 0.045, -0.098, 0);
    add(new THREE.SphereGeometry(0.013, 12, 10), m.rubberMat, 0.074, -0.098, 0);

    // Inner tube.
    add(
      new THREE.CylinderGeometry(0.019, 0.019, INNER_TUBE_LEN, 20), m.steelMat,
      0, INNER_TUBE_TOP - INNER_TUBE_LEN / 2, 0,
    );

    // Control box on the column, facing the player: display, four knobs.
    const boxY = -0.215;
    add(roundedBox(0.120, 0.074, 0.040, 0.010, 0.003), m.frameMat, 0, boxY, 0.036);
    add(
      new THREE.PlaneGeometry(0.052, 0.026),
      new THREE.MeshStandardMaterial({
        color: 0x0a1a1c, emissive: 0x2fd6c8, emissiveIntensity: 0.55, roughness: 0.3,
      }),
      -0.026, boxY + 0.012, 0.0565,
    );
    const knobGeom = cylinderZ(0.0075, 0.0085, 0.010, 14);
    for (const [kx, ky] of [[0.018, 0.014], [0.040, 0.014], [0.018, -0.012], [0.040, -0.012]]) {
      add(knobGeom, ky > 0 ? m.rubberMat : m.accentMat, kx, boxY + ky, 0.061);
    }

    // Ball bucket behind the head, on its own mast, with a hose down into the
    // column. A visible supply of balls is the clearest single cue that this
    // is a ball machine rather than a generic device.
    const BUCKET_Z = -0.235;
    const BUCKET_BOTTOM = 0.125;
    const BUCKET_TOP = 0.305;
    const R_BOTTOM = 0.085;
    const R_TOP = 0.125;
    const bucketMat = new THREE.MeshStandardMaterial({
      color: 0xd3e6f4, roughness: 0.08, metalness: 0.0,
      transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide,
      emissive: 0x1a2228, envMap: m.env, envMapIntensity: 1.0,
    });
    const bucketH = BUCKET_TOP - BUCKET_BOTTOM;
    add(
      new THREE.CylinderGeometry(R_TOP, R_BOTTOM, bucketH, 32, 1, true), bucketMat,
      0, BUCKET_BOTTOM + bucketH / 2, BUCKET_Z,
    );
    add(
      new THREE.TorusGeometry(R_TOP, 0.0045, 8, 36), m.shellMat,
      0, BUCKET_TOP, BUCKET_Z, { rx: Math.PI / 2 },
    );
    // Funnel and collar under the bucket.
    add(
      new THREE.CylinderGeometry(R_BOTTOM + 0.003, 0.030, 0.050, 28), m.shellMat,
      0, BUCKET_BOTTOM - 0.025, BUCKET_Z,
    );
    add(
      new THREE.CylinderGeometry(0.031, 0.031, 0.020, 20), m.frameMat,
      0, BUCKET_BOTTOM - 0.058, BUCKET_Z,
    );

    // Balls: only the ones that can be seen — the outer ring of each layer
    // through the clear wall, and the heap on top. One instanced draw.
    const spots = [];
    const pitch = ballRadius * 2.06;
    let n = 0;
    for (let layer = 0; layer < 40; layer++) {
      const y = BUCKET_BOTTOM + ballRadius + 0.004 + layer * pitch * 0.84;
      const heap = y - BUCKET_TOP;               // > 0: above the rim
      if (heap > 0.030) break;
      const wallR = R_BOTTOM + (R_TOP - R_BOTTOM) * Math.min((y - BUCKET_BOTTOM) / bucketH, 1);
      // Above the rim the pile narrows to a mound instead of a cylinder.
      const maxR = wallR - ballRadius - 0.003 - Math.max(heap + 0.02, 0) * 1.6;
      const top = y + pitch > BUCKET_TOP;
      for (let gx = -4; gx <= 4; gx++) {
        for (let gz = -4; gz <= 4; gz++) {
          n++;
          const x = (gx + (gz & 1) * 0.5 + (layer & 1) * 0.5) * pitch + (scatter(n) - 0.5) * 0.006;
          const z = (gz * 0.87 + (layer & 1) * 0.3) * pitch + (scatter(n + 0.5) - 0.5) * 0.006;
          const r = Math.hypot(x, z);
          if (r > maxR) continue;
          if (!top && r < maxR - pitch * 1.1) continue;   // hidden in the middle
          spots.push([x, y + (scatter(n + 0.25) - 0.5) * 0.006, z]);
        }
      }
    }
    const balls = new THREE.InstancedMesh(
      new THREE.SphereGeometry(ballRadius, 8, 6), m.ballMat, spots.length,
    );
    const mtx = new THREE.Matrix4();
    spots.forEach(([x, y, z], idx) => {
      balls.setMatrixAt(idx, mtx.makeTranslation(x, y, BUCKET_Z + z));
    });
    balls.instanceMatrix.needsUpdate = true;
    balls.renderOrder = 1;
    this.stand.add(balls);

    // Hose from the bucket's collar down and forward into the column.
    const hosePath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, BUCKET_BOTTOM - 0.066, BUCKET_Z),
      new THREE.Vector3(0, -0.060, BUCKET_Z - 0.006),
      new THREE.Vector3(0, -0.230, -0.170),
      new THREE.Vector3(0, -0.300, -0.012),
    ]);
    add(new THREE.TubeGeometry(hosePath, 28, 0.024, 12, false), m.rubberMat, 0, 0, 0);
    add(new THREE.CylinderGeometry(0.031, 0.031, 0.050, 20), m.frameMat, 0, -0.300, 0);

    // Mast: an arm back from the column, a post up the bucket's rear, and a
    // hoop around it.
    const MAST_Z = BUCKET_Z - R_TOP + 0.004;
    const ARM_Y = -0.380;
    const HOOP_Y = BUCKET_BOTTOM + 0.05;
    add(new THREE.CylinderGeometry(0.030, 0.030, 0.040, 20), m.frameMat, 0, ARM_Y, 0);
    add(cylinderZ(0.011, 0.011, -MAST_Z, 12), m.frameMat, 0, ARM_Y, MAST_Z / 2);
    add(
      new THREE.CylinderGeometry(0.011, 0.011, HOOP_Y - ARM_Y, 12), m.frameMat,
      0, (HOOP_Y + ARM_Y) / 2, MAST_Z,
    );
    add(new THREE.SphereGeometry(0.011, 10, 8), m.frameMat, 0, ARM_Y, MAST_Z);
    const hoopR = R_BOTTOM + (R_TOP - R_BOTTOM) * ((HOOP_Y - BUCKET_BOTTOM) / bucketH) + 0.004;
    add(
      new THREE.TorusGeometry(hoopR, 0.005, 8, 36), m.frameMat,
      0, HOOP_Y, BUCKET_Z, { rx: Math.PI / 2 },
    );
    // The clear wall draws after the balls inside it.
    mergeParts(parts, this.stand).get(bucketMat).renderOrder = 2;

    // Floor half: sleeve, clamp, hub, three legs on casters. Its origin is
    // the floor; groundStand() keeps it there.
    this.base = new THREE.Group();
    this.stand.add(this.base);
    const addBase = (geom, mat, x, y, z, opts) => part(parts, geom, mat, x, y, z, opts);
    addBase(
      new THREE.CylinderGeometry(0.026, 0.026, SLEEVE_TOP - SLEEVE_BOTTOM, 20), m.frameMat,
      0, (SLEEVE_TOP + SLEEVE_BOTTOM) / 2, 0,
    );
    addBase(new THREE.CylinderGeometry(0.033, 0.033, 0.044, 20), m.accentMat, 0, SLEEVE_TOP, 0);
    addBase(cylinderX(0.006, 0.006, 0.040, 10), m.steelMat, 0.045, SLEEVE_TOP, 0);
    addBase(new THREE.SphereGeometry(0.013, 12, 10), m.rubberMat, 0.068, SLEEVE_TOP, 0);
    addBase(new THREE.CylinderGeometry(0.046, 0.052, 0.070, 22), m.frameMat, 0, 0.095, 0);

    const LEG_LEN = 0.30;
    const legGeom = roundedBox(0.034, 0.024, LEG_LEN, 0.008, 0.003);
    const casterGeom = cylinderX(0.024, 0.024, 0.020, 16);
    const forkGeom = new THREE.BoxGeometry(0.030, 0.034, 0.016);
    // One leg straight back, under the bucket's weight, and two forward and
    // out, clear of the table's own legs.
    for (const deg of [180, 55, -55]) {
      const within = new THREE.Matrix4()
        .makeRotationY(THREE.MathUtils.degToRad(deg))
        .setPosition(0, 0.078, 0);
      // rx: a slight droop toward the caster.
      addBase(legGeom.clone(), m.frameMat, 0, -0.008, 0.035 + LEG_LEN / 2, { rx: 0.07, within });
      addBase(forkGeom.clone(), m.frameMat, 0, -0.036, 0.020 + LEG_LEN, { within });
      addBase(casterGeom.clone(), m.rubberMat, 0, -0.054, 0.020 + LEG_LEN, { within });
    }
    mergeParts(parts, this.base);
    for (const g of [legGeom, casterGeom, forkGeom]) g.dispose();

    this.groundStand(group);
  }

  /**
   * Stand the floor half on the floor. The head's height is set by the feed
   * (and shifts a little with every change of elevation), so the column
   * telescopes rather than the base hovering.
   */
  groundStand(group = this.group) {
    if (!this.base || !group) return;
    this.base.position.y = -THREE.MathUtils.clamp(
      group.position.y - FLOOR_LEVEL_Y, STAND_DROP_MIN, STAND_DROP_MAX,
    );
  }

  /**
   * Place the machine so its MUZZLE sits at `muzzlePos`, aimed along `aimDir`.
   *
   * The body is pushed back along the aim by MUZZLE_OFFSET so the ball leaves
   * the barrel mouth rather than materialising inside the housing.
   */
  aim(muzzlePos, aimDir) {
    if (!this.group) return;

    const flat = aimDir.clone();
    flat.y = 0;                                  // the machine stays upright
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
    flat.normalize();

    const yaw = Math.atan2(flat.x, flat.z);
    const elevation = Math.asin(
      THREE.MathUtils.clamp(aimDir.clone().normalize().y, -1, 1),
    );

    // NEGATIVE elevation on the X axis. A positive rotation about X carries
    // +Z toward −Y, so passing +elevation aimed a lob at the FLOOR. The
    // barrel now rises for a lob and drops for a driven feed, matching the
    // shot the solver actually produced.
    this.head.quaternion.setFromEuler(new THREE.Euler(-elevation, yaw, 0, 'YXZ'));

    // Place the body so the barrel MOUTH lands exactly on the spawn point,
    // by subtracting the mouth's offset rotated into world space. This is the
    // whole fix for "the ball comes from somewhere else": the offset has to
    // follow the head's rotation, not a flattened horizontal direction.
    _muzzleOffset.set(0, 0, MUZZLE_LOCAL_Z).applyQuaternion(this.head.quaternion);
    this.group.position.copy(muzzlePos).sub(_muzzleOffset);
    this.groundStand();
  }

  /**
   * Arm a feed. `contactPose.position` is where the ball will spawn, so the
   * machine aims its muzzle there; `onContact` fires at release.
   *
   * Named beginSwing for drop-in compatibility with the ServerFigure it
   * replaced (see the header note on inherited names).
   */
  beginSwing(contactPose, onContact, aimVelocity = null) {
    if (!this.group || this.state !== 'IDLE') return false;
    this.contactPose = contactPose;
    this.onContact = onContact || null;
    const dir = aimVelocity ? aimVelocity.clone() : contactPose.normal.clone();
    this.aim(contactPose.position, dir);
    this.state = 'SPINUP';
    this.timeInState = 0;
    return true;
  }

  // Inherited-API parity: the machine has no held-ball decoration, so this is
  // a no-op rather than an error. Keeps the drill's call sites identical.
  showHeldBall() { /* machines don't hold a ball on a paddle face */ }

  /**
   * Glide the machine so its muzzle travels to `muzzlePos`. Purely cosmetic:
   * the glide is NOT a state and never blocks isIdle, so it cannot delay a
   * feed — aim() at beginSwing stays the authoritative snap and absorbs any
   * residual centimetres of unfinished travel.
   *
   * `immediate` snaps instead of gliding, for drill start: without it the
   * machine would visibly sail in from wherever the group happened to be.
   */
  glideTo(muzzlePos, { immediate = false } = {}) {
    if (!this.group) return;
    if (immediate) {
      this.glideTarget = null;
      this.aim(muzzlePos, _glideDelta.set(0, 0, 1));
      return;
    }
    if (!this.glideTarget) this.glideTarget = new THREE.Vector3();
    this.glideTarget.copy(muzzlePos);
  }

  updateGlide(dt) {
    // Frozen during SPINUP: the ball spawns at the pose that was aimed, so
    // moving the group then would detach the launch from the muzzle.
    if (!this.glideTarget || this.state === 'SPINUP') return;
    // Group-space target: where the group must sit for the muzzle to land on
    // the target, using the CURRENT head orientation. The next shot's exact
    // elevation is unknown at preview time; aim() corrects the residual.
    _glideOffset.set(0, 0, MUZZLE_LOCAL_Z).applyQuaternion(this.head.quaternion);
    _glideGroupTarget.copy(this.glideTarget).sub(_glideOffset);
    _glideDelta.copy(_glideGroupTarget).sub(this.group.position);
    const dist = _glideDelta.length();
    if (dist < 1e-3) {
      this.glideTarget = null;
      return;
    }
    const speed = Math.min(GLIDE_MAX_SPEED, GLIDE_ARRIVE_RATE * dist);
    const step = Math.min(dist, speed * dt);
    this.group.position.addScaledVector(_glideDelta.divideScalar(dist), step);
    this.groundStand();
  }

  setLight(armed, t = 1) {
    if (!this.lightMat) return;
    const color = armed ? LIGHT_ARMED : LIGHT_IDLE;
    this.lightMat.color.setHex(color);
    this.lightMat.emissive.setHex(color);
    this.lightMat.emissiveIntensity = armed ? 0.6 + 1.4 * t : 0.6;
  }

  update(dt) {
    if (!this.group) return;

    switch (this.state) {
      case 'IDLE':
        // Idle drift keeps the machine looking powered without implying an
        // imminent feed.
        this.wheelRate = 2.5;
        this.setLight(false);
        break;
      case 'SPINUP': {
        this.timeInState += dt;
        const u = Math.min(this.timeInState / SPINUP_DURATION, 1);
        this.wheelRate = 2.5 + 55 * u * u;   // audible-looking acceleration
        this.setLight(true, u);
        if (this.timeInState >= SPINUP_DURATION) this.fireContact();
        break;
      }
      case 'RECOVER': {
        this.timeInState += dt;
        const u = Math.min(this.timeInState / RECOVER_DURATION, 1);
        this.wheelRate = 57 * (1 - u) + 2.5 * u;
        this.setLight(false);
        if (this.timeInState >= RECOVER_DURATION) {
          this.state = 'IDLE';
          this.timeInState = 0;
        }
        break;
      }
    }

    // Counter-rotation: the two wheels must spin opposite ways or they read
    // as decoration rather than as the thing gripping the ball.
    this.wheelSpin += this.wheelRate * dt;
    for (const w of this.wheels) {
      w.mesh.rotation.y = this.wheelSpin * w.dir;
    }

    this.updateGlide(dt);
  }

  fireContact() {
    this.state = 'RECOVER';
    this.timeInState = 0;
    if (this.onContact) {
      const cb = this.onContact;
      this.onContact = null;
      cb();
    }
  }

  dispose() {
    if (this.group) {
      scene.remove(this.group);
      this.group.traverse((node) => {
        if (node.geometry && node.geometry.dispose) node.geometry.dispose();
        if (node.material && node.material.dispose) node.material.dispose();
      });
      this.group = null;
      this.emitter = null;
      this.head = null;
      this.stand = null;
      this.base = null;
      this.wheels = [];
    }
    this.onContact = null;
    this.glideTarget = null;
  }
}

// Re-exported so callers (and tests) can locate the barrel mouth consistently
// with how the machine draws itself.
export { MUZZLE_LOCAL_Z };
