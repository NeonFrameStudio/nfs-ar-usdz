import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Render public URL (fallback safe)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

/* --------------------------------------------------
   CORS (FIX)
-------------------------------------------------- */

/**
 * Why this is required:
 * Your Shopify site (https://www.neonframestudio.com) calls this API cross-origin.
 * Browsers do a CORS preflight (OPTIONS) for JSON POST requests.
 * Without Access-Control-Allow-Origin on the OPTIONS + POST response, the browser blocks it.
 */

// Comma-separated list of exact origins you want to allow.
// Example value:
// https://www.neonframestudio.com,https://neonframestudio.com,https://admin.shopify.com
const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients / Quick Look / curl

  // Always allow your main storefronts
  const hardAllow = new Set([
    "https://www.neonframestudio.com",
    "https://neonframestudio.com",
    ...EXTRA_ALLOWED_ORIGINS,
  ]);

  if (hardAllow.has(origin)) return true;

  // Allow Shopify preview domains (theme preview / checkout surfaces often come from these)
  // Examples:
  // https://xxxx.myshopify.com
  // https://xxxx.shopify.com (rare, but keep flexible)
  if (/^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.shopify\.com$/i.test(origin)) return true;

  // Local dev
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;

  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin)) {
    // Echo the requesting origin (safer than "*")
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );

    // If you ever use cookies/credentials, you MUST set this and cannot use "*"
    // res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // Handle preflight immediately
  if (req.method === "OPTIONS") {
    // Some browsers want a 204, some accept 200—204 is standard.
    return res.status(204).end();
  }

  next();
});

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

async function runCmd(cmd, args, { cwd, timeoutMs } = {}) {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    const timer =
      timeoutMs &&
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        out,
        err,
      });
    });
  });
}

/**
 * If the USD coming out of Blender is USDA (ASCII), Quick Look is much happier with USDC (binary).
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

  // If USDA or something else, try convert to USDC using usdcat
  const outPath = usdPath.replace(/\.usd$/i, ".usdc.usd");

  // Detect usdcat existence
  const which = await runCmd("sh", ["-lc", "command -v usdcat"], { timeoutMs: 8000 });
  if (!which.ok || !which.out.trim()) {
    result.converter = "usdcat_missing";
    return result;
  }

  // Convert
  const conv = await runCmd(
    "sh",
    ["-lc", `usdcat "${usdPath}" -o "${outPath}"`],
    { timeoutMs: 30000 }
  );

  result.converter = "usdcat";
  result.converterLogs = { out: conv.out, err: conv.err };

  if (conv.ok && fs.existsSync(outPath) && fileSize(outPath) > 16) {
    // Swap in converted file
    fs.copyFileSync(outPath, usdPath);
    result.converted = true;
    result.header = readUsdHeader8(usdPath);
  }

  return result;
}

/**
 * Fix common USD metadata that Quick Look / ARKit often expects.
 * - Ensure upAxis is Y
 * - Ensure metersPerUnit exists
 * - Ensure defaultPrim is set (Quick Look can fail without it)
 */
async function fixUsdForQuickLook(usdPath) {
  // If pxr bindings aren't available, we just skip (and rely on conversion + usdzip).
  const py = `
from pxr import Usd, UsdGeom
import sys

path = sys.argv[1]
stage = Usd.Stage.Open(path)
if not stage:
  print("ERR: cannot open", path)
  sys.exit(2)

# Y-up for ARKit
UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)

# Reasonable default
try:
  stage.SetMetersPerUnit(1.0)
except Exception:
  pass

# Ensure a defaultPrim exists
default = stage.GetDefaultPrim()
if not default:
  kids = stage.GetPseudoRoot().GetChildren()
  if kids:
    stage.SetDefaultPrim(kids[0])

stage.Save()
print("OK")
`;
  const r = await runCmd("python3", ["-c", py, usdPath], { timeoutMs: 20000 });
  // If python/pxr isn't installed, don't hard-fail — just record and continue.
  if (!r.ok) {
    return { ok: false, note: "pxr_python_missing_or_failed", ...r };
  }
  return { ok: true, ...r };
}

async function hasUsdzip() {
  const r = await runCmd("usdzip", ["--help"], { timeoutMs: 8000 });
  return r.ok;
}

