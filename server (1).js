import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();

/* --------------------------------------------------
   VERSION STAMP (so you can confirm correct deploy)
-------------------------------------------------- */
const SERVER_VERSION = "server.js v2026-02-03-zip-fallback-enabled+pxrfix+imageData";

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Public base URL (where THIS server is reachable)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

/* --------------------------------------------------
   CORS
-------------------------------------------------- */

const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const HARD_ALLOW = new Set([
  "https://www.neonframestudio.com",
  "https://neonframestudio.com",
  ...EXTRA_ALLOWED_ORIGINS,
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server / curl

  if (HARD_ALLOW.has(origin)) return true;

  // any secure subdomain of neonframestudio.com
  if (/^https:\/\/([a-z0-9-]+\.)*neonframestudio\.com$/i.test(origin)) return true;

  // Shopify shop domain
  if (/^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)) return true;

  // Shopify admin surfaces
  if (/^https:\/\/admin\.shopify\.com$/i.test(origin)) return true;

  // Local dev
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;

  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  // always vary for caches/proxies
  res.setHeader("Vary", "Origin");

  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");

    const reqHeaders = req.headers["access-control-request-headers"];
    if (reqHeaders) {
      res.setHeader("Access-Control-Allow-Headers", String(reqHeaders));
    } else {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With"
      );
    }

    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// Global CORS middleware (runs BEFORE body parsing)
app.use((req, res, next) => {
  try {
    applyCors(req, res);
  } catch {}

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Extra explicit OPTIONS handler
app.options("/build-usdz", (req, res) => {
  try {
    applyCors(req, res);
  } catch {}
  return res.status(204).end();
});

/* --------------------------------------------------
   BODY PARSER
-------------------------------------------------- */
app.use(express.json({ limit: "10mb" }));

/* --------------------------------------------------
   UTILS
-------------------------------------------------- */

function safeId() {
  return crypto.randomBytes(16).toString("hex");
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function readUsdHeader8(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return {
      ascii: buf.toString("ascii"),
      hex: buf.toString("hex"),
    };
  } catch {
    return null;
  }
}

function sniffPng(buf) {
  try {
    if (!buf || buf.length < 8) return false;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  } catch {
    return false;
  }
}

function parseDataUrlImage(dataUrl) {
  // expects data:image/png;base64,....
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[3];
  const buf = Buffer.from(b64, "base64");
  return { mime, buf };
}

/**
 * SAFE runCmd:
 * - handles "error" event (e.g. ENOENT when command doesn't exist)
 * - always resolves (never crashes the process)
 */
async function runCmd(cmd, args, { cwd, timeoutMs } = {}) {
  return await new Promise((resolve) => {
    let resolved = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return done({
        ok: false,
        code: -1,
        out: "",
        err: String(e?.message || e),
      });
    }

    let out = "";
    let err = "";

    const timer =
      timeoutMs &&
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeoutMs);

    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      done({
        ok: false,
        code: -1,
        out,
        err: (err ? err + "\n" : "") + `spawn_error: ${e?.code || ""} ${e?.message || e}`,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({
        ok: code === 0,
        code,
        out,
        err,
      });
    });
  });
}

/**
 * If USD is ASCII (usda), Quick Look is often happier with binary (usdc).
 * This tries to convert using usdcat if present.
 */
async function ensureUsdc(usdPath) {
  const result = {
    header: null,
    converted: false,
    converter: null,
    converterLogs: null,
    path: usdPath,
  };

  result.header = readUsdHeader8(usdPath);
  if (!result.header) return result;

  // Already USDC?
  if (result.header.ascii === "PXR-USDC") return result;

  const outPath = usdPath.replace(/\.usd$/i, ".usdc.usd");

  const which = await runCmd("sh", ["-lc", "command -v usdcat"], { timeoutMs: 8000 });
  if (!which.ok || !which.out.trim()) {
    result.converter = "usdcat_missing";
    return result;
  }

  const conv = await runCmd("sh", ["-lc", `usdcat "${usdPath}" -o "${outPath}"`], {
    timeoutMs: 30000,
  });

  result.converter = "usdcat";
  result.converterLogs = { out: conv.out, err: conv.err };

  if (conv.ok && fs.existsSync(outPath) && fileSize(outPath) > 16) {
    fs.copyFileSync(outPath, usdPath);
    result.converted = true;
    result.header = readUsdHeader8(usdPath);
  }

  return result;
}

