import bpy, sys, os, shutil, subprocess
import addon_utils

def log(*a):
    print("[make_usd]", *a)

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# cm -> meters
W = float(W) / 100.0
H = float(H) / 100.0

DEPTH = 0.015  # 1.5cm thickness

log("IMG:", IMG)
log("USD:", USD)
log("W,H(m):", W, H)
log("DEPTH(m):", DEPTH)

job_dir = os.path.dirname(os.path.abspath(USD))
tex_path = os.path.join(job_dir, "texture.png")

# Reset Blender
bpy.ops.wm.read_factory_settings(use_empty=True)

# Enable USD addon if present
def enable_usd_addon():
    for mod in ("io_scene_usd", "usd", "io_usd"):
        try:
            state = addon_utils.check(mod)
            if state[0] is not None:
                bpy.ops.preferences.addon_enable(module=mod)
                log("Enabled addon:", mod)
                return True
        except Exception:
            pass
    return False

enable_usd_addon()

# Ensure texture.png exists in job dir (server already writes it; we keep a safe copy)
try:
    if os.path.abspath(IMG) != os.path.abspath(tex_path):
        shutil.copyfile(IMG, tex_path)
        log("Copied IMG to texture.png:", tex_path)
    else:
        log("IMG already is texture.png:", tex_path)
except Exception as e:
    log("FAILED copying IMG -> texture.png:", e)
    raise

# ------------------------------------------------------------
# Geometry: Plane + Solidify  (fixes tiny/grey cube + UV issues)
# ------------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=2)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# Plane is 2m x 2m when size=2 (edge length), so scale to W x H
# Using /2 keeps behavior consistent across Blender versions
obj.scale = (W / 2.0, H / 2.0, 1.0)

# Solidify to give thickness
solid = obj.modifiers.new(name="NFS_Solidify", type="SOLIDIFY")
solid.thickness = DEPTH
solid.offset = 0.0  # center thickness around plane
solid.use_rim = True

# Apply transforms + modifier so exported mesh is baked
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bpy.ops.object.modifier_apply(modifier=solid.name)

# Ensure normals are correct
try:
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
except Exception as e:
    log("Normals fix skipped:", e)

# Ensure there is a UV map (plane usually has it, but be explicit)
try:
    if not obj.data.uv_layers:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')
except Exception as e:
    log("UV generation skipped:", e)

# ------------------------------------------------------------
# Material with texture (relative path "texture.png")
# ------------------------------------------------------------
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex_node = nodes.new("ShaderNodeTexImage")
tex_node.location = (-500, 0)

# Load texture.png
img = bpy.data.images.load(tex_path)

# Force USD to reference just "texture.png" (relative)
img.filepath = "texture.png"
img.filepath_raw = "texture.png"

try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

tex_node.image = img

uv_node = nodes.new("ShaderNodeTexCoord")
uv_node.location = (-750, 0)
links.new(uv_node.outputs["UV"], tex_node.inputs["Vector"])

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-150, 0)

# Base color + slight emission for visibility
links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
if "Emission" in bsdf.inputs:
    links.new(tex_node.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 0.6
if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35
if "Specular" in bsdf.inputs:
    bsdf.inputs["Specular"].default_value = 0.2

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (250, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

obj.data.materials.clear()
obj.data.materials.append(mat)

# ------------------------------------------------------------
# Export USD (not USDZ)
# ------------------------------------------------------------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("bpy.ops.wm.usd_export missing (USD exporter not available)")

# Use relative paths so texture is portable into USDZ
bpy.ops.wm.usd_export(
    filepath=USD,
    selected_objects_only=True,
    export_textures=True,
    relative_paths=True,
    export_materials=True,
)

# Validate output
if not os.path.exists(USD):
    log("USD NOT CREATED. Dir listing:", job_dir, os.listdir(job_dir))
    raise RuntimeError("usd_not_created")

log("USD created OK:", USD, "bytes:", os.path.getsize(USD))

# Diagnostic: show any texture references embedded in the USD
try:
    out = subprocess.check_output(["strings", USD], stderr=subprocess.STDOUT).decode("utf-8", "ignore")
    hits = []
    for line in out.splitlines():
        low = line.lower()
        if "png" in low or "texture" in low or "/tmp/" in low or "textures/" in low:
            hits.append(line[:300])
    log("USD strings hits:", hits[:50])
except Exception as e:
    log("strings diagnostic skipped:", e)
