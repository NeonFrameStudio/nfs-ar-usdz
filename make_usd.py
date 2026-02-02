import bpy, sys, os
import addon_utils

def log(*a):
    print("[make_usd]", *a)

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# cm -> meters
W = float(W) / 100.0
H = float(H) / 100.0

log("IMG:", IMG)
log("USD:", USD)
log("W,H(m):", W, H)

# Reset
bpy.ops.wm.read_factory_settings(use_empty=True)

# Enable USD addon if present
def enable_usd_addon():
    for mod in ("io_scene_usd", "usd", "io_usd"):
        try:
            state = addon_utils.check(mod)
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                log("Enabled addon:", mod)
                return mod
        except Exception as e:
            log("Addon check error:", mod, e)
    log("No USD addon explicitly enabled (may be built-in).")
    return None

enable_usd_addon()

# Create plane
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.name = "NFS_Plane"
p.scale = (W / 2.0, H / 2.0, 1.0)

# Material
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-500, 0)

img = bpy.data.images.load(IMG)

# CRITICAL: force the image path referenced INSIDE the USD to be exactly "texture.png"
img.filepath = "texture.png"
img.filepath_raw = "texture.png"

try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

tex.image = img

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-150, 0)

# Make it pop in AR
if "Emission" in bsdf.inputs:
    links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 1.0
if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (250, 0)

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

p.data.materials.clear()
p.data.materials.append(mat)

# Export USD
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("bpy.ops.wm.usd_export not available in this Blender build")

# Only pass supported args
props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    pass

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

# We already package texture.png ourselves
if "export_textures" in props:
    kwargs["export_textures"] = False

# Ensure relative texture reference is kept
if "relative_paths" in props:
    kwargs["relative_paths"] = True

# FORCE BINARY (this is the big Quick Look reliability win)
if "export_format" in props:
    kwargs["export_format"] = "USDC"

log("usd_export kwargs:", kwargs)

bpy.ops.wm.usd_export(**kwargs)

# Validate output
if not os.path.exists(USD):
    # print folder listing to debug
    base = os.path.dirname(USD)
    log("USD NOT CREATED. Dir listing:", base, os.listdir(base) if os.path.isdir(base) else "missing dir")
    raise RuntimeError("usd_not_created")

log("USD created OK:", USD, "bytes:", os.path.getsize(USD))
