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

// capture stdout/stderr
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

  // Normalize to PNG (strips weird profiles/encodings)
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

function readUsdHeader8(usdPath) {
  const h = fs.readFileSync(usdPath).subarray(0, 8);
  return {
    ascii: h.toString("ascii"),
    hex: Buffer.from(h).toString("hex"),
  };
}

// If USD is not USDC, attempt to convert using usdcat (from your stage1 tools)
async function ensureUsdc(jobDir, usdPath) {
  const header = readUsdHeader8(usdPath);

  // USDC typically starts with "PXR-USDC" (or similar); USDA is readable text "#usda"
  const looksUsdc = header.ascii.includes("PXR-USD") && !header.ascii.includes("#usda");
  const isUsda = header.ascii.includes("#usda") || header.ascii.toLowerCase().includes("usda");

  const result = {
    header,
    converted: false,
    converter: null,
    converterLogs: null,
  };

  if (looksUsdc && !isUsda) return result;

  // Try usdcat -> write back into model.usd as USDC
  // (Keep .usd extension but binary content)
  const tmpOut = path.join(jobDir, "model_usdc.usd");
  try {
    const logs = await run(
      "bash",
      ["-lc", `cd "${jobDir}" && usdcat "${usdPath}" -o "${tmpOut}"`],
      jobDir
    );

    if (fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 100) {
      fs.copyFileSync(tmpOut, usdPath);
      fs.unlinkSync(tmpOut);

      result.converted = true;
      result.converter = "usdcat";
      result.converterLogs = {
        out: (logs.out || "").slice(0, 4000),
        err: (logs.err || "").slice(0, 4000),
      };

      // Update header after conversion
      result.headerAfter = readUsdHeader8(usdPath);
    }

    return result;
  } catch (e) {
    // Don’t hard-fail here; return debug so we can see if usdcat exists
    result.converter = "usdcat_failed";
    result.converterLogs = {
      out: (e?.out || "").slice(0, 4000),
      err: (e?.err || "").slice(0, 4000),
      spawnError: e?.e ? String(e.e?.message || e.e) : null,
      kind: e?.kind,
      code: e?.code,
    };
    return result;
  }
}

app.post("/build-usdz", async (req, res) => {
  let jobDir = null;

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

    const texturePath = path.join(jobDir, "texture.png");
    const usdPath = path.join(jobDir, "model.usd");
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    // 0) Prepare normalized PNG
    const info = imageDataUrl
      ? await dataUrlAndNormalizeToPng(imageDataUrl, texturePath)
      : await downloadAndNormalizeToPng(imageUrl, texturePath);

    // 1) Blender -> USD (cwd = jobDir)
    const blenderLogs = await run(
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

    // 1.5) Verify/Convert to USDC if needed
    const usdcCheck = await ensureUsdc(jobDir, usdPath);

    // 2) Zip jobDir CONTENTS as USDZ (STORE only)
    const zipLogs = await run(
      "bash",
      ["-lc", `cd "${jobDir}" && rm -f "${usdzPath}" && zip -0 -r "${usdzPath}" .`],
      jobDir
    );

    if (!fs.existsSync(usdzPath)) throw new Error("usdz_missing");

    // Extra: list contents of the usdz
    let usdzListing = null;
    try {
      const l = await run("bash", ["-lc", `unzip -l "${usdzPath}" | sed -n '1,200p'`], jobDir);
      usdzListing = (l.out || "").slice(0, 4000);
    } catch {
      usdzListing = null;
    }

    const listing = fs.existsSync(jobDir) ? fs.readdirSync(jobDir) : null;

    return res.json({
      ok: true,
      debug: info,
      jobDirListing: listing,
      usd: usdcCheck,
      blender: {
        out: (blenderLogs?.out || "").slice(0, 8000),
        err: (blenderLogs?.err || "").slice(0, 8000),
      },
      zip: {
        out: (zipLogs?.out || "").slice(0, 4000),
        err: (zipLogs?.err || "").slice(0, 4000),
      },
      usdzListing,
      usdzUrl: `${PUBLIC_BASE_URL}/usdz/${id}.usdz`,
    });
  } catch (e) {
    console.error("BUILD_USDZ_ERROR:", e);

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
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("USDZ server running on port", PORT));
