import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- CORS (required for Shopify storefront -> Render) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

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

/* --------------------------------------------------
   BUILD USDZ (PHASE 1 – STUBBED, AR WORKS)
-------------------------------------------------- */

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;

    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({
        ok: false,
        reason: "missing_params"
      });
    }

    // --------------------------------------------------
    // STEP 1: Download image (prove pipeline works)
    // --------------------------------------------------
    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);

    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");

    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(imgPath, buf);

    // --------------------------------------------------
    // STEP 2: TEMP USDZ (Apple demo model)
    // --------------------------------------------------
    // This proves:
    // - Button works
    // - iOS AR Quick Look opens
    // - Safari does NOT auto-close
    //
    // We will replace this with real Blender output later.
    // --------------------------------------------------

    return res.json({
      ok: true,
      usdzUrl:
        "https://developer.apple.com/augmented-reality/quick-look/models/retrotv/retrotv.usdz"
    });

  } catch (e) {
    console.error("BUILD_USDZ_ERROR:", e);
    return res.status(500).json({
      ok: false,
      reason: "server_error",
      message: String(e?.message || e)
    });
  }
});

/* --------------------------------------------------
   STATIC (reserved for Phase 2)
-------------------------------------------------- */

app.use("/usdz", express.static(WORK_DIR));

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */

app.listen(3000, () => {
  console.log("USDZ server running on port 3000");
});
