import bpy, sys
import addon_utils

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USD, W, H = argv

W = float(W) / 100.0
H = float(H) / 100.0

# Reset scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- IMPORTANT: enable USD addon (needed for wm.usd_export in many builds) ----
def enable_usd_addon():
  candidates = ["io_scene_usd", "usd", "io_usd"]
  last_err = None
  for mod in candidates:
    try:
      # If present, enable it
      if addon_utils.check(mod)[0] is not None:
        bpy.ops.preferences.addon_enable(module=mod)
        return mod
    except Exception as e:
      last_err = e
  raise RuntimeError(f"USD addon not available/enabled. Tried {candidates}. Last error: {last_err}")

enabled = enable_usd_addon()

# Plane
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2.0, H/2.0, 1)

# Material (emission so it always looks bright in AR)
mat = bpy.data.materials.new("Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
img = bpy.data.images.load(IMG)
tex.image = img

em = nodes.new("ShaderNodeEmission")
out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs["Color"], em.inputs["Color"])
links.new(em.outputs["Emission"], out.inputs["Surface"])

p.data.materials.append(mat)

# Export USD
# (Keep USD + PNG, server zips into USDZ)
if not hasattr(bpy.ops.wm, "usd_export"):
  raise RuntimeError(f"bpy.ops.wm.usd_export not found even after enabling addon: {enabled}")

bpy.ops.wm.usd_export(
  filepath=USD,
  export_materials=True,
  export_textures=True
)
