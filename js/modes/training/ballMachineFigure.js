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
import { scene } from '../../scene/sceneSetup.js';
import { ballRadius } from '../../scene/models.js';

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

// Palette.
//
// The first pass used near-black greys (body 0x2a2f36 on 0x1a1d22 wheels),
// which vanished against both a dark arena backdrop and MR passthrough. The
// machine sits at the far end of the table — the furthest object the player
// looks at — so it has to read at distance in whatever lighting the room
// happens to have.
//
// Two decisions follow from that: mid-tone body colours rather than dark
// ones, and a modest EMISSIVE term on every part. Emissive matters because
// MeshStandardMaterial is entirely lighting-dependent, and in `immersive-ar`
// the scene lights are a guess at the real room — a purely lit material can
// come out almost black through passthrough regardless of its base colour.
const BODY_COLOR = 0x8d97a6;      // light slate — reads against dark and light
const BODY_EMISSIVE = 0x2c333d;
const TRIM_COLOR = 0xc6d0dc;      // brighter than the body, for edges
const TRIM_EMISSIVE = 0x39424e;
const ACCENT_COLOR = 0xff9d3d;    // warm band: separates it from the table
const WHEEL_COLOR = 0x30363f;     // dark ON the light body, so spin is legible
const LIGHT_IDLE = 0x224422;
const LIGHT_ARMED = 0x33ff66;

// Barrel mouth position in HEAD-LOCAL space. The head is what rotates, so the
// mouth must be expressed in its frame: placing the machine by a world-space
// horizontal offset instead leaves the mouth swinging away from the spawn
// point as soon as the barrel elevates, which is why the ball appeared to
// come from beside the machine rather than out of its hole.
const MUZZLE_LOCAL_Z = 0.19;

