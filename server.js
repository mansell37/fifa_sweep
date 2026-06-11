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
  matches: [],   // [{ id, espnId, stage, group, kickoffUTC, venue, home, away, scoreHome, scoreAway, status, manuallyOverridden }]
  settings: {},
};

// ESPN hidden scoreboard API — no auth, returns WC2026 fixtures + scores.
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const TOURNAMENT_START = "20260611";
const TOURNAMENT_END   = "20260719";
const POLL_INTERVAL_MS = 30 * 60 * 1000;   // 30 min
const POLL_QUIET_WINDOW_HRS = 8;           // skip if no scheduled match within ±8h


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
  const matches = Array.isArray(state.matches) ? state.matches : [];
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
    matches: matches.map(shapeMatch).filter(Boolean),
    settings,
  };
}

function shapeMatch(m) {
  if (!m || typeof m !== "object") return null;
  const home = String(m.home || "").trim();
  const away = String(m.away || "").trim();
  if (!home || !away) return null;
  const status = ["scheduled", "live", "finished"].includes(m.status) ? m.status : "scheduled";
  const sh = m.scoreHome === null || m.scoreHome === undefined || m.scoreHome === "" ? null : Number(m.scoreHome);
  const sa = m.scoreAway === null || m.scoreAway === undefined || m.scoreAway === "" ? null : Number(m.scoreAway);
  return {
    id: String(m.id || m.espnId || `${home}-${away}-${m.kickoffUTC || ""}`),
    espnId: m.espnId ? String(m.espnId) : null,
    stage: m.stage || "group",
    group: m.group || null,
    kickoffUTC: m.kickoffUTC || null,
    venue: m.venue || "",
    home, away,
    scoreHome: Number.isFinite(sh) ? sh : null,
    scoreAway: Number.isFinite(sa) ? sa : null,
    status,
    manuallyOverridden: !!m.manuallyOverridden,
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
      Tournament winner from continental Europe: <strong>${escHtml(a.winnerEuropean || "—")}</strong><br>
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
  Tournament winner from continental Europe: ${a.winnerEuropean || "—"}
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
          <th style="padding:6px 8px">Bonus (300+ / Continental Euro / Aus)</th>
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
    return `${i + 1}. ${e.entrant} — "${e.team}"\n   Picks: ${picks}\n   Bonus (300+/Continental Euro/Aus): ${bonus}\n   Submitted: ${submitted}`;
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

// --- ESPN match poller ---------------------------------------------------

function espnStageFromType(slug) {
  if (!slug) return "group";
  const s = String(slug).toLowerCase();
  if (s.includes("final") && !s.includes("semi") && !s.includes("quarter")) return s.includes("third") || s.includes("3rd") ? "3rd" : "final";
  if (s.includes("semi")) return "sf";
  if (s.includes("quarter")) return "qf";
  if (s.includes("round-of-16") || s.includes("r16") || s.includes("round of 16")) return "r16";
  if (s.includes("round-of-32") || s.includes("r32") || s.includes("round of 32")) return "r32";
  return "group";
}

function mapEspnEvent(ev) {
  try {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const competitors = comp.competitors || [];
    if (competitors.length < 2) return null;
    const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
    const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
    const statusName = ev.status && ev.status.type && ev.status.type.name ? String(ev.status.type.name) : "";
    let status = "scheduled";
    if (statusName === "STATUS_FINAL" || statusName === "STATUS_FULL_TIME") status = "finished";
    else if (statusName.startsWith("STATUS_") && !statusName.includes("SCHEDULED")) status = "live";
    const homeScore = home && home.score !== undefined && home.score !== "" ? Number(home.score) : null;
    const awayScore = away && away.score !== undefined && away.score !== "" ? Number(away.score) : null;
    // Group letter — ESPN puts it in different places depending on stage.
    let group = null;
    const seasonType = (ev.season && ev.season.slug) || "";
    const notes = (comp.notes && comp.notes[0] && comp.notes[0].headline) || "";
    const noteMatch = notes.match(/Group\s+([A-L])/i);
    if (noteMatch) group = noteMatch[1].toUpperCase();
    const stage = espnStageFromType(seasonType || notes);
    return {
      espnId: String(ev.id || ""),
      stage,
      group,
      kickoffUTC: ev.date || null,
      venue: (comp.venue && (comp.venue.fullName || comp.venue.address && `${comp.venue.fullName || ""}`)) || "",
      home: (home && home.team && (home.team.displayName || home.team.shortDisplayName || home.team.name)) || "",
      away: (away && away.team && (away.team.displayName || away.team.shortDisplayName || away.team.name)) || "",
      scoreHome: Number.isFinite(homeScore) ? homeScore : null,
      scoreAway: Number.isFinite(awayScore) ? awayScore : null,
      status,
    };
  } catch (e) { return null; }
}

async function fetchEspnScoreboard(dateRange = `${TOURNAMENT_START}-${TOURNAMENT_END}`) {
  const url = `${ESPN_SCOREBOARD_URL}?dates=${dateRange}&limit=200`;
  const res = await fetch(url, { headers: { "User-Agent": "wc-sweep-app/1.0" } });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const json = await res.json();
  const events = Array.isArray(json.events) ? json.events : [];
  return events.map(mapEspnEvent).filter(Boolean);
}

function mergeEspnMatches(existing, fetched) {
  // Index existing by espnId (fallback: home+away+date)
  const idx = new Map();
  for (const m of existing) {
    const key = m.espnId || `${m.home}|${m.away}|${(m.kickoffUTC || "").slice(0, 10)}`;
    idx.set(key, m);
  }
  const merged = [];
  for (const f of fetched) {
    const key = f.espnId || `${f.home}|${f.away}|${(f.kickoffUTC || "").slice(0, 10)}`;
    const prior = idx.get(key);
    if (prior && prior.manuallyOverridden) {
      // Admin override: keep score/status from prior; refresh metadata only
      merged.push({
        ...prior,
        kickoffUTC: f.kickoffUTC || prior.kickoffUTC,
        venue: f.venue || prior.venue,
        stage: f.stage || prior.stage,
        group: f.group || prior.group,
        espnId: f.espnId || prior.espnId,
      });
    } else {
      // New or auto-tracked: take fresh data from ESPN
      merged.push({
        id: prior ? prior.id : `wc_${f.espnId || Math.random().toString(36).slice(2, 10)}`,
        manuallyOverridden: false,
        ...f,
      });
    }
    idx.delete(key);
  }
  // Preserve any matches in our state that ESPN didn't return (e.g. admin-added)
  for (const leftover of idx.values()) merged.push(leftover);
  return merged;
}

function nearMatchWindow(matches) {
  if (!matches || matches.length === 0) return true;   // bootstrap case
  const now = Date.now();
  const windowMs = POLL_QUIET_WINDOW_HRS * 60 * 60 * 1000;
  return matches.some((m) => {
    if (!m.kickoffUTC) return false;
    const t = Date.parse(m.kickoffUTC);
    if (!Number.isFinite(t)) return false;
    return Math.abs(now - t) <= windowMs;
  });
}

let lastEspnPollAt = 0;
async function pollEspnMatches(force = false) {
  try {
    const before = await readState();
    if (!force && before.matches.length > 0 && !nearMatchWindow(before.matches)) {
      // Quiet window — skip
      return { skipped: "no match within ±8h" };
    }
    const fetched = await fetchEspnScoreboard();
    if (fetched.length === 0) return { skipped: "no events returned" };
    await enqueueWrite(async () => {
      const current = await readState();
      const merged = mergeEspnMatches(current.matches, fetched);
      await writeState({ ...current, matches: merged });
    });
    lastEspnPollAt = Date.now();
    return { ok: true, fetched: fetched.length };
  } catch (e) {
    console.warn("ESPN poll failed:", e.message);
    return { error: e.message };
  }
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

// Admin endpoints for the new Matches feature -----------------------------

app.post("/api/admin/matches/refresh", requireAdminToken, async (_req, res) => {
  const r = await pollEspnMatches(true);
  return res.json(r);
});

app.post("/api/admin/matches/:id/score", requireAdminToken, async (req, res) => {
  const { id } = req.params;
  const { scoreHome, scoreAway, clearOverride } = req.body || {};
  try {
    const updated = await enqueueWrite(async () => {
      const current = await readState();
      const matches = current.matches.map((m) => {
        if (m.id !== id && m.espnId !== id) return m;
        if (clearOverride) {
          return { ...m, manuallyOverridden: false };
        }
        const sh = Number(scoreHome);
        const sa = Number(scoreAway);
        if (!Number.isFinite(sh) || !Number.isFinite(sa)) throw new Error("scores must be numbers");
        return { ...m, scoreHome: sh, scoreAway: sa, status: "finished", manuallyOverridden: true };
      });
      return writeState({ ...current, matches });
    });
    return res.json({ ok: true, totalMatches: updated.matches.length });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.put("/api/state", requireAdminToken, async (req, res) => {
  const payload = req.body || {};
  const allowedKeys = ["tiers", "entries", "results", "bonus", "matches", "settings"];
  const hasAny = allowedKeys.some((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (!hasAny) {
    return res.status(400).json({ error: "Provide at least one of tiers, entries, results, bonus, matches, settings." });
  }

  try {
    const { updated, previous } = await enqueueWrite(async () => {
      const current = await readState();
      const merged = {
        tiers: Object.prototype.hasOwnProperty.call(payload, "tiers") ? payload.tiers : current.tiers,
        entries: Object.prototype.hasOwnProperty.call(payload, "entries") ? payload.entries : current.entries,
        results: Object.prototype.hasOwnProperty.call(payload, "results") ? payload.results : current.results,
        bonus: Object.prototype.hasOwnProperty.call(payload, "bonus") ? payload.bonus : current.bonus,
        matches: Object.prototype.hasOwnProperty.call(payload, "matches") ? payload.matches : current.matches,
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

  // ESPN match poller — bootstrap fixtures + scores every 30 min during match windows.
  console.log(`Match poller: ESPN scoreboard every ${POLL_INTERVAL_MS / 60000}m (skips outside ±${POLL_QUIET_WINDOW_HRS}h match window once bootstrapped)`);
  setInterval(() => pollEspnMatches(false), POLL_INTERVAL_MS);
  // Kick off immediately so first deploy bootstraps fixtures without waiting.
  pollEspnMatches(true).then((r) => {
    if (r.ok) console.log(`Match poller: bootstrapped ${r.fetched} fixtures from ESPN`);
    else console.log(`Match poller: initial fetch — ${r.skipped || r.error || "no-op"}`);
  });
});
