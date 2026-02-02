import bpy, sys
import addon_utils

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# cm -> meters
W = float(W) / 100.0
H = float(H) / 100.0

# physical thickness (meters)
DEPTH = 0.015  # 1.5cm

# ---------- Reset scene ----------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- Enable USD exporter ----------
def enable_usd_addon():
    for mod in ("io_scene_usd", "usd", "io_usd"):
        try:
            state = addon_utils.check(mod)
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                return mod
        except Exception:
            pass
    return None

enable_usd_addon()

# ---------- Create thin box ----------
bpy.ops.mesh.primitive_cube_add(size=1)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# scale to real size (Blender cube is 2 units across if you scale directly;
# using /2 makes final dimensions match W/H/DEPTH)
obj.scale = (W / 2.0, H / 2.0, DEPTH / 2.0)

# ---------- Create material (front only) ----------
mat = bpy.data.materials.new("NFS_Mat_Front")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")

# Load the PNG that your server already normalized into jobDir/texture.png
img = bpy.data.images.load(IMG)

# 🔥 CRITICAL: force the USD to reference EXACTLY "texture.png" inside the USDZ root
img.filepath = "texture.png"
img.filepath_raw = "texture.png"
try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

tex.image = img

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

# a little emission helps in AR lighting
if "Emission" in bsdf.inputs:
    links.new(tex.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 0.8

if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

# ---------- Assign material ONLY to the front face ----------
# We’ll create 2 materials:
#  - slot 0: dark neutral for sides/back
#  - slot 1: textured front
side_mat = bpy.data.materials.new("NFS_Mat_Sides")
side_mat.use_nodes = True
s_nodes = side_mat.node_tree.nodes
s_links = side_mat.node_tree.links
# keep default Principled; just set dark-ish base
try:
    s_bsdf = s_nodes.get("Principled BSDF")
    if s_bsdf and "Base Color" in s_bsdf.inputs:
        s_bsdf.inputs["Base Color"].default_value = (0.05, 0.05, 0.06, 1.0)
    if s_bsdf and "Roughness" in s_bsdf.inputs:
        s_bsdf.inputs["Roughness"].default_value = 0.6
except Exception:
    pass

obj.data.materials.clear()
obj.data.materials.append(side_mat)  # slot 0
obj.data.materials.append(mat)       # slot 1

# Put cube in edit mode and set material index by face normal:
# front face in Blender is usually +Y for the default cube.
bpy.context.view_layer.objects.active = obj
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="DESELECT")
bpy.ops.object.mode_set(mode="OBJECT")

import math

# pick the face with the largest +Y normal as "front"
best_i = None
best_dot = -999.0
for i, poly in enumerate(obj.data.polygons):
    n = poly.normal
    dot = n.y  # +Y
    if dot > best_dot:
        best_dot = dot
        best_i = i

# assign: everything -> sides (0), front -> textured (1)
for poly in obj.data.polygons:
    poly.material_index = 0
if best_i is not None:
    obj.data.polygons[best_i].material_index = 1

bpy.ops.object.mode_set(mode="OBJECT")

# ---------- Export USD (BINARY USDC REQUIRED FOR iOS AR) ----------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("USD exporter not available")

bpy.ops.wm.usd_export(
    filepath=USD,
    export_materials=True,
    export_textures=False,   # texture.png already exists in jobDir
    relative_paths=True,
    export_format="USDC"     # 🔥 REQUIRED FOR QUICK LOOK AR
)
