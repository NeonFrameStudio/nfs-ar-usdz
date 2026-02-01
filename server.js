import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WORK_DIR = "/tmp/ar";
fs.mkdirSync(WORK_DIR, { recursive: true });

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://nfs-ar-usdz.onrender.com";

function run(cmd, args, logPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => {
      try {
        fs.appendFileSync(logPath, `\n[spawn error] ${String(e)}\n`);
      } catch {}
      reject(e);
    });

    p.on("close", (code) => {
      try {
        fs.appendFileSync(
          logPath,
          `\n[cmd] ${cmd} ${args.join(" ")}\n[exit] ${code}\n[stdout]\n${out}\n[stderr]\n${err}\n`
        );
      } catch {}

      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

app.post("/build-usdz", async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    const { imageUrl, widthCm, heightCm } = req.body;
    if (!imageUrl || !widthCm || !heightCm) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }

    const id = requestId;
    const imgPath = path.join(WORK_DIR, `${id}.png`);
    const glbPath = path.join(WORK_DIR, `${id}.glb`);
    const usdzPath = path.join(WORK_DIR, `${id}.usdz`);
    const logPath = path.join(WORK_DIR, `${id}.log`);

    fs.writeFileSync(logPath, `[request] ${new Date().toISOString()}\n`);

    // download image
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error("image_download_failed");
    fs.writeFileSync(imgPath, Buffer.from(await r.arrayBuffer()));

    // 1) Blender -> GLB
    await run(
      "blender",
      ["-b", "-P", "/app/make_glb.py", "--", imgPath, glbPath, String(widthCm), String(heightCm)],
      logPath
    );

    if (!fs.existsSync(glbPath)) throw new Error("glb_not_created");

    // 2) GLB -> USDZ
    await run("usdzconvert", [glbPath, usdzPath], logPath);

    if (!fs.existsSync(usdzPath)) throw new Error("usdz_not_created");

    return res.json({
      ok: true,
      usdzUrl: `${PUBLIC_BASE_URL}/usdz/${id}.usdz`,
      requestId: id
    });
  } catch (e) {
    console.error("BUILD_USDZ_ERROR:", e);
    return res.status(500).json({
      ok: false,
      reason: "server_error",
      message: String(e?.message || e),
      requestId
    });
  }
});

app.use(
  "/usdz",
  express.static(WORK_DIR, {
    setHeaders(res, p) {
      if (p.endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
        res.setHeader("Content-Disposition", `inline; filename="preview.usdz"`);
      }
      if (p.endsWith(".log")) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    },
  })
);

app.listen(3000, () => console.log("USDZ server running on port 3000"));
