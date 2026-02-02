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
            state = addon_utils.check(mod)
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
p.name = "NFS_Plane"

# ---------- Material (AR-friendly) ----------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links

for n in list(nodes):
    nodes.remove(n)

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-400, 0)

# Load the PNG you already created: jobDir/texture.png
img = bpy.data.images.load(IMG)

# ✅ CRITICAL:
# Force the image path to be just "texture.png" (relative),
# so the USD references it correctly INSIDE the USDZ.
base_name = os.path.basename(IMG)
img.filepath = base_name
img.filepath_raw = base_name

tex.image = img

# Prefer sRGB
try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-100, 0)

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (200, 0)

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

# Small emission so it pops
if "Emission" in bsdf.inputs:
    links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 0.8

if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

p.data.materials.clear()
p.data.materials.append(mat)

# ---------- Export USD ----------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError(f"bpy.ops.wm.usd_export not found. USD addon enabled: {enabled}")

# Only pass args supported by this Blender build
props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    props = set()

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

# ✅ IMPORTANT:
# Do NOT export textures; we already have texture.png and we forced the USD to point to it.
if "export_textures" in props:
    kwargs["export_textures"] = False

# ✅ Relative paths so it references "texture.png"
if "relative_paths" in props:
    kwargs["relative_paths"] = True

# Prefer ASCII (easier/safer)
if "export_format" in props:
    # Blender often expects: 'USD', 'USDA', 'USDC' depending on build
    # We'll try the common "USDA" first, fallback if it errors.
    try:
        kwargs["export_format"] = "USDA"
    except Exception:
        pass

bpy.ops.wm.usd_export(**kwargs)
