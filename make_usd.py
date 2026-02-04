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

# Ensure texture.png exists in job dir (server already writes it; keep safe copy)
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
# Geometry: Plane + Solidify
# ------------------------------------------------------------
bpy.ops.mesh.primitive_plane_add(size=2)
obj = bpy.context.active_object
obj.name = "NFS_Frame"

# Plane is 2m x 2m (edge length) when size=2, so scale to W x H
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

# Ensure there is a UV map and it is named "st" (Quick Look safe)
try:
    if not obj.data.uv_layers:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')

    # Force active UV layer name to "st"
    if obj.data.uv_layers:
        obj.data.uv_layers.active = obj.data.uv_layers[0]
        obj.data.uv_layers.active.name = "st"
        # Optionally remove extra UV layers to avoid exporter picking another one
        while len(obj.data.uv_layers) > 1:
            obj.data.uv_layers.remove(obj.data.uv_layers[-1])

        log("UV layer forced to:", obj.data.uv_layers.active.name)
except Exception as e:
    log("UV setup skipped:", e)

# ------------------------------------------------------------
# IMPORTANT: Do NOT author Blender materials/textures in USD.
# Your server binds a clean UsdPreviewSurface -> texture.png.
# Blender exporting materials can create paths Quick Look ignores.
# ------------------------------------------------------------
# (We deliberately do NOT create a material node tree here.)

# ------------------------------------------------------------
# Export USD (not USDZ)
# ------------------------------------------------------------
if not hasattr(bpy.ops.wm, "usd_export"):
    raise RuntimeError("bpy.ops.wm.usd_export missing (USD exporter not available)")

# Export GEOMETRY ONLY — server will bind materials + texture.png
bpy.ops.wm.usd_export(
    filepath=USD,
    selected_objects_only=True,

    # Keep it simple + deterministic
    export_materials=False,
    export_textures=False,
    relative_paths=True,
)

# Validate output
if not os.path.exists(USD):
    log("USD NOT CREATED. Dir listing:", job_dir, os.listdir(job_dir))
    raise RuntimeError("usd_not_created")

log("USD created OK:", USD, "bytes:", os.path.getsize(USD))

# Diagnostic: show any texture references embedded in the USD
# (Should be none; server adds binding later)
try:
    out = subprocess.check_output(["strings", USD], stderr=subprocess.STDOUT).decode("utf-8", "ignore")
    hits = []
    for line in out.splitlines():
        low = line.lower()
        if "png" in low or "texture" in low or "/tmp/" in low or "textures/" in low:
            hits.append(line[:300])
    log("USD strings hits (expect empty):", hits[:50])
except Exception as e:
    log("strings diagnostic skipped:", e)
