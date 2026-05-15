const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 50;
const BACKUP_FILE_RE = /^state-\d{8}-\d{6}(?:-\d{3})?\.json$/;

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || "matt.ansell93@gmail.com";
const BACKUP_FROM_EMAIL = process.env.BACKUP_FROM_EMAIL || "WC Sweep <onboarding@resend.dev>";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "fifa2026";
const ENTRY_FIELD_MAX = 80;

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

// --- Email notifications via Resend -------------------------------------
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const GROUP_LABELS = { 1: "Group 1 (×1)", 2: "Group 2 (×1.5)", 3: "Group 3 (×2)", 4: "Group 4 (×4)" };

function entryEmailHtml(entry, state) {
  const a = entry.bonusAnswers || {};
  const picks = (entry.picks || []).map((p, i) =>
    `<tr><td style="padding:4px 8px;background:#f3f4f6;font-weight:600">${escHtml(GROUP_LABELS[i + 1])}</td><td style="padding:4px 8px">${escHtml(p || "—")}</td></tr>`
  ).join("");
  const submitted = new Date(entry.createdAt || Date.now()).toUTCString();
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:600px;color:#111">
    <h2 style="color:#0a1a3a;margin:0 0 12px">New World Cup Sweep entry</h2>
    <p style="margin:0 0 8px"><strong>Entrant:</strong> ${escHtml(entry.entrant)}<br>
       <strong>Team name:</strong> ${escHtml(entry.team)}<br>
       <strong>Submitted (UTC):</strong> ${escHtml(submitted)}</p>
    <h3 style="color:#0a1a3a;margin:16px 0 6px">Picks</h3>
    <table style="border-collapse:collapse;font-size:14px">${picks}</table>
    <h3 style="color:#0a1a3a;margin:16px 0 6px">Bonus answers</h3>
    <p style="margin:0">
      &gt;290 goals (104 matches): <strong>${escHtml(a.goalsOver250 || "—")}</strong><br>
      Penalty shootouts (knockout): <strong>${escHtml(a.penaltyShootouts ?? "—")}</strong><br>
      Red cards (whole tournament): <strong>${escHtml(a.redCards ?? "—")}</strong>
    </p>
    <p style="margin-top:18px;color:#4b5563">Total entries now: <strong>${state.entries.length}</strong></p>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="color:#6b7280;font-size:12px;margin:0">Full state JSON is attached for backup. This is an automated notification from the WC Sweep app.</p>
  </div>`;
}

function entryEmailText(entry, state) {
  const a = entry.bonusAnswers || {};
  const picks = (entry.picks || []).map((p, i) => `  ${GROUP_LABELS[i + 1]}: ${p || "—"}`).join("\n");
  return `New World Cup Sweep entry

Entrant: ${entry.entrant}
Team name: ${entry.team}
Submitted (UTC): ${new Date(entry.createdAt || Date.now()).toUTCString()}

Picks:
${picks}

Bonus answers:
  >290 goals (104 matches): ${a.goalsOver250 || "—"}
  Penalty shootouts (knockout): ${a.penaltyShootouts ?? "—"}
  Red cards (whole tournament): ${a.redCards ?? "—"}

Total entries now: ${state.entries.length}

Full state JSON is attached for backup.`;
}

async function sendEntryEmail(entry, state) {
  if (!RESEND_API_KEY) return { skipped: "no API key" };
  const stateJson = JSON.stringify(state, null, 2);
  const attachmentName = `wc-sweep-state-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const recipients = BACKUP_EMAIL.split(",").map((s) => s.trim()).filter(Boolean);
  const payload = {
    from: BACKUP_FROM_EMAIL,
    to: recipients,
    subject: `New WC Sweep Entry: ${entry.team} · ${entry.entrant} (#${state.entries.length})`,
    html: entryEmailHtml(entry, state),
    text: entryEmailText(entry, state),
    attachments: [{ filename: attachmentName, content: Buffer.from(stateJson).toString("base64") }],
  };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Resend HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  return { sent: true };
}

async function notifyNewEntries(prevState, nextState) {
  if (!RESEND_API_KEY) return;
  const prevIds = new Set((prevState.entries || []).map((e) => e.id));
  const newEntries = (nextState.entries || []).filter((e) => e && e.id && !prevIds.has(e.id));
  if (newEntries.length === 0) return;
  for (const entry of newEntries) {
    try {
      const result = await sendEntryEmail(entry, nextState);
      if (result.sent) console.log(`Emailed new-entry notification for ${entry.id}`);
    } catch (err) {
      console.warn(`Email notify failed for ${entry.id}:`, err.message);
    }
  }
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function requireAdminToken(req, res, next) {
  const token = req.get("X-Admin-Token") || "";
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "Admin token required" });
}

function genEntryId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "e_" + crypto.randomBytes(6).toString("hex");
}

