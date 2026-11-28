---
name: model-delivery-checks
description: Checks to run before a 3D model, prop or scene is handed over as a game asset - a mesh audit by script, re-import of the exported GLB, cleanup of generated (image-to-3D) meshes, UV and bake criteria. Use before reporting a 3D export as done.
---

# Delivery checks for 3D game assets

A render that looks right is not a delivered asset: the file can still carry flipped faces, a wrong
size, a missing texture or a format the game cannot load. Run these checks before you report a
model, prop or scene export as done. Project rules and a repository's own 3D skills outrank the
numbers here.

1. **Know the target first.** Take the triangle budget, texture size, file format and the runtime
   that loads the file from the project rules or the brief. When one is missing, ask the lead or
   state the value you assumed in your report. Never borrow a budget from another project.
2. **Audit the scene by script, not by eye.** `scripts/audit_asset.py` in this skill's folder
   checks every mesh after modifiers: no faces, edges shared by three or more faces, loose
   geometry, duplicate faces, faces pointing inwards, mirrored or unapplied scale, an image texture
   without a UV map, a missing image file, and the triangle total against the budget.
   - Shell: `blender -b <scene.blend> --python <skill folder>/scripts/audit_asset.py -- --budget <n> --glb <file.glb>`
   - Inside a running Blender: `import runpy; report = runpy.run_path("<skill folder>/scripts/audit_asset.py")["audit"](glb="<file.glb>", budget=<n>)`
   Fix every FAIL and run it again. Explain each WARN in your report. INFO lines tell you where to look.
3. **Verify the exported file, not that it exists.** With `--glb` the script reads the file's
   counts and extensions, imports it again and compares its size (within 1 mm) and triangles with
   the scene. An extension the file requires (Meshopt, Draco, KTX2) needs a decoder in the runtime
   that loads it; name the required extensions in your report so the game side can check its loader.
4. **A generated mesh (image-to-3D) is raw material.** Record what arrived: triangles, holes,
   scale, orientation and where its pivot is. Give it its real size and a pivot on the floor,
   reduce it to the budget, split the parts that must move on their own, then compare its
   silhouette with the source picture from the game camera after the reduction, not before.
5. **UV and baked textures.** No overlapping UV islands unless mirrored on purpose. Padding between
   islands of at least the texture size divided by 128 (16 px at 2K). Colour maps in sRGB, data
   maps (normal, roughness, metallic) as non-colour. After a bake, render the low-poly model with
   its baked maps beside the source and compare them.
6. **PBR materials only.** Metallic is 0 or 1 except where two materials meet; base colour is
   neither pure black nor pure white. Skip this for hand-painted or unlit looks.
7. **What the script cannot see.** Look at a close render from the game camera for coplanar
   faces that flicker, parts floating off the body, and outline or shell artefacts.

In your report give the AUDIT line, the budget against what you measured, the extensions the file
requires, the reason for each WARN, and the checks you did not run.
