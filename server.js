const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 50;
const BACKUP_FILE_RE = /^state-\d{8}-\d{6}(?:-\d{3})?\.json$/;

const DEFAULT_STATE = {
  tiers: { 1: [], 2: [], 3: [], 4: [] },
  entries: [],
  results: {},
  bonus: { goalsOver250: "", penaltyShootouts: "", redCards: "" },
  settings: {},
};

let writeQueue = Promise.resolve();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));

function safeStateShape(state) {
  if (!state || typeof state !== "object") return JSON.parse(JSON.stringify(DEFAULT_STATE));
  const tiers = state.tiers && typeof state.tiers === "object" ? state.tiers : DEFAULT_STATE.tiers;
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const results = state.results && typeof state.results === "object" ? state.results : {};
  const bonus = state.bonus && typeof state.bonus === "object" ? state.bonus : { ...DEFAULT_STATE.bonus };
  const settings = state.settings && typeof state.settings === "object" ? state.settings : {};
  return {
    tiers: {
      1: Array.isArray(tiers["1"] ?? tiers[1]) ? [...(tiers["1"] ?? tiers[1])] : [],
      2: Array.isArray(tiers["2"] ?? tiers[2]) ? [...(tiers["2"] ?? tiers[2])] : [],
      3: Array.isArray(tiers["3"] ?? tiers[3]) ? [...(tiers["3"] ?? tiers[3])] : [],
      4: Array.isArray(tiers["4"] ?? tiers[4]) ? [...(tiers["4"] ?? tiers[4])] : [],
    },
    entries,
    results,
    bonus: {
      goalsOver250: bonus.goalsOver250 ?? "",
      penaltyShootouts: bonus.penaltyShootouts ?? "",
      redCards: bonus.redCards ?? "",
    },
    settings,
  };
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = safeStateShape(JSON.parse(raw));
    if (parsed.entries.length > 0 || (parsed.tiers[1].length + parsed.tiers[2].length + parsed.tiers[3].length + parsed.tiers[4].length) > 0) {
      return parsed;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  if (process.env.DATA_SEED) {
    try {
      const seeded = safeStateShape(JSON.parse(process.env.DATA_SEED));
      await writeState(seeded);
      console.log(`Seeded state from DATA_SEED env var (${seeded.entries.length} entries)`);
      return seeded;
    } catch (e) {
      console.warn("DATA_SEED parse failed:", e.message);
    }
  }

  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

async function writeState(state) {
  const nextState = safeStateShape(state);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(nextState), "utf8");
  // Best-effort timestamped snapshot. Doesn't block or fail the write.
  writeBackupSnapshot(nextState).catch((e) => console.warn("Snapshot failed:", e.message));
  return nextState;
}

function snapshotFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `state-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${ms}.json`;
}

async function writeBackupSnapshot(state) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const filename = snapshotFilename();
  await fs.writeFile(path.join(BACKUP_DIR, filename), JSON.stringify(state), "utf8");
  await pruneOldBackups();
}

async function pruneOldBackups() {
  try {
    const files = (await fs.readdir(BACKUP_DIR))
      .filter((f) => BACKUP_FILE_RE.test(f))
      .sort();
    if (files.length <= BACKUP_KEEP) return;
    const excess = files.slice(0, files.length - BACKUP_KEEP);
    await Promise.all(excess.map((f) => fs.unlink(path.join(BACKUP_DIR, f)).catch(() => {})));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("Backup prune failed:", e.message);
  }
}

async function listBackups() {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((f) => BACKUP_FILE_RE.test(f));
    const enriched = await Promise.all(
      files.map(async (f) => {
        try {
          const filePath = path.join(BACKUP_DIR, f);
          const stat = await fs.stat(filePath);
          let entryCount = null;
          try {
            const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
            entryCount = Array.isArray(parsed?.entries) ? parsed.entries.length : null;
          } catch (_) {}
          return { filename: f, mtime: stat.mtime.toISOString(), size: stat.size, entries: entryCount };
        } catch (_) {
          return null;
        }
      })
    );
    return enriched.filter(Boolean).sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

function isSafeBackupName(name) {
  return typeof name === "string" && BACKUP_FILE_RE.test(name);
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/state", async (_req, res) => {
  try {
    const state = await readState();
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: "Failed to read state", detail: String(error) });
  }
});

app.put("/api/state", async (req, res) => {
  const payload = req.body || {};
  const allowedKeys = ["tiers", "entries", "results", "bonus", "settings"];
  const hasAny = allowedKeys.some((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (!hasAny) {
    return res.status(400).json({ error: "Provide at least one of tiers, entries, results, bonus, settings." });
  }

  try {
    const updated = await enqueueWrite(async () => {
      const current = await readState();
      const merged = {
        tiers: Object.prototype.hasOwnProperty.call(payload, "tiers") ? payload.tiers : current.tiers,
        entries: Object.prototype.hasOwnProperty.call(payload, "entries") ? payload.entries : current.entries,
        results: Object.prototype.hasOwnProperty.call(payload, "results") ? payload.results : current.results,
        bonus: Object.prototype.hasOwnProperty.call(payload, "bonus") ? payload.bonus : current.bonus,
        settings: Object.prototype.hasOwnProperty.call(payload, "settings") ? payload.settings : current.settings,
      };
      return writeState(merged);
    });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Failed to persist state", detail: String(error) });
  }
});

app.get("/api/backups", async (_req, res) => {
  try {
    return res.json(await listBackups());
  } catch (error) {
    return res.status(500).json({ error: "Failed to list backups", detail: String(error) });
  }
});

app.get("/api/backups/:filename", async (req, res) => {
  if (!isSafeBackupName(req.params.filename)) {
    return res.status(400).json({ error: "Invalid backup filename" });
  }
  try {
    const filePath = path.join(BACKUP_DIR, req.params.filename);
    const raw = await fs.readFile(filePath, "utf8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`);
    return res.send(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return res.status(404).json({ error: "Backup not found" });
    }
    return res.status(500).json({ error: "Failed to read backup", detail: String(error) });
  }
});

app.post("/api/backups/restore/:filename", async (req, res) => {
  if (!isSafeBackupName(req.params.filename)) {
    return res.status(400).json({ error: "Invalid backup filename" });
  }
  try {
    const filePath = path.join(BACKUP_DIR, req.params.filename);
    const raw = await fs.readFile(filePath, "utf8");
    const snapshot = safeStateShape(JSON.parse(raw));
    const restored = await enqueueWrite(async () => writeState(snapshot));
    return res.json({ ok: true, restored });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return res.status(404).json({ error: "Backup not found" });
    }
    return res.status(500).json({ error: "Failed to restore backup", detail: String(error) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`World Cup Sweep running on port ${port}`);
});
