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
const DIGEST_EMAIL = process.env.DIGEST_EMAIL || BACKUP_EMAIL;
const DIGEST_HOUR_UTC = (() => {
  const h = parseInt(process.env.DIGEST_HOUR_UTC ?? "21", 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 21;
})();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "fifa2026";
const ENTRY_FIELD_MAX = 80;

const TIER_KEYS = [1, 2, 3, 4, 5];
const PICK_COUNT = 5;

// 48-team roster — must match DEFAULT_TIERS in js/app.js.
// Order within each group is intentionally randomised (not odds-order)
// so the favourite isn't visually first and picks spread more evenly.
const DEFAULT_TIERS = {
  1: ["Germany", "France", "Argentina", "England", "Brazil", "Portugal", "Spain"],
  2: ["Belgium", "Norway", "USA", "Netherlands", "Morocco", "Japan", "Colombia"],
  3: ["Switzerland", "Senegal", "Turkey", "Mexico", "Ecuador", "Croatia", "Austria",
      "Uruguay", "Sweden"],
  4: ["Canada", "Algeria", "Paraguay", "Czechia", "Australia", "Bosnia", "South Korea",
      "Egypt", "Ivory Coast", "Iran", "Ghana", "Scotland"],
  5: ["DR Congo", "Panama", "Uzbekistan", "Jordan", "South Africa", "Qatar",
      "New Zealand", "Haiti", "Cape Verde", "Tunisia", "Saudi Arabia", "Iraq", "Curacao"],
};

const DEFAULT_STATE = {
  tiers: JSON.parse(JSON.stringify(DEFAULT_TIERS)),
  entries: [],
  results: {},
  bonus: { goalsOver250: "", winnerEuropean: "", australiaThroughGroup: "" },
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
  const shapedTiers = {};
  for (const t of TIER_KEYS) {
    const raw = tiers[String(t)] ?? tiers[t];
    shapedTiers[t] = Array.isArray(raw) ? [...raw] : [];
  }
  return {
    tiers: shapedTiers,
    entries,
    results,
    bonus: {
      goalsOver250: bonus.goalsOver250 ?? "",
      winnerEuropean: bonus.winnerEuropean ?? "",
      australiaThroughGroup: bonus.australiaThroughGroup ?? "",
    },
    settings,
  };
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = safeStateShape(JSON.parse(raw));
    const tiersTotal = TIER_KEYS.reduce((s, t) => s + (parsed.tiers[t]?.length || 0), 0);
    if (parsed.entries.length > 0 || tiersTotal > 0) {
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

const GROUP_LABELS = { 1: "Group 1 (×1)", 2: "Group 2 (×1.5)", 3: "Group 3 (×2)", 4: "Group 4 (×4)", 5: "Group 5 (×6)" };

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
      300+ goals (104 matches): <strong>${escHtml(a.goalsOver250 || "—")}</strong><br>
      Tournament winner European: <strong>${escHtml(a.winnerEuropean || "—")}</strong><br>
      Australia through group stage: <strong>${escHtml(a.australiaThroughGroup || "—")}</strong>
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
  300+ goals (104 matches): ${a.goalsOver250 || "—"}
  Tournament winner European: ${a.winnerEuropean || "—"}
  Australia through group stage: ${a.australiaThroughGroup || "—"}

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

// --- Daily digest -------------------------------------------------------

function digestEmailHtml(state, dateLabel) {
  const entries = [...(state.entries || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const rows = entries.map((e, i) => {
    const ba = e.bonusAnswers || {};
    const submitted = new Date(e.createdAt || 0).toISOString().slice(0, 10);
    const picks = (e.picks || []).map((p) => escHtml(p || "—")).join(" / ");
    const bonus = [ba.goalsOver250, ba.winnerEuropean, ba.australiaThroughGroup]
      .map((v) => escHtml(v || "—")).join(" / ");
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${i + 1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb"><strong>${escHtml(e.entrant)}</strong></td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escHtml(e.team)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px">${picks}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px">${bonus}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280">${submitted}</td>
    </tr>`;
  }).join("");
  const body = entries.length
    ? `<table style="border-collapse:collapse;font-size:14px;width:100%">
        <thead><tr style="background:#0a1a3a;color:#fff;text-align:left">
          <th style="padding:6px 8px">#</th>
          <th style="padding:6px 8px">Entrant</th>
          <th style="padding:6px 8px">Team name</th>
          <th style="padding:6px 8px">Picks (G1 / G2 / G3 / G4 / G5)</th>
          <th style="padding:6px 8px">Bonus (300+ / Euro / Aus)</th>
          <th style="padding:6px 8px">Submitted</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p style="color:#6b7280">No entries submitted yet.</p>`;
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:900px;color:#111">
    <h2 style="color:#0a1a3a;margin:0 0 8px">WC Sweep — Daily Roster (${escHtml(dateLabel)})</h2>
    <p style="margin:0 0 12px">Total entries: <strong>${entries.length}</strong></p>
    ${body}
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="color:#6b7280;font-size:12px;margin:0">Full state JSON is attached for backup. Automated daily digest from the WC Sweep app.</p>
  </div>`;
}

function digestEmailText(state, dateLabel) {
  const entries = [...(state.entries || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (entries.length === 0) {
    return `WC Sweep — Daily Roster (${dateLabel})\n\nNo entries submitted yet.`;
  }
  const lines = entries.map((e, i) => {
    const ba = e.bonusAnswers || {};
    const picks = (e.picks || []).map((p) => p || "—").join(" / ");
    const bonus = [ba.goalsOver250 || "—", ba.winnerEuropean || "—", ba.australiaThroughGroup || "—"].join(" / ");
    const submitted = new Date(e.createdAt || 0).toISOString().slice(0, 10);
    return `${i + 1}. ${e.entrant} — "${e.team}"\n   Picks: ${picks}\n   Bonus (300+/Euro/Aus): ${bonus}\n   Submitted: ${submitted}`;
  }).join("\n\n");
  return `WC Sweep — Daily Roster (${dateLabel})\nTotal entries: ${entries.length}\n\n${lines}\n\nFull state JSON attached for backup.`;
}

async function sendDailyDigest(state) {
  if (!RESEND_API_KEY) return { skipped: "no API key" };
  const dateLabel = new Date().toISOString().slice(0, 10);
  const stateJson = JSON.stringify(state, null, 2);
  const attachmentName = `wc-sweep-state-${dateLabel}.json`;
  const recipients = DIGEST_EMAIL.split(",").map((s) => s.trim()).filter(Boolean);
  const payload = {
    from: BACKUP_FROM_EMAIL,
    to: recipients,
    subject: `WC Sweep Daily Roster — ${dateLabel} (${state.entries.length} entries)`,
    html: digestEmailHtml(state, dateLabel),
    text: digestEmailText(state, dateLabel),
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

let lastDigestDate = "";  // YYYY-MM-DD (UTC) of last successful send
async function maybeSendDailyDigest() {
  if (!RESEND_API_KEY) return;
  const now = new Date();
  if (now.getUTCHours() !== DIGEST_HOUR_UTC) return;
  const today = now.toISOString().slice(0, 10);
  if (lastDigestDate === today) return;
  try {
    const state = await readState();
    await sendDailyDigest(state);
    lastDigestDate = today;
    console.log(`Daily digest sent for ${today} (${state.entries.length} entries)`);
  } catch (err) {
    console.warn(`Daily digest failed for ${today}:`, err.message);
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
  if (!Array.isArray(payload.picks) || payload.picks.length !== PICK_COUNT) return `picks must be an array of ${PICK_COUNT} teams`;
  const picks = payload.picks.map((p) => String(p || "").trim());
  for (let i = 0; i < PICK_COUNT; i++) {
    const roster = currentTiers[i + 1] || currentTiers[String(i + 1)] || [];
    if (!picks[i]) return `Group ${i + 1} pick required`;
    if (!roster.includes(picks[i])) return `Pick "${picks[i]}" is not in Group ${i + 1}`;
  }
  const ba = payload.bonusAnswers || {};
  const goals = String(ba.goalsOver250 || "").trim();
  const european = String(ba.winnerEuropean || "").trim();
  const australia = String(ba.australiaThroughGroup || "").trim();
  if (goals !== "Y" && goals !== "N") return "bonusAnswers.goalsOver250 must be Y or N";
  if (european !== "Y" && european !== "N") return "bonusAnswers.winnerEuropean must be Y or N";
  if (australia !== "Y" && australia !== "N") return "bonusAnswers.australiaThroughGroup must be Y or N";
  return { entrant, team, picks, bonusAnswers: { goalsOver250: goals, winnerEuropean: european, australiaThroughGroup: australia } };
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
    console.log(`Daily digest: ${DIGEST_HOUR_UTC.toString().padStart(2, "0")}:00 UTC to ${DIGEST_EMAIL}`);
    setInterval(maybeSendDailyDigest, 5 * 60 * 1000);
    maybeSendDailyDigest();
  } else {
    console.log("Email notifications: disabled (set RESEND_API_KEY env var to enable)");
  }
  console.log(`Admin token: ${process.env.ADMIN_TOKEN ? "set via env var" : "using fallback default (set ADMIN_TOKEN env var for production)"}`);
});
