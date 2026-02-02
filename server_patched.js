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
   CORS (FIXED) — make the API callable from your Shopify domain
-------------------------------------------------- */

const ALLOW_ORIGINS = new Set([
  "https://neonframestudio.com",
  "https://www.neonframestudio.com",
  "https://neon-frame-studio.myshopify.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;

  // Exact allowlist
  if (ALLOW_ORIGINS.has(origin)) return true;

  // Shopify preview/editor domains (best-effort patterns)
  // e.g. https://something.shopifypreview.com , https://something.myshopify.com
  try {
    const u = new URL(origin);
    const h = (u.hostname || "").toLowerCase();

    if (h.endsWith(".myshopify.com")) return true;
    if (h.endsWith(".shopifypreview.com")) return true;
    if (h.endsWith(".shopifypreview.com")) return true;
    if (h.endsWith(".shopify.com")) return true;

    return false;
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    // Allow whatever headers the browser requested, otherwise our default
    const reqHdr = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      reqHdr ? reqHdr : "Content-Type, Authorization"
    );
    // Preflight caching
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// Global CORS application (covers success + most errors)
app.use((req, res, next) => {
  try {
    applyCors(req, res);
  } catch {}
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

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
   ERROR HANDLING (keeps CORS headers on failures)
-------------------------------------------------- */

app.use((err, req, res, next) => {
  try { applyCors(req, res); } catch {}
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, reason: "server_error" });
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
  console.log(`USDZ server running on port ${PORT}`);
});
