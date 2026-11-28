"""Delivery checks for a 3D game asset, run inside Blender.

Command line:
    blender -b scene.blend --python audit_asset.py -- [--glb out.glb] [--budget 20000]
                                                      [--collection Name] [--json report.json]
From a running Blender (for example through MCP):
    import runpy
    report = runpy.run_path("<this file>")["audit"](glb="out.glb", budget=20000)

It measures what a render cannot show: mesh defects per object, the triangle budget, and whether
the exported GLB holds what the scene holds. FAIL lines must be fixed before delivery; WARN lines
must be explained in the report. The command line exits with 1 when anything failed.
"""
import json
import os
import struct
import sys

import bmesh
import bpy
from mathutils import Vector

SIZE_TOLERANCE = 0.001  # metres between the scene and the re-imported file


def _targets(collection=None):
    if collection:
        found = bpy.data.collections.get(collection)
        if not found:
            raise ValueError(f"no collection named {collection}")
        objects = found.all_objects
    else:
        objects = bpy.context.view_layer.objects
    return [o for o in objects if o.type == "MESH" and not o.hide_render]


def _bounds(objects, depsgraph):
    low, high = Vector((1e18,) * 3), Vector((-1e18,) * 3)
    for obj in objects:
        shown = obj.evaluated_get(depsgraph)
        for corner in shown.bound_box:
            world = shown.matrix_world @ Vector(corner)
            low = Vector(map(min, low, world))
            high = Vector(map(max, high, world))
    return (high - low) if objects else Vector((0, 0, 0))


def _islands(bm):
    seen, count = set(), 0
    for start in bm.verts:
        if start.index in seen:
            continue
        count += 1
        stack = [start]
        seen.add(start.index)
        while stack:
            for edge in stack.pop().link_edges:
                for other in edge.verts:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
    return count


def _mesh_checks(obj, depsgraph, issues):
    shown = obj.evaluated_get(depsgraph)
    mesh = shown.to_mesh()
    try:
        mesh.calc_loop_triangles()
        triangles = len(mesh.loop_triangles)
        if not mesh.polygons:
            issues.append(("FAIL", obj.name, "no faces after modifiers"))
            return 0
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        many = sum(1 for e in bm.edges if len(e.link_faces) > 2)
        open_edges = sum(1 for e in bm.edges if len(e.link_faces) == 1)
        loose = sum(1 for v in bm.verts if not v.link_faces) + sum(1 for e in bm.edges if not e.link_faces)
        keys = {}
        for face in bm.faces:
            key = tuple(sorted(v.index for v in face.verts))
            keys[key] = keys.get(key, 0) + 1
        doubled = sum(n - 1 for n in keys.values() if n > 1)
        flat = sum(1 for f in bm.faces if f.calc_area() < 1e-12)
        islands = _islands(bm)
        flipped = 0
        if not open_edges and not many and not doubled:
            before = [f.normal.copy() for f in bm.faces]
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
            flipped = sum(1 for f, n in zip(bm.faces, before) if f.normal.dot(n) < 0)
        bm.free()
        if many:
            issues.append(("FAIL", obj.name, f"{many} edges shared by three or more faces"))
        if loose:
            issues.append(("FAIL", obj.name, f"{loose} loose vertices or edges"))
        if doubled:
            issues.append(("FAIL", obj.name, f"{doubled} duplicate faces"))
        if flipped:
            issues.append(("FAIL", obj.name, f"{flipped} faces point inwards"))
        if flat:
            issues.append(("WARN", obj.name, f"{flat} zero-area faces"))
        if open_edges:
            issues.append(("INFO", obj.name, f"open mesh: {open_edges} border edges"))
        if islands > 1:
            issues.append(("INFO", obj.name, f"{islands} separate pieces; check that none floats"))
        scale = obj.matrix_world.to_scale()
        if obj.matrix_world.determinant() < 0:
            issues.append(("FAIL", obj.name, "negative scale (mirrored transform)"))
        elif any(abs(s - 1) > 1e-4 for s in scale):
            issues.append(("WARN", obj.name, f"scale not applied ({scale.x:.3f}, {scale.y:.3f}, {scale.z:.3f})"))
        textured = False
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            for node in material.node_tree.nodes:
                if node.type != "TEX_IMAGE":
                    continue
                textured = True
                image = node.image
                if not image:
                    issues.append(("FAIL", obj.name, f"material {material.name}: image node without an image"))
                elif image.source in {"FILE", "SEQUENCE", "MOVIE"} and not image.packed_file and not os.path.exists(bpy.path.abspath(image.filepath)):
                    issues.append(("FAIL", obj.name, f"material {material.name}: image {image.name} is missing"))
        if textured and not mesh.uv_layers:
            issues.append(("FAIL", obj.name, "image texture but no UV map"))
        return triangles
    finally:
        shown.to_mesh_clear()


