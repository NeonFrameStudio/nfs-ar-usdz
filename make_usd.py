import bpy, sys
import addon_utils

print("BLENDER VERSION:", bpy.app.version_string)
print("HAS USD EXPORT (pre):", hasattr(bpy.ops.wm, "usd_export"))

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USD, W, H = argv

W = float(W) / 100.0
H = float(H) / 100.0

# Reset scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- IMPORTANT: enable USD addon (needed for wm.usd_export in many builds) ----
def enable_usd_addon():
  candidates = ["io_scene_usd", "usd", "io_usd"]
  found = []
  for mod in candidates:
    try:
      state = addon_utils.check(mod)
      if state[0] is not None:
        found.append(mod)
    except:
      pass

  if not found:
    raise RuntimeError(
      f"USD addon not present in this Blender build. Tried {candidates}. "
      f"Install official Blender (not apt)."
    )

  bpy.ops.preferences.addon_enable(module=found[0])
  return found[0]

enabled = enable_usd_addon()

print("USD ADDON ENABLED:", enabled)
print("HAS USD EXPORT (post):", hasattr(bpy.ops.wm, "usd_export"))

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
if not hasattr(bpy.ops.wm, "usd_export"):
  raise RuntimeError(f"bpy.ops.wm.usd_export not found even after enabling addon: {enabled}")

bpy.ops.wm.usd_export(
  filepath=USD,
  export_materials=True,
  export_textures=True
)