async function buildUsdzWithUsdzip(outUsdzPath, usdPath, assetPaths) {
  // usdzip usage is typically: usdzip output.usdz input.usd [assets...]
  const args = [outUsdzPath, usdPath, ...(assetPaths || [])];
  return await runCmd("usdzip", args, { timeoutMs: 60000 });
}

async function buildUsdzWithZip(outUsdzPath, jobDir, files) {
  // Fallback: zip -0 (STORE). NOTE: may still fail Quick Look due to alignment requirements.
  const cmd = `cd "${jobDir}" && zip -0 -q "${outUsdzPath}" ${files
    .map((f) => `"${f}"`)
    .join(" ")}`;
  return await runCmd("sh", ["-lc", cmd], { timeoutMs: 30000 });
}

/* --------------------------------------------------
   BUILD USDZ
-------------------------------------------------- */

app.post("/build-usdz", async (req, res) => {
  const requestId = safeId();

  try {
    const { imageUrl, widthCm, heightCm } = req.body;

    if (!imageUrl || !widthCm || !heightCm) {
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

    // Paths inside jobDir
    const texPath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(jobDir, `${jobId}.usdz`);

    // 1) Download image
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error(`image_fetch_failed_${imgResp.status}`);

    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync(texPath, imgBuf);

    // 2) Run Blender (make_usd.py) to generate model.usd referencing texture.png
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

    if (!blender.ok) {
      throw new Error("blender_failed");
    }
    if (!fs.existsSync(usdPath)) {
      throw new Error("usd_missing");
    }

    // Ensure USDC if possible
    const usdcCheck = await ensureUsdc(usdPath);

    // Fix USD metadata (best-effort)
    const usdFix = await fixUsdForQuickLook(usdPath);

    // Build USDZ (prefer usdzip; fallback zip)
    let usdzBuild = { ok: false, method: null, out: "", err: "" };

    // Always remove any previous file
    try {
      fs.unlinkSync(usdzPath);
    } catch {}

    if (await hasUsdzip()) {
      usdzBuild.method = "usdzip";
      usdzBuild = {
        ...usdzBuild,
        ...(await buildUsdzWithUsdzip(usdzPath, usdPath, [texPath])),
      };
    } else {
      usdzBuild.method = "zip";
      usdzBuild = {
        ...usdzBuild,
        ...(await buildUsdzWithZip(usdzPath, jobDir, ["model.usd", "texture.png"])),
      };
    }

    if (!fs.existsSync(usdzPath)) throw new Error("usdz_missing");

    // Public URL
    const publicUsdzUrl = `${PUBLIC_BASE_URL}/usdz/${jobId}/${jobId}.usdz`;

    // Helpful listing for debugging
    const jobDirListing = fs.readdirSync(jobDir);
    const usdzListing = `Archive: ${usdzPath}`;

    return res.json({
      ok: true,
      requestId,
      usdzUrl: publicUsdzUrl,
      debug: {
        source: "url",
        imageUrl,
        bytesIn: imgBuf.length,
        bytesOut: fileSize(usdzPath),
      },
      blender: {
        out: blender.out.slice(0, 4000),
        err: blender.err.slice(0, 4000),
      },
      usd: usdcCheck,
      usdFix,
      usdzBuild: {
        method: usdzBuild?.method || null,
        ok: !!usdzBuild?.ok,
        out: (usdzBuild?.out || "").slice(0, 8000),
        err: (usdzBuild?.err || "").slice(0, 8000),
      },
      usdzListing,
      jobDirListing,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      requestId,
      reason: err?.message || String(err),
    });
  }
});

/* --------------------------------------------------
   SERVE USDZ FILES
-------------------------------------------------- */

// Serve /usdz/<jobId>/<jobId>.usdz
app.get("/usdz/:jobId/:file", (req, res) => {
  try {
    const { jobId, file } = req.params;

    // Safety: only allow exact expected filename
    if (file !== `${jobId}.usdz`) {
      return res.status(404).send("not_found");
    }

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

app.get("/", (req, res) => res.send("OK"));

/* --------------------------------------------------
   START
-------------------------------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`USDZ server running on port ${PORT}`);
});
