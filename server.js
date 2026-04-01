require("dotenv").config();
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs-extra");
const crypto = require("crypto");
const path = require("path");
const FormData = require("form-data");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// =====================
// CORS
// =====================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "x-api-key, Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const API_KEY = process.env.API_KEY; // optional auth

const CHUNK_SIZE = 7 * 1024 * 1024;
const DB_FILE = "db.json";

// =====================
// DB setup
// =====================
fs.ensureFileSync(DB_FILE);
let db = {};
try {
  db = fs.readJsonSync(DB_FILE);
} catch {
  db = {};
}

let dbWriteTimer = null;
function saveDB() {
  // Debounced write to avoid concurrent clobber
  if (dbWriteTimer) clearTimeout(dbWriteTimer);
  dbWriteTimer = setTimeout(() => {
    fs.writeJsonSync(DB_FILE, db, { spaces: 2 });
  }, 100);
}

// =====================
// Auth middleware (optional but recommended)
// =====================
function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // skip if not configured
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// =====================
// Utils
// =====================
function generateId() {
  return Date.now() + "_" + crypto.randomBytes(4).toString("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================
// Upload chunk to Discord
// =====================
async function uploadChunk(buffer, filename, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const form = new FormData();
      form.append("file", buffer, filename);
      const res = await axios.post(
        `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
        form,
        {
          headers: {
            Authorization: `Bot ${DISCORD_TOKEN}`,
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
        }
      );
      // Store message ID, NOT the CDN url (urls expire)
      const attachment = res.data.attachments[0];
      return {
        messageId: res.data.id,
        filename: attachment.filename,
      };
    } catch (err) {
      const status = err?.response?.status;
      // Rate limited
      if (status === 429) {
        const retryAfter = (err.response.data?.retry_after ?? 1) * 1000;
        console.log(`Rate limited, waiting ${retryAfter}ms...`);
        await sleep(retryAfter);
      } else if (i === retries - 1) {
        throw new Error(`Chunk upload failed: ${status} ${err.message}`);
      } else {
        await sleep(500 * (i + 1)); // backoff
      }
    }
  }
}

// =====================
// Fetch fresh URL from Discord for a message
// =====================
async function getFreshChunkUrl(messageId) {
  const res = await axios.get(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${messageId}`,
    {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    }
  );
  return res.data.attachments[0].url;
}

// =====================
// Upload route
// =====================
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const fileBuffer = req.file.buffer; // memoryStorage gives us buffer directly
    const fileSize = fileBuffer.length;
    const fileId = generateId();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const chunks = [];
    const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = fileBuffer.slice(start, start + CHUNK_SIZE);

      const index = i + 1;
      const name = `${fileId}_part_${String(index).padStart(3, "0")}`;
      const chunkMeta = await uploadChunk(chunk, name);

      chunks.push({ index, ...chunkMeta });
      console.log(`Uploaded chunk ${index}/${totalChunks}`);

      if (i < totalChunks - 1) await sleep(300);
    }

    db[fileId] = {
      name: req.file.originalname,
      size: fileSize,
      totalChunks,
      checksum: fileHash,
      chunks,
      uploadedAt: new Date().toISOString(),
    };
    saveDB();

    res.json({ fileId, name: req.file.originalname, size: fileSize });
  } catch (e) {
    console.error("Upload error:", e.message);
    res.status(500).json({ error: "Upload failed", detail: e.message });
  }
});

// =====================
// Download route
// =====================
app.get("/download/:id", authMiddleware, async (req, res) => {
  try {
    const file = db[req.params.id];
    if (!file) return res.status(404).json({ error: "File not found" });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.name)}"`
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", file.size);

    const hash = crypto.createHash("sha256");
    const sorted = [...file.chunks].sort((a, b) => a.index - b.index);

    for (const chunk of sorted) {
      // Always fetch a fresh (non-expired) URL from Discord
      let freshUrl;
      try {
        freshUrl = await getFreshChunkUrl(chunk.messageId);
      } catch (e) {
        throw new Error(`Failed to get fresh URL for chunk ${chunk.index}: ${e.message}`);
      }

      let data;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await axios.get(freshUrl, { responseType: "arraybuffer" });
          data = r.data;
          break;
        } catch {
          if (i === 2) throw new Error(`Failed to download chunk ${chunk.index} after 3 retries`);
          await sleep(500 * (i + 1));
        }
      }

      hash.update(data);

      // Write chunk and wait for drain to avoid memory buildup
      const ok = res.write(Buffer.from(data));
      if (!ok) await new Promise((r) => res.once("drain", r));
    }

    const finalHash = hash.digest("hex");
    if (finalHash !== file.checksum) {
      // Can't change status at this point, but log it clearly
      console.error(`⚠️ Checksum mismatch for file ${req.params.id}!`);
    }

    res.end();
  } catch (e) {
    console.error("Download error:", e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed", detail: e.message });
    } else {
      res.destroy();
    }
  }
});

// =====================
// Delete file
// =====================
app.delete("/files/:id", authMiddleware, async (req, res) => {
  const file = db[req.params.id];
  if (!file) return res.status(404).json({ error: "Not found" });

  // Delete messages from Discord
  const errors = [];
  for (const chunk of file.chunks) {
    try {
      await axios.delete(
        `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${chunk.messageId}`,
        { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
      );
      await sleep(300);
    } catch (e) {
      errors.push(`chunk ${chunk.index}: ${e.message}`);
    }
  }

  delete db[req.params.id];
  saveDB();

  res.json({ deleted: true, errors: errors.length ? errors : undefined });
});

// =====================
// List files
// =====================
app.get("/files", authMiddleware, (req, res) => {
  const list = Object.entries(db).map(([id, f]) => ({
    id,
    name: f.name,
    size: f.size,
    uploadedAt: f.uploadedAt,
  }));
  res.json(list);
});

// =====================
// Health check (no auth, for Railway)
// =====================
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// Serve frontend
// =====================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!DISCORD_TOKEN) console.warn("⚠️  DISCORD_TOKEN not set");
  if (!CHANNEL_ID) console.warn("⚠️  CHANNEL_ID not set");
  if (!API_KEY) console.warn("⚠️  API_KEY not set — server is open to anyone");
});
