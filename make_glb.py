import bpy, sys

argv = sys.argv[sys.argv.index("--")+1:]
IMG, GLB, W, H = argv

W = float(W)/100
H = float(H)/100

bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2, H/2, 1)

mat = bpy.data.materials.new("Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(IMG)

em = nodes.new("ShaderNodeEmission")
out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs[0], em.inputs[0])
links.new(em.outputs[0], out.inputs[0])

p.data.materials.append(mat)

bpy.ops.export_scene.gltf(
  filepath=GLB,
  export_format='GLB',
  export_yup=True,
  export_apply=True
)
