import bpy, sys, os, shutil, subprocess
import addon_utils

def log(*a):
    print("[make_usd]", *a)

argv = sys.argv[sys.argv.index("--") + 1:]
IMG, USD, W, H = argv

# cm -> meters
W = float(W) / 100.0
H = float(H) / 100.0

DEPTH = 0.015  # 1.5cm thickness (AR-safe)

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
                return mod
        except Exception as e:
            log("Addon check error:", mod, e)
    log("No USD addon explicitly enabled (may be built-in).")
    return None

enable_usd_addon()

# Ensure we have texture.png in the same directory as the USD output
try:
    if os.path.abspath(IMG) != os.path.abspath(tex_path):
        shutil.copyfile(IMG, tex_path)
        log("Copied IMG to texture.png:", tex_path)
    else:
        log("IMG already is texture.png:", tex_path)
except Exception as e:
    log("FAILED copying IMG -> texture.png:", e)
    raise

# Create a thin box (NOT a plane)
bpy.ops.mesh.primitive_cube_add(size=1)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# Scale cube to match requested size
obj.scale = (W / 2.0, H / 2.0, DEPTH / 2.0)

# Apply transforms so exported mesh has real dimensions baked in
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Ensure normals are correct (helps AR)
try:
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
except Exception as e:
    log("Normals fix skipped:", e)

# Material with texture
mat = bpy.data.materials.new("NFS_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()

tex_node = nodes.new("ShaderNodeTexImage")
tex_node.location = (-500, 0)

# IMPORTANT: Load *texture.png from job dir*
img = bpy.data.images.load(tex_path)

# CRITICAL: Force USD to reference just "texture.png" (relative)
img.filepath = "texture.png"
img.filepath_raw = "texture.png"

try:
    img.colorspace_settings.name = "sRGB"
except Exception:
    pass

tex_node.image = img

# Use UVs explicitly (sometimes helps exporter consistency)
uv_node = nodes.new("ShaderNodeTexCoord")
uv_node.location = (-750, 0)
links.new(uv_node.outputs["UV"], tex_node.inputs["Vector"])

bsdf = nodes.new("ShaderNodeBsdfPrincipled")
bsdf.location = (-150, 0)

# Make it visible in AR
if "Emission" in bsdf.inputs:
    links.new(tex_node.outputs["Color"], bsdf.inputs["Emission"])
if "Emission Strength" in bsdf.inputs:
    bsdf.inputs["Emission Strength"].default_value = 1.0
if "Roughness" in bsdf.inputs:
    bsdf.inputs["Roughness"].default_value = 0.35

links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])

out = nodes.new("ShaderNodeOutputMaterial")
out.location = (250, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

obj.data.materials.clear()
obj.data.materials.append(mat)

# Export USD
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("bpy.ops.wm.usd_export not available in this Blender build")

# Only pass supported args (Blender varies by version)
props = set()
try:
    props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
except Exception:
    pass

kwargs = {
    "filepath": USD,
    "export_materials": True,
}

# Prefer exporter writing relative refs if supported
if "relative_paths" in props:
    kwargs["relative_paths"] = True

# We package texture.png ourselves — do not let Blender relocate unless you want it
if "export_textures" in props:
    kwargs["export_textures"] = False

# Force USDC if supported
if "export_format" in props:
    kwargs["export_format"] = "USDC"

# Some Blender builds have these:
if "export_uvmaps" in props:
    kwargs["export_uvmaps"] = True
if "export_normals" in props:
    kwargs["export_normals"] = True

log("usd_export kwargs:", kwargs)
bpy.ops.wm.usd_export(**kwargs)

# Validate output
if not os.path.exists(USD):
    log("USD NOT CREATED. Dir listing:", job_dir, os.listdir(job_dir))
    raise RuntimeError("usd_not_created")

log("USD created OK:", USD, "bytes:", os.path.getsize(USD))

# EXTRA DIAGNOSTIC: show any texture references embedded in the USD
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
