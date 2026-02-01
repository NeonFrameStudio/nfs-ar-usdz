import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- CORS (Shopify -> Render) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

// Render public URL (fallback safe)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

// ✅ Render requires binding to THEIR PORT
const PORT = process.env.PORT || 3000;

/* --------------------------------------------------
   ROUTES (avoid Render 404 health weirdness)
-------------------------------------------------- */

app.get("/", (req, res) => {
  res.status(200).send("nfs-ar-usdz ok");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

/* --------------------------------------------------
   BUILD USDZ (PHASE 1 – STUBBED, AR WORKS)
-------------------------------------------------- */

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;

    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({
        ok: false,
        reason: "missing_params",
      });
    }

    // download image (proves your pipeline + CORS + body works)
    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);

    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");

    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(imgPath, buf);

    // ✅ Known-working Apple sample USDZ (use this to confirm iOS Quick Look opens)
    // If Apple ever changes again, swap this URL only.
    return res.json({
      ok: true,
      usdzUrl:
        "https://developer.apple.com/augmented-reality/quick-look/models/hummingbird/hummingbird_anim.usdz",
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

/* --------------------------------------------------
   STATIC (reserved for Phase 2)
-------------------------------------------------- */

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

/* --------------------------------------------------
   START
-------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`USDZ server running on port ${PORT}`);
  console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
});
