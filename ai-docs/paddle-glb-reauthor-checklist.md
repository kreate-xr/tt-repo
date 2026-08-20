# Paddle.glb re-authoring checklist

> **STATUS: superseded for now.** The game no longer loads this asset by
> default. The shipping bat is built in code from `js/physics/paddleSpec.js`
> (numbers) and `js/scene/paddleGeometry.js` (mesh); `Paddle.glb` stays loadable
> behind `?paddle=glb` for A/B and this document remains the spec if the asset
> is ever re-authored. Everything below still applies to a GLB — but note that
> §3, the reason this checklist existed, is now solved in code: the layers are
> real geometry sharing one silhouette, so the rim is a genuine sandwich and the
> throat a genuine flare. A re-authored GLB has to beat that, not just match the
> old one. Before starting one, read the trade in the header of `paddleSpec.js`:
> defining the bat is what made its mass, balance and collision disc exact, and
> going back to an asset means going back to recovering those by measurement.

Why: the current `public/models/Paddle.glb` is authored like a mobile prop — one
mesh, one uniform semi-gloss material, flat butt joint between face and handle.
At VR viewing distance (~30 cm from the eyes) it reads as a plastic toy with
sticker decals, not "matte rubber glued onto lacquered wood." A runtime pass
(`js/scene/paddleMaterial.js`) already compensates for the material half; the
junction geometry can only be fixed in the asset.

Deliverable: replace `public/models/Paddle.glb`. No code changes needed if
every item below is met.

## 1. Structure (enforced by CI — `tests/paddleRigidity.test.js`)

- [ ] **ONE mesh object** for the entire bat. Material slots may split the
      geometry into primitives (rubber vs. blade — encouraged, see §3), but a
      second mesh *object* (e.g. a separate "Handle" node) fails CI: handle
      and face must share one world matrix by construction.
- [ ] **No animations, no skins/armatures** in the export.
- [ ] **Apply all transforms** before export — the mesh node must carry no
      scale (rotation/translation identity preferred). CI rejects scale.
- [ ] Every primitive has a material assigned (an empty slot renders as
      default white plastic in three.js).
- [ ] Keep the anchor empties as children of the mesh node: `EdgeBottom`,
      `EdgeLeft`, `EdgeRight`, `EdgeTop`, `HandleEnd`, `SweetSpot` (with child
      `BladeNormal`). Update their positions to match the new geometry.

## 2. Axes and proportions (the loader auto-derives collision from these)

`js/scene/models.js` computes the collision disc from the bounding box:
thinnest axis → face normal, longest axis → handle→head, middle axis → hit
radius. It does NOT read named nodes for this, so proportions are load-bearing:

- [ ] Same axis convention as the current asset: blade tip along **+Y**,
      handle toward **−Y**, face normal along **Z**, origin at the throat
      (where handle meets blade). The runtime applies a fixed Euler
      (`PADDLE_EULER_*` in models.js, validated in-headset) — changing the
      axis convention means re-validating that in MR.
- [ ] Thin axis (Z) stays the *thinnest*, blade axis (Y) the *longest*.
- [ ] Real-bat envelope, roughly matching current bbox: width ~0.149 m,
      total length ~0.250 m (blade ~0.157 + handle ~0.093), blade thickness
      12–20 mm total including rubber. Model at real-world scale, meters.

## 3. Junction geometry — the actual fix

This is why the re-export exists. The face/handle transition must read as
assembled layers, not a single molded piece:

- [ ] **Rubber lip**: each rubber sheet is its own thickness layer covering
      the blade only (not the handle). Where blade meets handle, the rubber
      terminates in a visible step (~1.5–2 mm) with its own edge loop and a
      slight bevel — the classic straight-cut rubber edge above the throat.
- [ ] **Edge sandwich**: the blade rim shows the strata — wood ply core +
      sponge + rubber on each side. A geometric step is best; a thin side
      band with a baked strata texture is acceptable. Optional: side tape.
- [ ] **Throat/wings**: the blade wood flares into the handle (real blades
      are one piece of wood that the handle scales clamp onto). Bevel the
      transition — no hard 90° butt joint.
- [ ] Budget: 3–8k triangles is fine (current is ~1k; the game renders one
      or two paddles, never a crowd of them).

## 4. Materials — two slots on the one mesh

- [ ] **M_Rubber** (both faces + rubber edge): flat red / black base color,
      **roughness 0.80–0.90**, metallic 0. Subtle pimple/grain normal map
      (rubber is the surface the player stares at — this is where a normal
      map pays off most).
- [ ] **M_Blade** (wood ply, edge, handle + wrap): wood-grain base color,
      **roughness 0.45–0.60**, metallic 0. A roughness map with slight
      variation along the grain is a plus.
- [ ] **Author a real roughnessMap if possible** — the runtime pass
      (`enhancePaddleMaterial`) detects it and leaves the material alone;
      without one it derives a roughness split from base color heuristics.
- [ ] **Do NOT use `KHR_materials_specular`** (the current asset ships a 2×
      boost, which caused the plastic look). The loader clamps it anyway;
      author plain metallic-roughness PBR.

## 5. Textures & export settings (Blender glTF exporter)

- [ ] Textures ≤ 2048², PNG or JPG, single UV set.
- [ ] Format: glTF Binary (.glb), **no Draco/meshopt compression** — the
      loader has no decoder configured and will fail to parse.
- [ ] Include: meshes + the anchor empties. Exclude: cameras, lights,
      animations.
- [ ] "Apply Modifiers" ON, "+Y Up" ON (exporter default).

## 6. Validation before handing back

1. `npx jest tests/paddleRigidity.test.js tests/paddleMaterial.test.js` —
   structure/rigidity gates.
2. Open `/paddle-preview.html` on the dev server (`npm run dev`) — inspect
   the junction and watch the highlight sweep: rubber matte, wood alive.
3. Load the game with `?selftest` / SELF_TEST on and check the console:
   `Thin/normal axis: z | Long/handle axis: y`, hit radius ~0.075–0.09, and
   `[COLLISION TEST] 6/6 PASSED`.
4. Final check in headset: wrist-roll — face rotates about the handle axis
   with no orbit; junction reads as assembled layers at close range.
