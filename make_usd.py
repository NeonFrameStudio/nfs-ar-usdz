import bpy, sys, os
import addon_utils

def log(*a):
    print("[make_usd]", *a)

# ------------------------------------------------------------
# Args
# ------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# cm -> meters
W = float(W) / 100.0
H = float(H) / 100.0

DEPTH = 0.015  # 1.5cm thickness (AR-safe)

log("IMG:", IMG)
log("USD:", USD)
log("W,H(m):", W, H, "DEPTH(m):", DEPTH)

# ------------------------------------------------------------
# Reset to empty scene
# ------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ------------------------------------------------------------
# Try enable USD addon if present
# NOTE: On some Blender builds the exporter is built-in and
# the addon module may not exist. That's OK.
# ------------------------------------------------------------
def enable_usd_addon():
    for mod in ("io_scene_usd", "usd", "io_usd"):
        try:
            state = addon_utils.check(mod)
            # state[0] = enabled/disabled or None if not found
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                log("Enabled addon:", mod)
                return mod
        except Exception as e:
            log("Addon check error:", mod, e)
    log("No USD addon explicitly enabled (may be built-in).")
    return None

enable_usd_addon()

# ------------------------------------------------------------
# Create AR-safe geometry: THIN BOX (not a plane)
# ------------------------------------------------------------
bpy.ops.mesh.primitive_cube_add(size=1)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# Cube default is centered at origin. Scale in meters:
# For a cube of size 1, scaling by (W/2, H/2, DEPTH/2) yields W x H x DEPTH
obj.scale = (W / 2.0, H / 2.0, DEPTH / 2.0)

# Apply transforms (ARKit is picky about unapplied scales)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# ------------------------------------------------------------
# Ensure UVs exist (critical for textures in AR)
# ------------------------------------------------------------
bpy.context.view_layer.objects.active = obj
try:
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    log("UV unwrap: OK")
except Exception as e:
    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass
    log("UV unwrap failed (continuing):", e)

# ------------------------------------------------------------
# Material with RELATIVE texture reference: "texture.png"
# ------------------------------------------------------------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-500, 0)

img = bpy.data.images.load(IMG)

# Force the referenced path INSIDE USD to be exactly "texture.png"
# (You package texture.png at the root of the USDZ)
img.filepath = "texture.png"
img.filepath_raw = "texture.png"

# sRGB generally behaves best for Quick Look
try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

tex.image = img

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-150, 0)

# Make it pop a bit in AR
try:
    if "Emission" in bsdf.inputs:
        links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 1.0
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.35
except Exception as e:
    log("BSDF tuning warn:", e)

# Base color
links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (250, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

obj.data.materials.clear()
obj.data.materials.append(mat)

# ------------------------------------------------------------
# Export USD
# IMPORTANT:
# - Do NOT pass export_format="USDC" (your exporter rejected it)
# - Keep relative_paths=True if supported
# - export_textures=False if supported (you package texture.png yourself)
# ------------------------------------------------------------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("bpy.ops.wm.usd_export not available in this Blender build")

props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    pass

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

if "export_textures" in props:
    kwargs["export_textures"] = False

if "relative_paths" in props:
    kwargs["relative_paths"] = True

# NOTE: Intentionally NOT setting export_format.
# Some Blender builds use different property names or don't expose it.
log("usd_export kwargs:", kwargs)
log("usd_export supports:", sorted(list(props))[:50], "..." if len(props) > 50 else "")

bpy.ops.wm.usd_export(**kwargs)

# ------------------------------------------------------------
# Validate output
# ------------------------------------------------------------
if not os.path.exists(USD):
    base = os.path.dirname(USD)
    listing = os.listdir(base) if os.path.isdir(base) else "missing dir"
    log("USD NOT CREATED. Dir listing:", base, listing)
    raise RuntimeError("usd_not_created")

size = os.path.getsize(USD)
log("USD created OK:", USD, "bytes:", size)

# Optional: print first 8 bytes (helps identify USDC vs USDA)
try:
    with open(USD, "rb") as f:
        h = f.read(8)
    # ascii view can be weird; print both
    log("USD header (8 bytes) ascii:", "".join([chr(b) if 32 <= b <= 126 else "." for b in h]))
    log("USD header (8 bytes) hex:", h.hex())
except Exception as e:
    log("USD header read failed:", e)
