import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import sharp from "sharp";

const app = express();
app.use(express.json({ limit: "25mb" }));

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

function run(cmd, args, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

async function bufferToNormalizedPng(buf, outPngPath) {
  if (!buf || buf.length < 200) throw new Error(`image_too_small:${buf ? buf.length : 0}`);

  const head = buf.slice(0, 250).toString("utf8").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype html")) {
    throw new Error("image_is_html_not_image");
  }

  // Normalize to PNG (removes weird encodings + guarantees alpha handling)
  const png = await sharp(buf, { failOnError: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(outPngPath, png);
  return { bytesIn: buf.length, bytesOut: png.length };
}

async function downloadAndNormalizeToPng(imageUrl, outPngPath) {
  const r = await fetch(imageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (NFS-AR-Bot)",
      Accept: "image/*,*/*;q=0.8",
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`image_download_failed:${r.status}:${txt.slice(0, 160)}`);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  const info = await bufferToNormalizedPng(buf, outPngPath);
  return { source: "url", imageUrl, ...info };
}

async function dataUrlAndNormalizeToPng(imageDataUrl, outPngPath) {
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) throw new Error("invalid_imageDataUrl");

  const buf = Buffer.from(parsed.b64, "base64");
  const info = await bufferToNormalizedPng(buf, outPngPath);
  return { source: "dataUrl", mime: parsed.mime, ...info };
}

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, imageDataUrl, widthCm, heightCm } = req.body;

    if ((!imageUrl && !imageDataUrl) || !widthCm || !heightCm) {
      return res.status(400).json({
        ok: false,
        reason: "missing_params",
        need: "imageUrl OR imageDataUrl + widthCm + heightCm",
      });
    }

    const id = crypto.randomUUID();
    const jobDir = path.join(WORK_DIR, id);
    fs.mkdirSync(jobDir, { recursive: true });

    // Keep ALL assets in jobDir so USD references can be relative
    const texturePath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // 0) Prepare normalized PNG
    const info = imageDataUrl
      ? await dataUrlAndNormalizeToPng(imageDataUrl, texturePath)
      : await downloadAndNormalizeToPng(imageUrl, texturePath);

    // 1) Blender -> USD (writes model.usd plus exported textures into jobDir)
    await run("blender", [
      "-b",
      "-P",
      "/app/make_usd.py",
      "--",
      texturePath,
      usdPath,
      String(widthCm),
      String(heightCm),
    ]);

    if (!fs.existsSync(usdPath)) throw new Error("usd_missing");

    // 2) Zip jobDir CONTENTS as USDZ (STORE only)
    // Important: cd into jobDir so paths inside usdz are relative.
    await run("bash", [
      "-lc",
      `cd "${jobDir}" && rm -f "${usdzPath}" && zip -0 -r "${usdzPath}" .`,
    ]);

    if (!fs.existsSync(usdzPath)) throw new Error("usdz_missing");

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

// Serve USDZ files
app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
        res.setHeader("Content-Disposition", 'inline; filename="model.usdz"');
      }
    },
  })
);

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("USDZ server running on port", PORT));
