import bpy, sys, os
import addon_utils

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

W = float(W) / 100.0
H = float(H) / 100.0

# ---------- Reset scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- Enable USD exporter addon ----------
def enable_usd_addon():
    candidates = ["io_scene_usd", "usd", "io_usd"]
    for mod in candidates:
        try:
            # check() returns (enabled, loaded) in most builds
            state = addon_utils.check(mod)
            if state and state[0] is not None:
                try:
                    addon_utils.enable(mod, default_set=True)
                except Exception:
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

# ✅ CRITICAL: give it THICKNESS (Quick Look hates “infinitely thin” meshes)
bpy.context.view_layer.objects.active = p
bpy.ops.object.modifier_add(type="SOLIDIFY")
p.modifiers["Solidify"].thickness = 0.002  # 2mm
p.modifiers["Solidify"].offset = 0.0
bpy.ops.object.modifier_apply(modifier="Solidify")

# ---------- Material (AR-friendly) ----------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links

for n in list(nodes):
    nodes.remove(n)

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-400, 0)

# Load texture.png from jobDir
img = bpy.data.images.load(IMG)

# ✅ Force reference inside USD to be just "texture.png"
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

# Optional small emission so it pops a bit
if "Emission" in bsdf.inputs:
    links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 0.35

if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

p.data.materials.clear()
p.data.materials.append(mat)

# ---------- Export USD ----------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError(f"bpy.ops.wm.usd_export not found. USD addon enabled: {enabled}")

# Detect supported args (Blender build differences)
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    props = set()

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

# ✅ IMPORTANT: do NOT export textures — we ship texture.png ourselves
if "export_textures" in props:
    kwargs["export_textures"] = False

# ✅ IMPORTANT: keep relative paths so USD references "texture.png"
if "relative_paths" in props:
    kwargs["relative_paths"] = True

# Good to include UVs if supported
if "export_uvmaps" in props:
    kwargs["export_uvmaps"] = True

bpy.ops.wm.usd_export(**kwargs)
