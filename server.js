import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

// -------------------- CORS --------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

app.use((req, res, next) => {
  res.set(CORS_HEADERS);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------------------- CONFIG --------------------
const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

// -------------------- UTILS --------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

// -------------------- ROUTES --------------------
app.options("/build-usdz", (req, res) => {
  res.set(CORS_HEADERS);
  return res.sendStatus(204);
});

app.post("/build-usdz", async (req, res) => {
  res.set(CORS_HEADERS);

  try {
    const { imageUrl, widthCm, heightCm } = req.body;

    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const imgPath  = path.join(WORK_DIR, `${id}.png`);
    const usdPath  = path.join(WORK_DIR, `${id}.usd`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // download image
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");
    fs.writeFileSync(imgPath, Buffer.from(await r.arrayBuffer()));

    // build USD via Blender
    await run("blender", [
      "-b",
      "-P", "/app/make_usd.py",
      "--",
      imgPath,
      usdPath,
      String(widthCm),
      String(heightCm),
    ]);

    // package USDZ
    await run("usdzip", [usdzPath, usdPath]);

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

// -------------------- STATIC USDZ --------------------
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
      }
    },
  })
);

// -------------------- START --------------------
app.listen(3000, () => {
  console.log("USDZ server running on port 3000");
});
