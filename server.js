import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "15mb" }));

// CORS (Shopify -> Render)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// IMPORTANT: Render assigns PORT
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} exited ${code}\n\nSTDOUT:\n${out}\n\nSTDERR:\n${err}`));
    });
  });
}

app.get("/", (req, res) => res.json({ ok: true, service: "nfs-ar-usdz" }));

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;
    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);
    const usdcPath = path.join(WORK_DIR, `${id}.usdc`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // 1) download image
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`image_download_failed: ${r.status}`);
    fs.writeFileSync(imgPath, Buffer.from(await r.arrayBuffer()));

    // 2) Blender -> USD (usdc)
    await run("blender", [
      "-b",
      "-P",
      "/app/make_usd.py",
      "--",
      imgPath,
      usdcPath,
      String(widthCm),
      String(heightCm),
    ]);

    // 3) USD -> USDZ using usdzip (Pixar USD tool)
    // -a = add assets / textures
    await run("usdzip", ["-a", usdzPath, usdcPath]);

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

// serve generated usdz
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.toLowerCase().endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

app.listen(PORT, () => console.log("USDZ server running on port", PORT));
