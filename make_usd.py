import bpy, sys, os

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USD_OUT, W_CM, H_CM = argv

W = float(W_CM) / 100.0
H = float(H_CM) / 100.0

# clean scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# plane
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2.0, H/2.0, 1)

# material with image texture
mat = bpy.data.materials.new("Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(IMG)

# Principled so USD exporter behaves
bsdf = nodes.new("ShaderNodeBsdfPrincipled")
out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

p.data.materials.append(mat)

# Ensure texture file is treated as an asset path
# (USD exporter picks it up as an external file)
tex.image.filepath = IMG

# Export to USD (usdc)
# NOTE: Blender’s args differ across versions; these are safe.
bpy.ops.wm.usd_export(
    filepath=USD_OUT,
    export_textures=True,
    relative_paths=True
)
