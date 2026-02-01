import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

app.post("/build-usdz", async (req, res) => {
  try {
    const { imageUrl, widthCm, heightCm } = req.body;

    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = crypto.randomUUID();
    const imgPath = path.join(WORK_DIR, `${id}.png`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);

    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(imgPath, buf);

    execSync(
      `blender -b -P generate-usdz.py -- "${imgPath}" "${usdzPath}" ${widthCm} ${heightCm}`,
      { stdio: "inherit" }
    );

    res.json({
      ok: true,
      usdzUrl: `${process.env.PUBLIC_BASE_URL}/usdz/${id}.usdz`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, reason: "server_error" });
  }
});

app.use("/usdz", express.static(WORK_DIR));
app.listen(3000, () => console.log("USDZ server running"));
