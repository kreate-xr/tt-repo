// Align the world to the wearer at session start.
//
// The whole scene is built around the local-floor origin facing -Z
// (models.js: player at origin, table PLAYER_TO_NEAR_EDGE_M ahead). But the
// runtime does NOT put that origin where the player is looking when they
// press Enter: Quest Browser keeps local-floor tied to the system's last
// recenter / boundary forward. A player who launched from the 2D browser
// panel parked off to one side therefore spawned with the table beside them.
//
// Fix: on the first frame with a viewer pose, read the head's floor position
// and yaw in the base space and switch three.js onto an offset reference
// space whose origin is exactly there. Pitch/roll and height stay with the
// runtime (local-floor y=0 is the real floor). Re-run after an XRReferenceSpace
// 'reset' (Meta-button recenter) so a new wearer is re-aligned too.

/**
 * Floor-plane origin + yaw (radians about +Y) for a head pose. Pure math so
 * it is testable headless.
 *
 * Forward is the head's -Z projected onto the floor. Looking nearly straight
 * down collapses that, so fall back to the head's +Y (which then points the
 * way the face is turned).
 */
function computeAlignment(position, orientation) {
  const { x: qx, y: qy, z: qz, w: qw } = orientation;
  // Rotate (0,0,-1) and (0,1,0) by q, keep only x/z.
  let fx = -(2 * (qx * qz + qw * qy));
  let fz = -(1 - 2 * (qx * qx + qy * qy));
  if (fx * fx + fz * fz < 0.04) {
    fx = 2 * (qx * qy - qw * qz);
    fz = 2 * (qy * qz + qw * qx);
  }
  // Yaw that maps the origin's -Z onto (fx, fz).
  const yaw = Math.atan2(-fx, -fz);
  return { x: position.x, z: position.z, yaw };
}

/**
 * @param {THREE.WebXRManager} xrManager  renderer.xr
 * @param {XRReferenceSpace} baseSpace    the session's local-floor space
 * @param {() => void} onAligned          every tracked pose jumps on align —
 *                                        callers snap/suppress contacts here
 */
function createViewerAlign(xrManager, baseSpace, onAligned) {
  let pending = true;
  return {
    /** Re-align on the next frame (after a recenter). */
    request() { pending = true; },
    /** Call once per XR frame; a no-op once aligned. */
    update(frame) {
      if (!pending || !frame || !baseSpace) return;
      const pose = frame.getViewerPose(baseSpace);
      if (!pose) return; // tracking not up yet — try next frame
      const a = computeAlignment(pose.transform.position, pose.transform.orientation);
      const half = a.yaw / 2;
      const offset = baseSpace.getOffsetReferenceSpace(new XRRigidTransform(
        { x: a.x, y: 0, z: a.z },
        { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      ));
      xrManager.setReferenceSpace(offset);
      pending = false;
      console.log(`[XR] world aligned to wearer — origin (${a.x.toFixed(2)}, ${a.z.toFixed(2)}), yaw ${(a.yaw * 180 / Math.PI).toFixed(0)}°`);
      if (onAligned) onAligned();
    },
  };
}

export { computeAlignment, createViewerAlign };
