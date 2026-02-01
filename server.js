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

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Prefer Render's service URL as PUBLIC_BASE_URL in env, but fallback:
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

// Health
app.get("/", (req, res) => res.status(200).send("ok"));

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;
    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);
    const glbPath = path.join(WORK_DIR, `${id}.glb`);

    // Download image
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");
    fs.writeFileSync(imgPath, Buffer.from(await r.arrayBuffer()));

    // 1) Blender -> GLB
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

    // 2) GLB -> USDZ (python usdzconvert)
    // This tool outputs a .usdz next to the input file by default.
    await run("python3", ["/home/usdzconvert/usdzconvert", glbPath]);

    const usdzPath = glbPath.replace(/\.glb$/i, ".usdz");
    if (!fs.existsSync(usdzPath)) {
      throw new Error("usdz_not_created");
    }

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

// Serve USDZ
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.toLowerCase().endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
      }
    },
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("USDZ server running on port", PORT));