/**
 * Fix common USD issues for Quick Look / ARKit by running pxr inside Blender python.
 */
async function fixUsdForQuickLook(usdPath, jobDir) {
  const scriptPath = path.join(jobDir, "fix_quicklook.py");

  const script = `
import sys, os
if "--" not in sys.argv:
  print("ERR: missing -- separator")
  raise SystemExit(2)

usdPath = sys.argv[sys.argv.index("--")+1]

from pxr import Usd, UsdGeom, Sdf, UsdShade

stage = Usd.Stage.Open(usdPath)
if not stage:
  print("ERR: cannot open", usdPath)
  raise SystemExit(2)

UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
try:
  stage.SetMetersPerUnit(1.0)
except Exception:
  pass

default = stage.GetDefaultPrim()
if not default:
  kids = stage.GetPseudoRoot().GetChildren()
  if kids:
    stage.SetDefaultPrim(kids[0])
    default = stage.GetDefaultPrim()

# rewrite any texture asset paths -> basename
for prim in stage.Traverse():
  for attr in prim.GetAttributes():
    tn = attr.GetTypeName()
    try:
      if tn == Sdf.ValueTypeNames.Asset:
        v = attr.Get()
        if v and hasattr(v, "path"):
          p = v.path or ""
          low = p.lower()
          if low.endswith((".png",".jpg",".jpeg",".webp")):
            attr.Set(Sdf.AssetPath(os.path.basename(p)))
      elif tn == Sdf.ValueTypeNames.AssetArray:
        arr = attr.Get() or []
        out = []
        changed = False
        for v in arr:
          p = v.path if hasattr(v,"path") else str(v)
          low = (p or "").lower()
          if low.endswith((".png",".jpg",".jpeg",".webp")):
            out.append(Sdf.AssetPath(os.path.basename(p)))
            changed = True
          else:
            out.append(v)
        if changed:
          attr.Set(out)
    except Exception:
      pass

# find first Mesh
meshPrim = None
if default:
  for p in Usd.PrimRange(default):
    if p.GetTypeName() == "Mesh":
      meshPrim = p
      break

# ensure uv primvar is named st
try:
  if meshPrim:
    pv = UsdGeom.PrimvarsAPI(meshPrim)
    stpv = pv.GetPrimvar("st")
    if (not stpv) or (not stpv.IsDefined()):
      candidate = None
      preferred = ("st0","st1","uv","uv0","texcoord","texcoords","map1")
      for pr in pv.GetPrimvars():
        try:
          n = pr.GetName()
          tn = pr.GetTypeName()
          is_tex = (tn == Sdf.ValueTypeNames.TexCoord2fArray) or (tn == Sdf.ValueTypeNames.Float2Array)
          if is_tex and n != "st":
            candidate = pr
            if n.lower() in preferred:
              break
        except Exception:
          pass
      if candidate and candidate.IsDefined():
        vals = candidate.Get()
        interp = candidate.GetInterpolation()
        newst = pv.CreatePrimvar("st", candidate.GetTypeName(), interp)
        newst.Set(vals)
except Exception as e:
  print("uv_fix_skipped", e)

# force a UsdPreviewSurface material (Quick Look friendly)
if meshPrim and default:
  matPath = default.GetPath().AppendChild("NFS_Material")
  mat = UsdShade.Material.Define(stage, matPath)

  pbrPath = matPath.AppendChild("PreviewSurface")
  pbr = UsdShade.Shader.Define(stage, pbrPath)
  pbr.CreateIdAttr("UsdPreviewSurface")
  pbrOut = pbr.CreateOutput("surface", Sdf.ValueTypeNames.Token)

  texPath = matPath.AppendChild("Texture")
  tex = UsdShade.Shader.Define(stage, texPath)
  tex.CreateIdAttr("UsdUVTexture")
  tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath("texture.png"))
  tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
  texRgb = tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)

  stPath = matPath.AppendChild("PrimvarST")
  st = UsdShade.Shader.Define(stage, stPath)
  st.CreateIdAttr("UsdPrimvarReader_float2")
  st.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
  stOut = st.CreateOutput("result", Sdf.ValueTypeNames.Float2)

  tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(stOut)
  pbr.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(texRgb)

  matSurf = mat.CreateSurfaceOutput()
  matSurf.ConnectToSource(pbrOut)
  UsdShade.MaterialBindingAPI(meshPrim).Bind(mat)

# autoscale if tiny
try:
  if default:
    root = UsdGeom.Xformable(default)
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
    bbox = cache.ComputeWorldBound(default).ComputeAlignedBox()
    size = bbox.GetSize()
    longest = max(size[0], size[1], size[2])
    if longest > 0 and longest < 0.10:
      s = root.AddScaleOp()
      s.Set((100.0, 100.0, 100.0))
except Exception as e:
  print("scale_fix_skipped", e)

stage.GetRootLayer().Save()
print("OK fixed", usdPath)
`;

  fs.writeFileSync(scriptPath, script, "utf8");

  const t0 = Date.now();
  const r = await runCmd("blender", ["-b", "-P", scriptPath, "--", usdPath], {
    cwd: jobDir,
    timeoutMs: 120000,
  });

  if (!r.ok) {
    return { ok: false, note: "blender_pxr_fix_failed", ms: Date.now() - t0, ...r };
  }

  // If Blender printed ERR: or Traceback, treat as failure
  const out = String(r.out || "");
  const err = String(r.err || "");
  if (out.includes("ERR:") || err.includes("Traceback") || out.includes("Traceback")) {
    return { ok: false, note: "pxr_script_error", ms: Date.now() - t0, ...r };
  }

  return { ok: true, ms: Date.now() - t0, ...r };
}