def glb_summary(path):
    """Counts and extensions of a .glb, read from its JSON chunk without Blender's importer."""
    with open(path, "rb") as file:
        magic, _version, _length = struct.unpack("<4sII", file.read(12))
        if magic != b"glTF":
            raise ValueError(f"{path} is not a binary glTF file")
        size, kind = struct.unpack("<I4s", file.read(8))
        if kind != b"JSON":
            raise ValueError("first chunk is not JSON")
        data = json.loads(file.read(size))
    return {
        "bytes": os.path.getsize(path),
        "meshes": len(data.get("meshes", [])),
        "materials": len(data.get("materials", [])),
        "images": len(data.get("images", [])),
        "animations": len(data.get("animations", [])),
        "skins": len(data.get("skins", [])),
        "extensionsRequired": data.get("extensionsRequired", []),
        "extensionsUsed": data.get("extensionsUsed", []),
    }


def _reimport(path, size, triangles, issues):
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as error:  # a compressed file Blender cannot read still has to be reported
        issues.append(("WARN", os.path.basename(path), f"could not re-import ({error}); check it in the runtime instead"))
        return None
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == "MESH"]
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    got = _bounds(meshes, depsgraph)
    count = 0
    for obj in meshes:
        mesh = obj.evaluated_get(depsgraph).to_mesh()
        mesh.calc_loop_triangles()
        count += len(mesh.loop_triangles)
        obj.evaluated_get(depsgraph).to_mesh_clear()
    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)
    off = max(abs(a - b) for a, b in zip(got, size))
    if not meshes:
        issues.append(("FAIL", os.path.basename(path), "the file holds no mesh"))
    elif off > SIZE_TOLERANCE:
        issues.append(("FAIL", os.path.basename(path), f"size differs from the scene by {off:.4f} m (file {got.x:.3f} x {got.y:.3f} x {got.z:.3f})"))
    if meshes and count != triangles:
        issues.append(("WARN", os.path.basename(path), f"{count} triangles in the file, {triangles} in the scene"))
    return {"size": [round(v, 4) for v in got], "triangles": count}


def audit(glb=None, budget=None, collection=None):
    """Run the checks and return a report dict; prints one line per finding."""
    issues = []
    objects = _targets(collection)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    if not objects:
        issues.append(("FAIL", "scene", "no mesh objects to deliver"))
    per_object = {obj.name: _mesh_checks(obj, depsgraph, issues) for obj in objects}
    triangles = sum(per_object.values())
    size = _bounds(objects, depsgraph)
    if budget is not None and triangles > budget:
        issues.append(("FAIL", "scene", f"{triangles} triangles, budget {budget}"))
    report = {"objects": per_object, "triangles": triangles, "size": [round(v, 4) for v in size], "budget": budget}
    if glb:
        if not os.path.exists(glb):
            issues.append(("FAIL", os.path.basename(glb), "file not found"))
        else:
            report["glb"] = glb_summary(glb)
            needs = report["glb"]["extensionsRequired"]
            if needs:
                issues.append(("WARN", os.path.basename(glb), f"requires {', '.join(needs)}: the runtime loader must support each"))
            report["reimport"] = _reimport(glb, size, triangles, issues)
    order = {"FAIL": 0, "WARN": 1, "INFO": 2}
    issues.sort(key=lambda item: order[item[0]])
    for level, where, text in issues:
        print(f"{level} {where}: {text}")
    report["issues"] = [{"level": level, "where": where, "text": text} for level, where, text in issues]
    report["failed"] = sum(1 for item in issues if item[0] == "FAIL")
    report["warned"] = sum(1 for item in issues if item[0] == "WARN")
    print(f"AUDIT {'FAILED' if report['failed'] else 'PASSED'}: {len(objects)} objects, {triangles} triangles"
          f"{f' (budget {budget})' if budget is not None else ''}, size {size.x:.3f} x {size.y:.3f} x {size.z:.3f} m, "
          f"{report['failed']} fail, {report['warned']} warn")
    return report


def _main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--glb")
    parser.add_argument("--budget", type=int)
    parser.add_argument("--collection")
    parser.add_argument("--json")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    report = audit(glb=args.glb, budget=args.budget, collection=args.collection)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as file:
            json.dump(report, file, indent=2)
    sys.exit(1 if report["failed"] else 0)


if __name__ == "__main__":
    _main()
