import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();

/* --------------------------------------------------
   VERSION STAMP (confirm deploy)
-------------------------------------------------- */
const SERVER_VERSION = "server.js vAR-2026-02-03-imageData+zip0+blenderPxrFix";

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */
const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Public base URL (Render service URL)
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
  if (!origin) return true;
  if (HARD_ALLOW.has(origin)) return true;

  if (/^https:\/\/([a-z0-9-]+\.)*neonframestudio\.com$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)) return true;
  if (/^https:\/\/admin\.shopify\.com$/i.test(origin)) return true;

  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;

  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");

  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");

    const reqHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      reqHeaders ? String(reqHeaders) : "Content-Type, Authorization, X-Requested-With"
    );

    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

app.use((req, res, next) => {
  try { applyCors(req, res); } catch {}
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.options("/build-usdz", (req, res) => {
  try { applyCors(req, res); } catch {}
  return res.status(204).end();
});

/* --------------------------------------------------
   BODY PARSER
-------------------------------------------------- */
app.use(express.json({ limit: "12mb" }));

/* --------------------------------------------------
   UTILS
-------------------------------------------------- */
function safeId() {
  return crypto.randomBytes(16).toString("hex");
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function readUsdHeader8(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return { ascii: buf.toString("ascii"), hex: buf.toString("hex") };
  } catch {
    return null;
  }
}

function sniffImageMagic(buf) {
  if (!buf || buf.length < 12) return { type: "unknown", note: "too_small" };
  const hex = buf.subarray(0, 12).toString("hex");
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return { type: "png", hex };
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: "jpeg", hex };
  // WEBP: RIFF....WEBP
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return { type: "webp", hex };
  // HTML
  const head = buf.subarray(0, 64).toString("utf8").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype")) return { type: "html", hex };
  return { type: "unknown", hex };
}

/**
 * SAFE runCmd:
 * - handles spawn "error" (ENOENT, etc.)
 * - always resolves (never crashes)
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
      child = spawn(cmd, args, { cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ ok: false, code: -1, out: "", err: String(e?.message || e) });
    }

    let out = "";
    let err = "";

    const timer =
      timeoutMs &&
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
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
      done({ ok: code === 0, code, out, err });
    });
  });
}

/**
 * If USD is USDA, Quick Look often prefers USDC (binary).
 * Best-effort: use usdcat if present.
 */
async function ensureUsdc(usdPath) {
  const result = { header: null, converted: false, converter: null, converterLogs: null, path: usdPath };

  result.header = readUsdHeader8(usdPath);
  if (!result.header) return result;
  if (result.header.ascii === "PXR-USDC") return result;

  const outPath = usdPath.replace(/\.usd$/i, ".usdc.usd");

  const which = await runCmd("sh", ["-lc", "command -v usdcat"], { timeoutMs: 8000 });
  if (!which.ok || !which.out.trim()) {
    result.converter = "usdcat_missing";
    return result;
  }

  const conv = await runCmd("sh", ["-lc", `usdcat "${usdPath}" -o "${outPath}"`], { timeoutMs: 30000 });
  result.converter = "usdcat";
  result.converterLogs = { out: conv.out, err: conv.err };

  if (conv.ok && fs.existsSync(outPath) && fileSize(outPath) > 16) {
    fs.copyFileSync(outPath, usdPath);
    result.converted = true;
    result.header = readUsdHeader8(usdPath);
  }

  return result;
}

/* --------------------------------------------------
   USDZ BUILD HELPERS
-------------------------------------------------- */
async function hasUsdzip() {
  const r = await runCmd("sh", ["-lc", "command -v usdzip"], { timeoutMs: 8000 });
  return !!(r.ok && r.out && r.out.trim());
}

async function buildUsdzWithUsdzip(outUsdzPath, usdPath, assetPaths) {
  const args = [outUsdzPath, usdPath, ...(assetPaths || [])];
  return await runCmd("usdzip", args, { timeoutMs: 60000 });
}

async function buildUsdzWithZip(outUsdzPath, jobDir, files) {
  // USDZ MUST be STORE (no compression)
  const cmd = `cd "${jobDir}" && zip -0 -q "${outUsdzPath}" ${files.map((f) => `"${f}"`).join(" ")}`;
  return await runCmd("sh", ["-lc", cmd], { timeoutMs: 30000 });
}

/* --------------------------------------------------
   BUILD USDZ
-------------------------------------------------- */
app.post("/build-usdz", async (req, res) => {
  const requestId = safeId();

  try {
    const { imageUrl, imageData, widthCm, heightCm } = req.body || {};

    if ((!imageUrl && !imageData) || !widthCm || !heightCm) {
      return res.status(400).json({
        ok: false,
        reason: "missing_params",
        requestId,
        expected: { imageUrl: "https://...", "or": "imageData:data:image/png;base64,...", widthCm: "number", heightCm: "number" },
        debug: { serverVersion: SERVER_VERSION },
      });
    }

    const jobId = safeId();
    const jobDir = path.join(WORK_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const texPath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(jobDir, `${jobId}.usdz`);

    // 1) Get texture bytes (prefer imageData because it's guaranteed to be a real PNG)
    let imgBuf;
    let source = null;
    let imageType = null;

    if (imageData && typeof imageData === "string" && imageData.startsWith("data:image/")) {
      source = "data";
      const m = imageData.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      if (!m) throw new Error("bad_imageData_format");
      imgBuf = Buffer.from(m[2], "base64");
      imageType = (m[1] || "").toLowerCase();
    } else {
      source = "url";
      const r = await fetch(String(imageUrl), { redirect: "follow" });
      if (!r.ok) throw new Error(`image_fetch_failed_${r.status}`);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      imgBuf = Buffer.from(await r.arrayBuffer());
      imageType = ct || "unknown";
    }

    const magic = sniffImageMagic(imgBuf);
    // We REQUIRE PNG because make_usd.py loads texture.png as PNG.
    if (magic.type !== "png") {
      const preview = imgBuf.subarray(0, 160).toString("utf8").replace(/\s+/g, " ").slice(0, 160);
      return res.status(400).json({
        ok: false,
        requestId,
        reason: "image_not_png",
        got: { source, imageType, magic, preview },
        fix: "Send imageData from canvas.toDataURL('image/png') OR provide a direct PNG URL (cdn.shopify.com).",
        debug: { serverVersion: SERVER_VERSION },
      });
    }

    fs.writeFileSync(texPath, imgBuf);

    // 2) Run Blender to build USD (uses /app/make_usd.py)
    const blender = await runCmd(
      "sh",
      ["-lc", `blender -b -P /app/make_usd.py -- "${texPath}" "${usdPath}" "${Number(widthCm)}" "${Number(heightCm)}"`],
      { timeoutMs: 180000 }
    );

    if (!blender.ok) throw new Error(`blender_failed: ${blender.err || blender.out}`);
    if (!fs.existsSync(usdPath)) throw new Error("usd_missing");

    // 3) Best-effort USDC conversion
    const usdcCheck = await ensureUsdc(usdPath);

    // 4) Build USDZ (prefer usdzip; fallback zip -0 store)
    let usdzBuild = { ok: false, method: null, out: "", err: "" };
    try { fs.unlinkSync(usdzPath); } catch {}

    const canUsdzip = await hasUsdzip();
    if (canUsdzip) {
      usdzBuild.method = "usdzip";
      usdzBuild = { ...usdzBuild, ...(await buildUsdzWithUsdzip(usdzPath, usdPath, [texPath])) };
    } else {
      usdzBuild.method = "zip";
      usdzBuild = { ...usdzBuild, ...(await buildUsdzWithZip(usdzPath, jobDir, ["model.usd", "texture.png"])) };
    }

    if (!fs.existsSync(usdzPath) || fileSize(usdzPath) < 64) {
      throw new Error(`usdz_missing_or_empty (${usdzBuild.method})`);
    }

    const publicUsdzUrl = `${PUBLIC_BASE_URL}/usdz/${jobId}/${jobId}.usdz`;

    return res.json({
      ok: true,
      requestId,
      usdzUrl: publicUsdzUrl,
      debug: {
        serverVersion: SERVER_VERSION,
        imageSource: source,
        imageType,
        magic,
        bytesIn: imgBuf.length,
        bytesOut: fileSize(usdzPath),
      },
      blender: { ok: blender.ok, out: blender.out.slice(0, 4000), err: blender.err.slice(0, 4000) },
      usd: usdcCheck,
      usdzBuild: {
        method: usdzBuild.method,
        ok: !!usdzBuild.ok,
        out: (usdzBuild.out || "").slice(0, 4000),
        err: (usdzBuild.err || "").slice(0, 4000),
      },
      jobDirListing: fs.readdirSync(jobDir),
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
  return res.json({ ok: true, serverVersion: SERVER_VERSION });
});

/* --------------------------------------------------
   ERROR HANDLER
-------------------------------------------------- */
app.use((err, req, res, next) => {
  try { applyCors(req, res); } catch {}
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ ok: false, reason: "server_error", serverVersion: SERVER_VERSION });
});

process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

/* --------------------------------------------------
   START
-------------------------------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`USDZ server running on port ${PORT} (${SERVER_VERSION})`);
});
