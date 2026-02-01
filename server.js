import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS (Shopify -> Render)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Work dir ----------
const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

// ---------- Runner ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

// ---------- Build USDZ ----------
app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body || {};
    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);
    const glbPath = path.join(WORK_DIR, `${id}.glb`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // 1) Download image
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`image_download_failed_${r.status}`);
    fs.writeFileSync(imgPath, Buffer.from(await r.arrayBuffer()));

    // 2) Blender -> GLB
    await run("blender", [
      "-b",
      "-P",
      "/app/make_glb.py",
      "--",
      imgPath,
      glbPath,
      String(widthCm),
      String(heightCm),
    ]);

    // 3) GLB -> USDZ (must exist in container as /usr/local/bin/usdzconvert)
    await run("usdzconvert", [glbPath, usdzPath]);

    return res.json({
      ok: true,
      usdzUrl: `${PUBLIC_BASE_URL}/usdz/${id}.usdz`,
    });
  } catch (e) {
    console.error("BUILD_USDZ_ERROR:", e);
    return res.status(500).json({
      ok: false,
      reason: "server_error",
      message: String(e?.message || e),
    });
  }
});

// ---------- Static serve ----------
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.toLowerCase().endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// ✅ IMPORTANT: Render port binding (NO HARDCODE)
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log("USDZ server running on port", PORT);
  console.log("PUBLIC_BASE_URL:", PUBLIC_BASE_URL);
});
