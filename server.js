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
const SERVER_VERSION = "server.js vCORS-2026-02-03b";

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Render public URL (fallback safe)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

/**
 * IMPORTANT:
 * Shopify/Chrome sometimes sends OPTIONS without an Origin header.
 * Your screenshot shows ACAO: null => browser blocks POST.
 *
 * So we must pick a safe fallback origin to respond with on OPTIONS.
 */
const FALLBACK_ORIGIN = "https://www.neonframestudio.com";

/* --------------------------------------------------
   CORS (LATEST FIX — handles missing Origin on OPTIONS)
-------------------------------------------------- */

// Extra allowlist via env (comma separated)
const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Hard allow (exact)
const HARD_ALLOW = new Set([
  "https://www.neonframestudio.com",
  "https://neonframestudio.com",
  ...EXTRA_ALLOWED_ORIGINS,
]);

function isAllowedOrigin(origin) {
  // Allow server-to-server / curl (no Origin header)
  if (!origin) return true;

  if (HARD_ALLOW.has(origin)) return true;

  // Allow any secure subdomain of neonframestudio.com
  if (/^https:\/\/([a-z0-9-]+\.)*neonframestudio\.com$/i.test(origin)) return true;

  // Shopify shop domain
  if (/^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)) return true;

  // Shopify admin surfaces (sometimes)
  if (/^https:\/\/admin\.shopify\.com$/i.test(origin)) return true;

  // Local dev
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;

  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  // Always vary for caches/proxies
  res.setHeader("Vary", "Origin");

  // Only apply CORS if origin is allowed (or missing — treated as allowed)
  if (!isAllowedOrigin(origin)) return;

  /**
   * ✅ CRITICAL FIX:
   * If Origin is missing (common on some preflights),
   * still send ACAO using a safe fallback storefront origin,
   * otherwise Chrome logs ACAO:null and blocks.
   */
  const allowOrigin = origin || FALLBACK_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  // Methods supported
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");

  // Echo requested headers if present (critical for preflight)
  const reqHeaders = req.headers["access-control-request-headers"];
  if (reqHeaders) {
    res.setHeader("Access-Control-Allow-Headers", String(reqHeaders));
  } else {
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
  }

  // Cache preflight for 1 day
  res.setHeader("Access-Control-Max-Age", "86400");

  // If you ever move to cookies/sessions, you can enable this:
  // res.setHeader("Access-Control-Allow-Credentials", "true");
}

// Global CORS middleware (runs BEFORE body parsing)
app.use((req, res, next) => {
  try {
    applyCors(req, res);
  } catch {}

  // Preflight must return immediately (WITH headers already set above)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// Extra explicit OPTIONS handler (belt + braces)
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
 * If the USD coming out of Blender is USDA (ASCII), Quick Look is often happier with USDC (binary).
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

  // Detect usdcat existence
  const which = await runCmd("sh", ["-lc", "command -v usdcat"], {
    timeoutMs: 8000,
  });
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
 * - Ensure defaultPrim is set
 */
async function fixUsdForQuickLook(usdPath) {
  const py = `
from pxr import Usd, UsdGeom
import sys

path = sys.argv[1]
stage = Usd.Stage.Open(path)
if not stage:
  print("ERR: cannot open", path)
  sys.exit(2)

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

stage.Save()
print("OK")
`;
  const r = await runCmd("python3", ["-c", py, usdPath], { timeoutMs: 20000 });
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
  const args = [outUsdzPath, usdPath, ...(assetPaths || [])];
  return await runCmd("usdzip", args, { timeoutMs: 60000 });
}

async function buildUsdzWithZip(outUsdzPath, jobDir, files) {
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

    // 2) Run Blender (make_usd.py)
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

    if (!blender.ok) throw new Error("blender_failed");
    if (!fs.existsSync(usdPath)) throw new Error("usd_missing");

    // Ensure USDC if possible
    const usdcCheck = await ensureUsdc(usdPath);

    // Fix USD metadata (best-effort)
    const usdFix = await fixUsdForQuickLook(usdPath);

    // Build USDZ (prefer usdzip; fallback zip)
    let usdzBuild = { ok: false, method: null, out: "", err: "" };

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

    const publicUsdzUrl = `${PUBLIC_BASE_URL}/usdz/${jobId}/${jobId}.usdz`;
    const jobDirListing = fs.readdirSync(jobDir);
    const usdzListing = `Archive: ${usdzPath}`;

    return res.json({
      ok: true,
      requestId,
      usdzUrl: publicUsdzUrl,
      debug: {
        serverVersion: SERVER_VERSION,
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
    // IMPORTANT: CORS headers should still be present (global middleware already ran)
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

app.get("/", (req, res) => {
  return res.json({
    ok: true,
    serverVersion: SERVER_VERSION,
  });
});

/* --------------------------------------------------
   ERROR HANDLER (keeps CORS on unexpected failures)
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
