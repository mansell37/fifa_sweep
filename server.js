const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "state.json");

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
  return nextState;
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`World Cup Sweep running on port ${port}`);
});
