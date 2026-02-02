import bpy, sys, os
import addon_utils

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# Convert cm → meters
W = float(W) / 100.0
H = float(H) / 100.0
DEPTH = 0.015  # 1.5cm physical thickness (AR-safe)

# ---------- Reset scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- Enable USD exporter ----------
def enable_usd_addon():
    for mod in ["io_scene_usd", "usd", "io_usd"]:
        try:
            state = addon_utils.check(mod)
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                return mod
        except:
            pass
    return None

enable_usd_addon()

# ---------- Create thin box instead of plane ----------
bpy.ops.mesh.primitive_cube_add(size=1)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# Scale to real size
obj.scale = (W / 2.0, H / 2.0, DEPTH / 2.0)

# ---------- Material ----------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.location = (-400, 0)

img = bpy.data.images.load(IMG)
img.filepath = os.path.basename(IMG)
img.filepath_raw = img.filepath
img.colorspace_settings.name = "sRGB"
tex.image = img

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-100, 0)

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (200, 0)

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
bsdf.inputs["Emission Strength"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.35

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

obj.data.materials.clear()
obj.data.materials.append(mat)

# ---------- Export USD ----------
props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except:
    pass

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

if "export_textures" in props:
    kwargs["export_textures"] = False

if "relative_paths" in props:
    kwargs["relative_paths"] = True

if "export_format" in props:
    kwargs["export_format"] = "USDA"

bpy.ops.wm.usd_export(**kwargs)
