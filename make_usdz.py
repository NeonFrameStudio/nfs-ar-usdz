import bpy, sys

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USDZ, W, H = argv

W = float(W)/100
H = float(H)/100

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2, H/2, 1)

mat = bpy.data.materials.new("Mat")
mat.use_nodes = True
n = mat.node_tree.nodes
n.clear()

tex = n.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(IMG)

em = n.new("ShaderNodeEmission")
out = n.new("ShaderNodeOutputMaterial")

mat.node_tree.links.new(tex.outputs[0], em.inputs[0])
mat.node_tree.links.new(em.outputs[0], out.inputs[0])

p.data.materials.append(mat)

bpy.ops.wm.usd_export(
  filepath=USDZ,
  export_textures=True,
  export_materials=True
)
