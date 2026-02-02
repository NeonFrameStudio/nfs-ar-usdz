import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import sharp from "sharp";

const app = express();
app.use(express.json({ limit: "20mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

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

async function downloadAndNormalizeToPng(imageUrl, outPngPath) {
  const r = await fetch(imageUrl, {
    redirect: "follow",
    headers: {
      // Some CDNs block "no UA" fetches
      "User-Agent": "Mozilla/5.0 (NFS-AR-Bot)",
      "Accept": "image/*,*/*;q=0.8",
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`image_download_failed:${r.status}:${txt.slice(0, 120)}`);
  }

  const contentType = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  // Quick sanity checks
  if (buf.length < 200) {
    throw new Error(`image_too_small:${buf.length}`);
  }

  // If it’s HTML, it’s not an image (blocked/expired/redirect page)
  const head = buf.slice(0, 200).toString("utf8").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype html")) {
    throw new Error(`image_is_html_not_image`);
  }

  // Convert ANYTHING (jpg/webp/png) into a guaranteed valid PNG
  // This fixes the exact “does not have any image data” Blender crash.
  const png = await sharp(buf, { failOnError: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(outPngPath, png);

  return { contentType, bytesIn: buf.length, bytesOut: png.length };
}

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;
    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const pngPath = path.join(WORK_DIR, `${id}.png`);
    const usdPath = path.join(WORK_DIR, `${id}.usd`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    const info = await downloadAndNormalizeToPng(imageUrl, pngPath);

    // 1) Blender -> USD (flat plane w/ texture)
    await run("blender", [
      "-b",
      "-P",
      "/app/make_usd.py",
      "--",
      pngPath,
      usdPath,
      String(widthCm),
      String(heightCm),
    ]);

    if (!fs.existsSync(usdPath)) {
      throw new Error("usd_missing");
    }

    // 2) Package USD + PNG into USDZ (USDZ is just a zip with STORE/no compression)
    // Apple expects no compression: zip -0
    await run("bash", [
      "-lc",
      `cd ${WORK_DIR} && rm -f ${id}.usdz && zip -0 ${id}.usdz ${id}.usd ${id}.png`,
    ]);

    if (!fs.existsSync(usdzPath)) {
      throw new Error("usdz_missing");
    }

    return res.json({
      ok: true,
      debug: info,
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

// Serve files
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.endsWith(".usdz")) res.setHeader("Content-Type", "model/vnd.usdz+zip");
      if (p.endsWith(".usd")) res.setHeader("Content-Type", "application/octet-stream");
      if (p.endsWith(".png")) res.setHeader("Content-Type", "image/png");
    },
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("USDZ server running on port", PORT));