/* --------------------------------------------------
   USDZ BUILD HELPERS
-------------------------------------------------- */

async function hasUsdzip() {
  const r = await runCmd("sh", ["-lc", "command -v usdzip"], { timeoutMs: 8000 });
  return !!(r.ok && r.out && r.out.trim());
}

async function buildUsdzWithUsdzip(outUsdzPath, jobDir) {
  const cmd = `cd "${jobDir}" && usdzip "${outUsdzPath}" "model.usd" "texture.png"`;
  return await runCmd("sh", ["-lc", cmd], { timeoutMs: 60000 });
}

async function buildUsdzWithZip(outUsdzPath, jobDir, files) {
  // USDZ must be STORE (no compression) => zip -0
  const cmd = `cd "${jobDir}" && zip -0 -q "${outUsdzPath}" ${files
    .map((f) => `"${f}"`)
    .join(" ")}`;
  return await runCmd("sh", ["-lc", cmd], { timeoutMs: 30000 });
}

/* --------------------------------------------------
   BUILD USDZ ENDPOINT
-------------------------------------------------- */

app.post("/build-usdz", async (req, res) => {
  const requestId = safeId();

  try {
    const { imageUrl, imageData, widthCm, heightCm } = req.body;

    if ((!imageData && !imageUrl) || !widthCm || !heightCm) {
      return res.status(400).json({
        ok: false,
        reason: "missing_params",
        requestId,
      });
    }

    // Unique job dir
    const jobId = safeId();
    const jobDir = path.join(WORK_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const texPath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(jobDir, `${jobId}.usdz`);

    // 1) Get image (prefer imageData; fallback imageUrl)
    let imgBuf;

    if (imageData) {
      const parsed = parseDataUrlImage(imageData);
      if (!parsed) {
        return res.status(400).json({
          ok: false,
          reason: "imageData_invalid",
          requestId,
        });
      }
      imgBuf = parsed.buf;
    } else {
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error(`image_fetch_failed_${imgResp.status}`);
      imgBuf = Buffer.from(await imgResp.arrayBuffer());
    }

    // Validate PNG (prevents grey/purple slabs from HTML/404)
    if (!sniffPng(imgBuf)) {
      return res.status(400).json({
        ok: false,
        reason: "image_not_png",
        requestId,
        debug: {
          serverVersion: SERVER_VERSION,
          firstBytesHex: Buffer.from(imgBuf.slice(0, 32)).toString("hex"),
        },
      });
    }

    fs.writeFileSync(texPath, imgBuf);

    // 2) Run Blender make_usd.py
    const blender = await runCmd(
      "sh",
      [
        "-lc",
        `blender -b -P /app/make_usd.py -- "${texPath}" "${usdPath}" "${Number(
          widthCm
        )}" "${Number(heightCm)}"`,
      ],
      { timeoutMs: 120000 }
    );

    if (!blender.ok) throw new Error(`blender_failed: ${blender.err || blender.out}`);
    if (!fs.existsSync(usdPath)) throw new Error("usd_missing");

    // 3) USDC conversion (best-effort)
    const usdcCheck = await ensureUsdc(usdPath);

    // 4) Quick Look fix via Blender pxr
    const usdFix = await fixUsdForQuickLook(usdPath, jobDir);
    if (!usdFix.ok) {
      throw new Error(`usd_fix_failed: ${usdFix.note || "unknown"}`);
    }

    // 5) Build USDZ: prefer usdzip else zip -0 fallback
    let usdzBuild = { ok: false, method: null, out: "", err: "" };

    try {
      fs.unlinkSync(usdzPath);
    } catch {}

    const canUsdzip = await hasUsdzip();
    if (canUsdzip) {
      usdzBuild.method = "usdzip";
      usdzBuild = { ...usdzBuild, ...(await buildUsdzWithUsdzip(usdzPath, jobDir)) };
    } else {
      usdzBuild.method = "zip";
      usdzBuild = {
        ...usdzBuild,
        ...(await buildUsdzWithZip(usdzPath, jobDir, ["model.usd", "texture.png"])),
      };
    }

    if (!usdzBuild.ok) {
      throw new Error(
        `${usdzBuild.method}_failed: ${(usdzBuild.err || usdzBuild.out || "").slice(0, 400)}`
      );
    }

    if (!fs.existsSync(usdzPath) || fileSize(usdzPath) < 32) {
      throw new Error(`usdz_missing_or_empty (${usdzBuild.method})`);
    }

    const publicUsdzUrl = `${PUBLIC_BASE_URL}/usdz/${jobId}/${jobId}.usdz`;
    const jobDirListing = fs.readdirSync(jobDir);

    return res.json({
      ok: true,
      requestId,
      usdzUrl: publicUsdzUrl,
      debug: {
        serverVersion: SERVER_VERSION,
        imageUrl: imageUrl || null,
        bytesIn: imgBuf.length,
        bytesOut: fileSize(usdzPath),
      },
      blender: {
        ok: blender.ok,
        out: String(blender.out || "").slice(0, 4000),
        err: String(blender.err || "").slice(0, 4000),
      },
      usd: usdcCheck,
      usdFix: {
        ok: !!usdFix.ok,
        ms: usdFix.ms,
        out: String(usdFix.out || "").slice(0, 4000),
        err: String(usdFix.err || "").slice(0, 4000),
        note: usdFix.note || null,
      },
      usdzBuild: {
        method: usdzBuild.method,
        ok: !!usdzBuild.ok,
        out: String(usdzBuild.out || "").slice(0, 8000),
        err: String(usdzBuild.err || "").slice(0, 8000),
      },
      jobDirListing,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      requestId,
      reason: err?.message || String(err),
      debug: { serverVersion: SERVER_VERSION },
    });
  }
});

/* --------------------------------------------------
   SERVE USDZ FILES
-------------------------------------------------- */

app.get("/usdz/:jobId/:file", (req, res) => {
  try {
    const { jobId, file } = req.params;

    if (file !== `${jobId}.usdz`) return res.status(404).send("not_found");

    const p = path.join(WORK_DIR, jobId, file);
    if (!fs.existsSync(p)) return res.status(404).send("not_found");

    res.setHeader("Content-Type", "model/vnd.usdz+zip");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${file}"`);
    res.setHeader("Accept-Ranges", "bytes");

    return res.sendFile(p);
  } catch {
    return res.status(500).send("error");
  }
});

/* --------------------------------------------------
   HEALTH
-------------------------------------------------- */

app.get("/", (req, res) => {
  return res.json({
    ok: true,
    serverVersion: SERVER_VERSION,
  });
});

/* --------------------------------------------------
   ERROR HANDLER
-------------------------------------------------- */

app.use((err, req, res, next) => {
  try {
    applyCors(req, res);
  } catch {}

  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);

  return res.status(500).json({
    ok: false,
    reason: "server_error",
    serverVersion: SERVER_VERSION,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

/* --------------------------------------------------
   START
-------------------------------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`USDZ server running on port ${PORT} (${SERVER_VERSION})`);
});
