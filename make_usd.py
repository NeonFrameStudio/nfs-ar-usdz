import bpy, sys, os

argv = sys.argv[sys.argv.index("--")+1:]
IMG, USD_OUT, WCM, HCM = argv

W = float(WCM) / 100.0
H = float(HCM) / 100.0

out_dir = os.path.dirname(USD_OUT)
tex_name = "texture.png"
tex_path = os.path.join(out_dir, tex_name)

# Fresh scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# Create plane
bpy.ops.mesh.primitive_plane_add(size=1)
p = bpy.context.active_object
p.scale = (W/2.0, H/2.0, 1)

# Material (emission so it's bright in AR)
mat = bpy.data.materials.new("Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex = nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(IMG)

# Save a local copy of the texture to the same folder as the USD
# so we can package it into the .usdz
tex.image.filepath_raw = tex_path
tex.image.save()

em = nodes.new("ShaderNodeEmission")
out = nodes.new("ShaderNodeOutputMaterial")

links.new(tex.outputs[0], em.inputs[0])
links.new(em.outputs[0], out.inputs[0])

p.data.materials.append(mat)

# Export USD (NOT "export_usdz" — that flag is what broke you)
# We export a .usd and texture alongside it.
bpy.ops.wm.usd_export(
    filepath=USD_OUT,
    export_textures=True,
    relative_paths=True
)
