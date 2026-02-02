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

// ✅ PATCH: capture stdout/stderr so you can SEE why Blender failed
function run(cmd, args, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });

    let out = "";
    let err = "";

    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => reject({ kind: "spawn_error", e, out, err }));
    p.on("close", (code) => {
      if (code === 0) resolve({ code, out, err });
      else reject({ kind: "exit_code", code, out, err });
    });
  });
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

async function bufferToNormalizedPng(buf, outPngPath) {
  if (!buf || buf.length < 200)
    throw new Error(`image_too_small:${buf ? buf.length : 0}`);

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
  let jobDir = null;
  let blenderLogs = null;

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
    jobDir = path.join(WORK_DIR, id);
    fs.mkdirSync(jobDir, { recursive: true });

    // Keep ALL assets in jobDir so USD references can be relative
    const texturePath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // 0) Prepare normalized PNG
    const info = imageDataUrl
      ? await dataUrlAndNormalizeToPng(imageDataUrl, texturePath)
      : await downloadAndNormalizeToPng(imageUrl, texturePath);

    // 1) Blender -> USD
    // ✅ Run Blender with cwd = jobDir to keep relative-path behavior consistent
    blenderLogs = await run(
      "blender",
      [
        "-b",
        "-P",
        "/app/make_usd.py",
        "--",
        texturePath,
        usdPath,
        String(widthCm),
        String(heightCm),
      ],
      jobDir
    );

    if (!fs.existsSync(usdPath)) {
      const listing = fs.existsSync(jobDir) ? fs.readdirSync(jobDir) : [];
      throw new Error(`usd_missing (jobDir contents: ${JSON.stringify(listing)})`);
    }

    // 2) Zip jobDir CONTENTS as USDZ (STORE only)
    // Important: cd into jobDir so paths inside usdz are relative.
    const zipLogs = await run(
      "bash",
      ["-lc", `cd "${jobDir}" && rm -f "${usdzPath}" && zip -0 -r "${usdzPath}" .`],
      jobDir
    );

    if (!fs.existsSync(usdzPath)) throw new Error("usdz_missing");

    return res.json({
      ok: true,
      debug: info,
      blender: {
        out: (blenderLogs?.out || "").slice(0, 8000),
        err: (blenderLogs?.err || "").slice(0, 8000),
      },
      zip: {
        out: (zipLogs?.out || "").slice(0, 4000),
        err: (zipLogs?.err || "").slice(0, 4000),
      },
      usdzUrl: `${PUBLIC_BASE_URL}/usdz/${id}.usdz`,
    });
  } catch (e) {
    console.error("BUILD_USDZ_ERROR:", e);

    // if run() rejected, it will include logs
    const logs =
      e && (e.out || e.err || e.e)
        ? {
            kind: e.kind,
            code: e.code,
            out: (e.out || "").slice(0, 8000),
            err: (e.err || "").slice(0, 8000),
            spawnError: e.e ? String(e.e?.message || e.e) : null,
          }
        : null;

    // also include jobDir listing if we have it (super useful)
    const listing =
      jobDir && fs.existsSync(jobDir) ? fs.readdirSync(jobDir) : null;

    return res.status(500).json({
      ok: false,
      reason: "server_error",
      message: String(e?.message || e),
      logs,
      jobDirListing: listing,
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
        // helpful for Safari/QuickLook
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("USDZ server running on port", PORT));
