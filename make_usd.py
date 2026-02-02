import bpy, sys, os
import addon_utils

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

W = float(W) / 100.0
H = float(H) / 100.0

# ---------- Reset scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- Enable USD exporter addon if present ----------
def enable_usd_addon():
    candidates = ["io_scene_usd", "usd", "io_usd"]
    for mod in candidates:
        try:
            state = addon_utils.check(mod)  # (enabled, loaded) style
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                return mod
        except Exception:
            pass
    return None

enabled = enable_usd_addon()

# ---------- Plane ----------
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W / 2.0, H / 2.0, 1.0)

# Ensure it’s named predictably
p.name = "NFS_Plane"

# ---------- Material (Principled, AR-friendly) ----------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links

# Clear default nodes
for n in list(nodes):
    nodes.remove(n)

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-400, 0)

# Load the PNG you wrote (jobDir/texture.png)
img = bpy.data.images.load(IMG)
tex.image = img

# Force sRGB for standard images
try:
    tex.image.colorspace_settings.name = "sRGB"
except Exception:
    pass

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-100, 0)

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (200, 0)

# Base color
links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

# Slight emission so it pops in AR (optional but nice)
if "Emission" in bsdf.inputs:
    links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 0.8

# Reduce roughness a bit (looks better)
if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

# Assign material to plane
p.data.materials.clear()
p.data.materials.append(mat)

# ---------- USD Export ----------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError(f"bpy.ops.wm.usd_export not found. USD addon enabled: {enabled}")

# Introspect operator properties so we only pass supported args
props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    props = set()

kwargs = {
    "filepath": USD,
    "export_materials": True,
    "export_textures": True,
}

# CRITICAL: make paths inside USD relative so USDZ can resolve textures
if "relative_paths" in props:
    kwargs["relative_paths"] = True

# Helpful: keep texture files near the USD if Blender supports it
# (different Blender builds name this differently)
for key in ["texture_dir", "export_texture_dir", "textures_dir"]:
    if key in props:
        kwargs[key] = "."  # write texture outputs into the same folder as the USD
        break

# Some builds offer "overwrite_textures"
if "overwrite_textures" in props:
    kwargs["overwrite_textures"] = True

# Export
bpy.ops.wm.usd_export(**kwargs)
