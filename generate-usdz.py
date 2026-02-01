import bpy, sys

argv = sys.argv[sys.argv.index("--") + 1:]
IMAGE_PATH = argv[0]
USDZ_PATH  = argv[1]
WIDTH_CM   = float(argv[2])
HEIGHT_CM  = float(argv[3])

WIDTH_M  = WIDTH_CM / 100.0
HEIGHT_M = HEIGHT_CM / 100.0

bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.mesh.primitive_plane_add(size=1)
plane = bpy.context.active_object
plane.scale = (WIDTH_M / 2, HEIGHT_M / 2, 1)

mat = bpy.data.materials.new("Frame")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(IMAGE_PATH)

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.inputs["Emission Strength"].default_value = 1.3

out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

plane.data.materials.append(mat)

bpy.ops.wm.usd_export(
  filepath=USDZ_PATH,
  selected_objects_only=True,
  export_textures=True
)