function validateEntryPayload(payload, currentTiers) {
  if (!payload || typeof payload !== "object") return "Body must be an object";
  const entrant = String(payload.entrant || "").trim();
  const team = String(payload.team || "").trim();
  if (!entrant) return "entrant required";
  if (!team) return "team required";
  if (entrant.length > ENTRY_FIELD_MAX || team.length > ENTRY_FIELD_MAX) return "entrant/team too long";
  if (!Array.isArray(payload.picks) || payload.picks.length !== 4) return "picks must be an array of 4 teams";
  const picks = payload.picks.map((p) => String(p || "").trim());
  for (let i = 0; i < 4; i++) {
    const roster = currentTiers[i + 1] || currentTiers[String(i + 1)] || [];
    if (!picks[i]) return `Group ${i + 1} pick required`;
    if (!roster.includes(picks[i])) return `Pick "${picks[i]}" is not in Group ${i + 1}`;
  }
  const ba = payload.bonusAnswers || {};
  const goals = String(ba.goalsOver250 || "").trim();
  const shootouts = String(ba.penaltyShootouts ?? "").trim();
  const reds = String(ba.redCards ?? "").trim();
  if (goals !== "Y" && goals !== "N") return "bonusAnswers.goalsOver250 must be Y or N";
  if (!/^\d{1,3}$/.test(shootouts)) return "bonusAnswers.penaltyShootouts must be a number";
  if (!/^\d{1,3}$/.test(reds)) return "bonusAnswers.redCards must be a number";
  return { entrant, team, picks, bonusAnswers: { goalsOver250: goals, penaltyShootouts: shootouts, redCards: reds } };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/admin/verify", (req, res) => {
  const token = req.get("X-Admin-Token") || "";
  if (token === ADMIN_TOKEN) return res.json({ ok: true });
  return res.status(401).json({ ok: false });
});

app.post("/api/entries", async (req, res) => {
  try {
    const { updated, previous, entry } = await enqueueWrite(async () => {
      const current = await readState();
      const validated = validateEntryPayload(req.body || {}, current.tiers);
      if (typeof validated === "string") {
        const err = new Error(validated);
        err.status = 400;
        throw err;
      }
      const newEntry = { ...validated, id: genEntryId(), createdAt: Date.now() };
      const merged = { ...current, entries: [...current.entries, newEntry] };
      const next = await writeState(merged);
      return { updated: next, previous: current, entry: newEntry };
    });
    notifyNewEntries(previous, updated).catch((e) => console.warn("notifyNewEntries crashed:", e.message));
    return res.status(201).json({ ok: true, entry, totalEntries: updated.entries.length });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ error: error.message || "Failed to save entry" });
  }
});

app.get("/api/state", async (_req, res) => {
  try {
    const state = await readState();
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: "Failed to read state", detail: String(error) });
  }
});

app.put("/api/state", requireAdminToken, async (req, res) => {
  const payload = req.body || {};
  const allowedKeys = ["tiers", "entries", "results", "bonus", "settings"];
  const hasAny = allowedKeys.some((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (!hasAny) {
    return res.status(400).json({ error: "Provide at least one of tiers, entries, results, bonus, settings." });
  }

  try {
    const { updated, previous } = await enqueueWrite(async () => {
      const current = await readState();
      const merged = {
        tiers: Object.prototype.hasOwnProperty.call(payload, "tiers") ? payload.tiers : current.tiers,
        entries: Object.prototype.hasOwnProperty.call(payload, "entries") ? payload.entries : current.entries,
        results: Object.prototype.hasOwnProperty.call(payload, "results") ? payload.results : current.results,
        bonus: Object.prototype.hasOwnProperty.call(payload, "bonus") ? payload.bonus : current.bonus,
        settings: Object.prototype.hasOwnProperty.call(payload, "settings") ? payload.settings : current.settings,
      };
      const next = await writeState(merged);
      return { updated: next, previous: current };
    });
    // Fire-and-forget: don't block the response on email delivery.
    notifyNewEntries(previous, updated).catch((e) => console.warn("notifyNewEntries crashed:", e.message));
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Failed to persist state", detail: String(error) });
  }
});

app.get("/api/backups", requireAdminToken, async (_req, res) => {
  try {
    return res.json(await listBackups());
  } catch (error) {
    return res.status(500).json({ error: "Failed to list backups", detail: String(error) });
  }
});

app.get("/api/backups/:filename", requireAdminToken, async (req, res) => {
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

app.post("/api/backups/restore/:filename", requireAdminToken, async (req, res) => {
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
  if (RESEND_API_KEY) {
    console.log(`Email notifications: enabled (to=${BACKUP_EMAIL}, from=${BACKUP_FROM_EMAIL})`);
  } else {
    console.log("Email notifications: disabled (set RESEND_API_KEY env var to enable)");
  }
  console.log(`Admin token: ${process.env.ADMIN_TOKEN ? "set via env var" : "using fallback default (set ADMIN_TOKEN env var for production)"}`);
});
