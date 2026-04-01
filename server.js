require("dotenv").config();

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs-extra");
const crypto = require("crypto");
const path = require("path");
const FormData = require("form-data");

const app = express();
const upload = multer({ dest: "uploads/" });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const CHUNK_SIZE = 7 * 1024 * 1024;
const DB_FILE = "db.json";

fs.ensureFileSync(DB_FILE);
let db = fs.readJsonSync(DB_FILE);

// =====================
// utils
// =====================
function generateId() {
  return Date.now() + "_" + crypto.randomBytes(4).toString("hex");
}

function saveDB() {
  fs.writeJsonSync(DB_FILE, db, { spaces: 2 });
}

// =====================
// upload chunk to discord
// =====================
async function uploadChunk(buffer, filename) {
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
    }
  );

  return res.data.attachments[0].url;
}

// =====================
// upload route
// =====================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const fileBuffer = await fs.readFile(req.file.path);

    const fileId = generateId();
    const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

    const chunks = [];

    const checksum = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = start + CHUNK_SIZE;

      const chunk = fileBuffer.slice(start, end);
      const index = i + 1;

      const name = `${fileId}_part_${String(index).padStart(3, "0")}`;

      const url = await uploadChunk(chunk, name);

      chunks.push({ index, url });

      console.log(`Uploaded ${index}/${totalChunks}`);
    }

    db[fileId] = {
      name: req.file.originalname,
      size: fileBuffer.length,
      totalChunks,
      checksum,
      chunks,
    };

    saveDB();
    await fs.remove(req.file.path);

    res.json({ fileId });
  } catch (e) {
    console.error(e);
    res.status(500).send("Upload failed");
  }
});

// =====================
// download route (SAFE STREAM)
// =====================
app.get("/download/:id", async (req, res) => {
  try {
    const file = db[req.params.id];
    if (!file) return res.status(404).send("Not found");

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.name}"`
    );
    res.setHeader("Content-Type", "application/octet-stream");

    const hash = crypto.createHash("sha256");

    const sorted = file.chunks.sort((a, b) => a.index - b.index);

    for (const chunk of sorted) {
      let data;

      for (let i = 0; i < 3; i++) {
        try {
          const r = await axios.get(chunk.url, {
            responseType: "arraybuffer",
          });
          data = r.data;
          break;
        } catch {
          if (i === 2) throw new Error("Chunk failed");
        }
      }

      hash.update(data);
      res.write(data);
    }

    res.end();

    const finalHash = hash.digest("hex");
    if (finalHash !== file.checksum) {
      console.log("⚠️ checksum mismatch");
    }
  } catch (e) {
    console.error(e);
    res.status(500).send("Download failed");
  }
});

// =====================
// list files
// =====================
app.get("/files", (req, res) => {
  const list = Object.entries(db).map(([id, f]) => ({
    id,
    name: f.name,
  }));
  res.json(list);
});

app.listen(3000, () => {
  console.log("Server running on 3000");
});