// How far the machine floats above the floor. Its own height comes from the
// solved feed origin (FeedEngine puts the muzzle 0.38 m above the table), so
// the stand just reaches down toward the floor for visual grounding.
const STAND_DROP = 0.72;

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

    // Head — the part that aims. Everything that must point along the launch
    // direction is parented here, so aiming is one quaternion set.
    this.head = new THREE.Group();
    group.add(this.head);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: BODY_COLOR, roughness: 0.55, metalness: 0.15,
      emissive: BODY_EMISSIVE, emissiveIntensity: 1,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: TRIM_COLOR, roughness: 0.45, metalness: 0.2,
      emissive: TRIM_EMISSIVE, emissiveIntensity: 1,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: ACCENT_COLOR, roughness: 0.4, metalness: 0.0,
      emissive: ACCENT_COLOR, emissiveIntensity: 0.5,
    });
    // Low metalness throughout: a high-metalness material with no environment
    // map to reflect renders dark, which is part of why the first pass
    // disappeared even where the scene was lit.

    // Body — a barrel-shaped drum along the firing axis (+Z). A cylinder
    // reads as a launcher; the box it replaced read as a crate.
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.115, 0.125, 0.30, 28), bodyMat,
    );
    body.rotation.x = Math.PI / 2;
    body.position.z = -0.02;
    this.head.add(body);

    // Accent ring around the drum. A single saturated band is what makes the
    // machine identifiable at table length — a uniform grey shape reads as
    // scenery, especially in passthrough where it competes with furniture.
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.128, 0.128, 0.045, 28), accentMat,
    );
    band.rotation.x = Math.PI / 2;
    band.position.z = -0.02;
    this.head.add(band);

    // Muzzle assembly at the front. This is what the ball visibly leaves, so
    // it is built to read as an opening: a bright collar around a recessed
    // black bore. Without the dark interior the "hole" looks like a flat cap.
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(0.058, 0.017, 12, 28), trimMat,
    );
    collar.position.z = MUZZLE_LOCAL_Z - 0.005;
    this.head.add(collar);

    const throat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, 0.10, 24, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x0d1014, roughness: 1.0, metalness: 0.0,
        side: THREE.BackSide,          // see the inner wall, so it reads deep
      }),
    );
    throat.rotation.x = Math.PI / 2;
    throat.position.z = MUZZLE_LOCAL_Z - 0.055;
    this.head.add(throat);

    // Hopper — an open basket of balls on top, the clearest single cue that
    // this is a ball machine rather than a generic device.
    const hopper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.062, 0.11, 22, 1, true), trimMat,
    );
    hopper.position.set(0, 0.15, -0.05);
    this.head.add(hopper);

    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xf4a83a, roughness: 0.6,
      emissive: 0x3a2708, emissiveIntensity: 1,
    });
    const hopperBallGeom = new THREE.SphereGeometry(ballRadius * 1.05, 12, 10);
    for (const [hx, hz] of [[-0.035, -0.03], [0.035, -0.03], [0, 0.02], [0, -0.075]]) {
      const b = new THREE.Mesh(hopperBallGeom, ballMat);
      b.position.set(hx, 0.175, -0.05 + hz);
      this.head.add(b);
    }

    // Counter-rotating launch wheels flanking the muzzle. Their spin is what
    // sells the machine as powered, and their rate tracks feed speed.
    const wheelGeom = new THREE.CylinderGeometry(0.055, 0.055, 0.020, 20);
    // Wheels stay dark ON PURPOSE — they are now the dark element against a
    // light body rather than dark-on-dark, so their rotation is readable.
    const wheelMat = new THREE.MeshStandardMaterial({
      color: WHEEL_COLOR, roughness: 0.85, metalness: 0.0,
      emissive: 0x14181d, emissiveIntensity: 1,
    });
    this.wheels = [];
    for (const side of [-1, 1]) {
      // The wheel sits in a HOLDER that carries the axle orientation, and
      // spins about its own local Y inside it.
      //
      // Setting rotation.z (to lay the axle across the barrel) and rotation.y
      // (to spin it) on the same mesh does NOT work: with Euler order 'XYZ'
      // the z-rotation is applied first, so the subsequent y-rotation turns
      // the wheel about the WORLD vertical and it tumbles end-over-end
      // instead of spinning on its axle.
      const holder = new THREE.Group();
      holder.rotation.z = Math.PI / 2;
      // Flanking the throat, just behind the collar — where a real machine's
      // counter-rotating wheels grip the ball on its way out.
      holder.position.set(side * 0.098, 0, MUZZLE_LOCAL_Z - 0.055);
      const wheel = new THREE.Mesh(wheelGeom, wheelMat);
      holder.add(wheel);

      // Rim marker — a plain disc gives no visual cue that it is turning.
      const markGeom = new THREE.BoxGeometry(0.012, 0.024, 0.05);
      const markMat = new THREE.MeshStandardMaterial({
        color: ACCENT_COLOR, roughness: 0.5,
        emissive: ACCENT_COLOR, emissiveIntensity: 0.5,
      });
      const mark = new THREE.Mesh(markGeom, markMat);
      mark.position.set(0, 0, 0.036);
      wheel.add(mark);

      this.head.add(holder);
      this.wheels.push({ mesh: wheel, dir: side });
    }

    // Status light — dim at rest, bright while a feed is arming. A silent
    // visual cue that pairs with the audio tick.
    this.lightMat = new THREE.MeshStandardMaterial({
      color: LIGHT_IDLE, emissive: LIGHT_IDLE, emissiveIntensity: 0.6,
    });
    this.light = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), this.lightMat);
    // Sits proud of the drum's upper surface (radius 0.115) rather than
    // embedded in it, and forward of the hopper so it isn't occluded.
    this.light.position.set(0, 0.122, 0.09);
    this.head.add(this.light);

    // Stand — post plus base. Not parented to the head, so aiming the barrel
    // doesn't swing the legs into the air.
    this.stand = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.026, STAND_DROP, 12), bodyMat,
    );
    post.position.y = -STAND_DROP / 2;
    this.stand.add(post);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, 0.02, 20), bodyMat,
    );
    base.position.y = -STAND_DROP;
    this.stand.add(base);
    group.add(this.stand);

    scene.add(group);
    return group;
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
      this.wheels = [];
    }
    this.onContact = null;
    this.glideTarget = null;
  }
}

// Re-exported so callers (and tests) can locate the barrel mouth consistently
// with how the machine draws itself.
export { MUZZLE_LOCAL_Z };
