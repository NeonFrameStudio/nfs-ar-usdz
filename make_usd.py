import bpy, sys, os

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USD, W, H = argv

W = float(W) / 100.0
H = float(H) / 100.0

bpy.ops.wm.read_factory_settings(use_empty=True)

# Plane
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2.0, H/2.0, 1)

# Material
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

# Export USD (not USDZ)
# Keep it simple: USD + PNG, then server zips into USDZ
bpy.ops.wm.usd_export(
    filepath=USD,
    export_materials=True,
    export_textures=True
)
