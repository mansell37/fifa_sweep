// =============================================================
// WORLD CUP 2026 SWEEPSTAKE
// =============================================================

// =============================================================
// CONFIGURATION
// =============================================================
const STATE_API = '/api/state';
const ENTRIES_API = '/api/entries';
const ADMIN_VERIFY_API = '/api/admin/verify';
const STORAGE = {
    entries:    'wcSweep_entries',
    results:    'wcSweep_results',
    bonus:      'wcSweep_bonus',
    settings:   'wcSweep_settings',
    adminToken: 'wcSweep_adminToken',
};
const STORAGE_BACKUP_SUFFIX = '_backup';

const TIER_MULTIPLIERS = { 1: 1, 2: 1.5, 3: 2, 4: 4, 5: 6 };
const TIER_LABELS = { 1: 'Group 1 (×1)', 2: 'Group 2 (×1.5)', 3: 'Group 3 (×2)', 4: 'Group 4 (×4)', 5: 'Group 5 (×6)' };
const TIER_KEYS = [1, 2, 3, 4, 5];
const PICK_COUNT = 5;

// 48-team roster from ESPN/DraftKings outright odds, early April 2026.
const DEFAULT_TIERS = {
    1: ['Spain', 'France', 'England', 'Brazil'],
    2: ['Argentina', 'Portugal', 'Germany', 'Netherlands', 'Norway', 'Belgium'],
    3: ['Colombia', 'Japan', 'Morocco', 'USA', 'Uruguay', 'Turkey', 'Mexico', 'Ecuador',
        'Sweden', 'Croatia', 'Switzerland', 'Austria', 'Senegal', 'Czechia'],
    4: ['Canada', 'Paraguay', 'Scotland', 'Ivory Coast', 'Bosnia', 'Egypt', 'Iran', 'Algeria',
        'South Korea', 'Ghana', 'Australia', 'Tunisia'],
    5: ['DR Congo', 'South Africa', 'Saudi Arabia', 'Panama', 'Qatar', 'New Zealand',
        'Iraq', 'Cape Verde', 'Uzbekistan', 'Jordan', 'Haiti', 'Curacao'],
};

const KO_ROUNDS = [
    { key: 'r32', label: 'R32' },
    { key: 'r16', label: 'R16' },
    { key: 'qf',  label: 'QF'  },
    { key: 'sf',  label: 'SF'  },
    { key: 'final', label: 'F' },
];

const BONUS_QUESTIONS = [
    { key: 'goalsOver250', label: 'More than 290 goals in the tournament? (104 matches)', type: 'yn', short: '>290 goals' },
    { key: 'penaltyShootouts', label: 'How many penalty shootouts in the knockout stage? (32 games)', type: 'num', short: 'Shootouts' },
    { key: 'winnerEuropean', label: 'Will the tournament winner be a European team?', type: 'yn', short: 'European winner' },
    { key: 'australiaThroughGroup', label: 'Will Australia make it out of the group stage?', type: 'yn', short: 'Aus through groups' },
];
const BONUS_POINTS_PER_CORRECT = 3;

// =============================================================
// APPLICATION STATE
// =============================================================
let tiers          = JSON.parse(JSON.stringify(DEFAULT_TIERS));  // { 1..5: [teamName, ...] }
let entries        = [];
let results        = {};   // teamName -> { groupW, groupD, groupL, r32, r16, qf, sf, final, thirdPlace }
let bonus          = { goalsOver250: '', penaltyShootouts: '', winnerEuropean: '', australiaThroughGroup: '' };
let settings       = {};
let activeTab      = 'sweep';
let adminMode      = false;
let showBonusPicks = false;

function useServerStorage() {
    return window.location.protocol !== 'file:';
}

function getAdminToken() {
    try { return localStorage.getItem(STORAGE.adminToken) || ''; } catch (_) { return ''; }
}
function setAdminToken(token) {
    try { localStorage.setItem(STORAGE.adminToken, token); } catch (_) {}
}
function clearAdminToken() {
    try { localStorage.removeItem(STORAGE.adminToken); } catch (_) {}
}
function adminHeaders(extra) {
    const t = getAdminToken();
    const h = Object.assign({}, extra || {});
    if (t) h['X-Admin-Token'] = t;
    return h;
}

// =============================================================
// STORAGE HELPERS
// =============================================================
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function save(key, data) {
    try {
        const payload = JSON.stringify(data);
        localStorage.setItem(key, payload);
        localStorage.setItem(`${key}${STORAGE_BACKUP_SUFFIX}`, payload);
    } catch (e) { console.warn('localStorage save failed', key, e); }
}

function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key) || localStorage.getItem(`${key}${STORAGE_BACKUP_SUFFIX}`);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (e) { return fallback; }
}

async function loadFromServer() {
    if (!useServerStorage()) return false;
    try {
        const res = await fetch(STATE_API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const state = await res.json();
        if (state.tiers && (state.tiers[1] || state.tiers['1'])) {
            const t1 = state.tiers[1] || state.tiers['1'] || [];
            // Only override defaults if server has a populated roster
            if ((t1.length + (state.tiers[2] || []).length) > 0) {
                tiers = {};
                for (const t of TIER_KEYS) {
                    tiers[t] = state.tiers[String(t)] || state.tiers[t] || DEFAULT_TIERS[t];
                }
            }
        }
        entries = Array.isArray(state.entries) ? normalizeEntries(state.entries) : [];
        results = isObject(state.results) ? state.results : {};
        bonus = isObject(state.bonus) ? {
            goalsOver250: state.bonus.goalsOver250 || '',
            penaltyShootouts: state.bonus.penaltyShootouts ?? '',
            winnerEuropean: state.bonus.winnerEuropean || '',
            australiaThroughGroup: state.bonus.australiaThroughGroup || '',
        } : { goalsOver250: '', penaltyShootouts: '', winnerEuropean: '', australiaThroughGroup: '' };
        settings = isObject(state.settings) ? state.settings : {};
        // Mirror to local cache
        save(STORAGE.entries, entries);
        save(STORAGE.results, results);
        save(STORAGE.bonus, bonus);
        save(STORAGE.settings, settings);
        return true;
    } catch (e) {
        console.warn('Server load failed, falling back to local cache:', e);
        return false;
    }
}

async function persistToServer(partial) {
    if (!useServerStorage()) return;
    try {
        const res = await fetch(STATE_API, {
            method: 'PUT',
            headers: adminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(partial),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
        }
    } catch (e) {
        console.warn('Server persist failed:', e);
        if (e.message && e.message.startsWith('HTTP 401')) {
            alert('Admin session expired. Please re-enter the admin password.');
            adminMode = false;
            clearAdminToken();
            document.body.classList.remove('admin-active');
            document.getElementById('adminToggle').classList.remove('active');
        }
    }
}

function persistAll() {
    save(STORAGE.entries, entries);
    save(STORAGE.results, results);
    save(STORAGE.bonus, bonus);
    save(STORAGE.settings, settings);
    persistToServer({ entries, results, bonus, settings, tiers });
}

function normalizeEntries(arr) {
    return arr.map(en => {
        const rawPicks = Array.isArray(en.picks) ? en.picks.slice(0, PICK_COUNT).map(p => `${p || ''}`) : [];
        while (rawPicks.length < PICK_COUNT) rawPicks.push('');
        return ({
        id: en.id || cryptoRandomId(),
        entrant: (en.entrant || '').trim(),
        team: (en.team || '').trim(),
        picks: rawPicks,
        bonusAnswers: isObject(en.bonusAnswers) ? {
            goalsOver250: en.bonusAnswers.goalsOver250 || '',
            penaltyShootouts: en.bonusAnswers.penaltyShootouts ?? '',
            winnerEuropean: en.bonusAnswers.winnerEuropean || '',
            australiaThroughGroup: en.bonusAnswers.australiaThroughGroup || '',
        } : { goalsOver250: '', penaltyShootouts: '', winnerEuropean: '', australiaThroughGroup: '' },
        createdAt: en.createdAt || Date.now(),
    });
    });
}

function cryptoRandomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'e_' + Math.random().toString(36).slice(2, 10);
}

// =============================================================
// SCORING ENGINE
// =============================================================
function teamRecord(teamName) {
    return results[teamName] || {
        groupW: 0, groupD: 0, groupL: 0,
        r32: false, r16: false, qf: false, sf: false, final: false,
        thirdPlace: false,
    };
}

function teamRawPoints(teamName) {
    const r = teamRecord(teamName);
    let pts = (r.groupW || 0) * 3 + (r.groupD || 0) * 1;
    let koWins = 0;
    for (const round of KO_ROUNDS) if (r[round.key]) koWins += 1;
    pts += koWins * 3;
    if (r.thirdPlace) pts += 3;
    return pts;
}

function tierOf(teamName) {
    for (const t of TIER_KEYS) if (tiers[t] && tiers[t].includes(teamName)) return t;
    return null;
}

function teamScaledPoints(teamName) {
    const tier = tierOf(teamName);
    if (!tier) return 0;
    return teamRawPoints(teamName) * TIER_MULTIPLIERS[tier];
}

function bonusPointsFor(entry) {
    let pts = 0;
    const a = entry.bonusAnswers || {};
    if (bonus.goalsOver250 && a.goalsOver250 && a.goalsOver250 === bonus.goalsOver250) pts += BONUS_POINTS_PER_CORRECT;
    if (bonus.penaltyShootouts !== '' && a.penaltyShootouts !== '' && a.penaltyShootouts != null
        && Number(a.penaltyShootouts) === Number(bonus.penaltyShootouts)) pts += BONUS_POINTS_PER_CORRECT;
    if (bonus.winnerEuropean && a.winnerEuropean && a.winnerEuropean === bonus.winnerEuropean) pts += BONUS_POINTS_PER_CORRECT;
    if (bonus.australiaThroughGroup && a.australiaThroughGroup && a.australiaThroughGroup === bonus.australiaThroughGroup) pts += BONUS_POINTS_PER_CORRECT;
    return pts;
}

function entryTotal(entry) {
    let total = 0;
    for (let i = 0; i < PICK_COUNT; i++) {
        total += teamScaledPoints(entry.picks[i]);
    }
    total += bonusPointsFor(entry);
    return total;
}

// =============================================================
// TAB NAVIGATION
// =============================================================
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
}

function activateTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    if (tab === 'sweep') renderLeaderboard();
    if (tab === 'tiers') renderTiers();
    if (tab === 'rules') renderRulesBonus();
    if (tab === 'analytics') renderAnalytics();
}

// =============================================================
// ENTRY FORM
// =============================================================
function populatePickSelects() {
    for (const t of TIER_KEYS) {
        const sel = document.getElementById(`pickTier${t}`);
        if (!sel) continue;
        const current = sel.value;
        sel.innerHTML = '<option value="">-- Select --</option>' +
            tiers[t].map(team => `<option value="${escapeAttr(team)}">${escapeHtml(team)}</option>`).join('');
        if (current && tiers[t].includes(current)) sel.value = current;
    }
}

function setupEntryForm() {
    const form = document.getElementById('teamForm');
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const entrant = document.getElementById('entrantName').value.trim();
        const team = document.getElementById('teamName').value.trim();
        const picks = TIER_KEYS.map(t => document.getElementById(`pickTier${t}`).value);
        if (!entrant || !team || picks.some(p => !p)) {
            alert('Please complete your name, team name, and all five group picks.');
            return;
        }
        const bonusAnswers = {
            goalsOver250: document.getElementById('bonusGoals').value,
            penaltyShootouts: document.getElementById('bonusShootouts').value,
            winnerEuropean: document.getElementById('bonusEuropean').value,
            australiaThroughGroup: document.getElementById('bonusAustralia').value,
        };
        if (!bonusAnswers.goalsOver250 || bonusAnswers.penaltyShootouts === '' || !bonusAnswers.winnerEuropean || !bonusAnswers.australiaThroughGroup) {
            alert('Please answer all four bonus questions.');
            return;
        }
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }
        try {
            const res = await fetch(ENTRIES_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entrant, team, picks, bonusAnswers }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            await loadFromServer();
            form.reset();
            populatePickSelects();
            renderEntriesList();
            renderLeaderboard();
            if (activeTab === 'analytics') renderAnalytics();
            flashToast(`Entry "${team}" submitted.`);
        } catch (err) {
            alert(`Failed to submit entry: ${err.message}`);
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Team'; }
        }
    });
}

function deleteEntry(id) {
    if (!confirm('Delete this entry?')) return;
    entries = entries.filter(e => e.id !== id);
    persistAll();
    renderEntriesList();
    renderLeaderboard();
}

// =============================================================
// RENDER: LEADERBOARD
// =============================================================
function renderLeaderboard() {
    const head = document.getElementById('sweepHead');
    const body = document.getElementById('sweepBody');
    const countEl = document.getElementById('sweepEntryCount');
    const lastUpdEl = document.getElementById('lastUpdated');

    countEl.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
    lastUpdEl.textContent = new Date().toLocaleTimeString();

    head.innerHTML = `
        <tr>
            <th class="rank">#</th>
            <th>Team / Entrant</th>
            <th>Team 1: (×1)</th>
            <th>Team 2: (×1.5)</th>
            <th>Team 3: (×2)</th>
            <th>Team 4: (×4)</th>
            <th>Team 5: (×6)</th>
            <th class="bonus-cell">Bonus</th>
            <th style="text-align:right">Total</th>
        </tr>
    `;

    if (entries.length === 0) {
        body.innerHTML = `<tr><td colspan="9" class="empty-cell">No entries yet. Go to "Enter Team" to add teams.</td></tr>`;
        return;
    }

    const ranked = entries.map(en => ({ en, total: entryTotal(en) }))
        .sort((a, b) => b.total - a.total);

    body.innerHTML = ranked.map(({ en, total }, idx) => {
        const rankClass = idx === 0 ? 'r1' : idx === 1 ? 'r2' : idx === 2 ? 'r3' : '';
        const mainRow = `
            <tr>
                <td class="rank ${rankClass}">${idx + 1}</td>
                <td>
                    <div class="team-line"><span class="team-name">${escapeHtml(en.team)}</span><span class="team-sep">·</span><span class="entrant-name">${escapeHtml(en.entrant)}</span></div>
                </td>
                ${[0, 1, 2, 3, 4].map(i => pickCell(en.picks[i], i + 1)).join('')}
                <td class="bonus-cell">${bonusPointsFor(en)}</td>
                <td class="total">${formatPts(total)}</td>
            </tr>
        `;
        const detailRow = showBonusPicks ? `
            <tr class="bonus-detail-row">
                <td></td>
                <td colspan="8">
                    <div class="bonus-picks-row">
                        ${BONUS_QUESTIONS.map(q => bonusPickChip(en, q)).join('')}
                    </div>
                </td>
            </tr>
        ` : '';
        return mainRow + detailRow;
    }).join('');
}

function pickCell(teamName, tier) {
    if (!teamName) return `<td class="pick-cell"><span class="pick-team">—</span></td>`;
    const r = teamRecord(teamName);
    const raw = teamRawPoints(teamName);
    const mult = TIER_MULTIPLIERS[tier];
    const scaled = raw * mult;
    const koWins = KO_ROUNDS.filter(rd => r[rd.key]).length;
    const totalWins = (r.groupW || 0) + koWins;
    const thirdChip = r.thirdPlace
        ? `<span class="ko-chip" title="3rd-place playoff winner (+3)">3rd</span>`
        : '';
    return `<td class="pick-cell">
        <div class="pick-row">
            <div class="pick-team-block">
                <span class="pick-team">${escapeHtml(teamName)}</span>
                ${thirdChip}
            </div>
            <div class="wdl-inline" title="W = all wins (3 pts each), D = group draws (1 pt), L = group losses">
                <span class="wdl-chip wdl-w">W&nbsp;${totalWins}</span>
                <span class="wdl-chip wdl-d">D&nbsp;${r.groupD || 0}</span>
                <span class="wdl-chip wdl-l">L&nbsp;${r.groupL || 0}</span>
            </div>
            <div class="pick-scaled" title="${raw} &times; ${mult}">${formatPts(scaled)}</div>
        </div>
    </td>`;
}

function formatPts(n) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
}

function bonusPickChip(entry, q) {
    const guess = entry.bonusAnswers?.[q.key];
    const correct = bonus[q.key];
    const guessLabel = guess === '' || guess == null ? '—' : String(guess);
    let cls = 'bonus-pick';
    let icon = '';
    if (guess === '' || guess == null) {
        cls += ' missing';
    } else if (correct === '' || correct == null) {
        cls += ' unknown';
    } else if (String(guess) === String(correct)) {
        cls += ' correct';
        icon = '<span class="bonus-pick-icon">✓</span>';
    } else {
        cls += ' wrong';
        icon = '<span class="bonus-pick-icon">✕</span>';
    }
    return `<span class="${cls}"><span class="bonus-pick-label">${escapeHtml(q.short)}:</span> ${escapeHtml(guessLabel)}${icon}</span>`;
}

// =============================================================
// RENDER: ENTRIES LIST (Enter Team panel)
// =============================================================
function renderEntriesList() {
    const list = document.getElementById('entriesList');
    const count = document.getElementById('teamCount');
    count.textContent = entries.length;
    if (entries.length === 0) {
        list.innerHTML = `<p class="empty-cell">No teams submitted yet.</p>`;
        return;
    }
    const sorted = [...entries].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    list.innerHTML = sorted.map(en => `
        <div class="entry-card">
            <div class="entry-info">
                <div class="entry-team">${escapeHtml(en.team)}</div>
                <div class="entry-entrant">${escapeHtml(en.entrant)}</div>
                <div class="entry-picks">${en.picks.map(p => escapeHtml(p || '—')).join(' · ')}</div>
            </div>
            <div class="entry-actions admin-only">
                <button class="icon-btn" title="Delete" onclick="deleteEntry('${escapeAttr(en.id)}')">&#10005;</button>
            </div>
        </div>
    `).join('');
}

// =============================================================
// RENDER: TIERS TAB
// =============================================================
function renderTiers() {
    const grid = document.getElementById('tiersGrid');
    const pickCounts = {};
    for (const en of entries) {
        for (const p of en.picks) {
            if (!p) continue;
            pickCounts[p] = (pickCounts[p] || 0) + 1;
        }
    }
    grid.innerHTML = TIER_KEYS.map(t => `
        <div class="tier-card tier-${t}">
            <div class="tier-card-header">
                <span>Group ${t} — ${tiers[t].length} teams</span>
                <span class="mult-badge">×${TIER_MULTIPLIERS[t]}</span>
            </div>
            <div class="tier-card-body">
                ${tiers[t].map(team => `
                    <div class="tier-team-row">
                        <span>${escapeHtml(team)}</span>
                        <span class="pick-count">${pickCounts[team] || 0} picks · ${formatPts(teamRawPoints(team) * TIER_MULTIPLIERS[t])} pts</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

// =============================================================
// RENDER: RULES BONUS PANEL
// =============================================================
function renderRulesBonus() {
    const el = document.getElementById('bonusQuestionsDisplay');
    el.innerHTML = BONUS_QUESTIONS.map(q => {
        const answer = bonus[q.key];
        const ansHtml = (answer === '' || answer == null)
            ? `<span class="answer-pending">awaiting result</span>`
            : `<span class="answer-value">${escapeHtml(String(answer))}</span>`;
        return `<div class="bonus-display-item">
            <div>${escapeHtml(q.label)}</div>
            <div class="answer-label">Correct answer: ${ansHtml}</div>
        </div>`;
    }).join('');
}

// =============================================================
// RENDER: ANALYTICS TAB
// =============================================================
function renderAnalytics() {
    const root = document.getElementById('analyticsContent');
    if (entries.length === 0) {
        root.innerHTML = `<p class="empty-cell" style="padding:20px">No entries yet.</p>`;
        return;
    }

    // --- Field overview ---
    const totals = entries.map(en => entryTotal(en)).sort((a, b) => a - b);
    const sum = totals.reduce((s, v) => s + v, 0);
    const avg = sum / totals.length;
    const median = totals.length % 2 === 0
        ? (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2
        : totals[Math.floor(totals.length / 2)];
    const max = totals[totals.length - 1];
    const min = totals[0];

    // --- Pick popularity per group ---
    const tierCounts = {};
    for (const t of TIER_KEYS) tierCounts[t] = {};
    for (const en of entries) {
        for (let i = 0; i < PICK_COUNT; i++) {
            const team = en.picks[i];
            if (!team) continue;
            tierCounts[i + 1][team] = (tierCounts[i + 1][team] || 0) + 1;
        }
    }

    // --- Top scoring teams in the tournament (by raw points) ---
    const teamScores = Object.entries(results)
        .map(([team, _r]) => ({ team, raw: teamRawPoints(team), tier: tierOf(team) }))
        .filter(t => t.raw > 0)
        .sort((a, b) => b.raw - a.raw)
        .slice(0, 8);

    // --- Bonus consensus ---
    let goalsY = 0, goalsN = 0, europeanY = 0, europeanN = 0, ausY = 0, ausN = 0;
    const shootouts = [];
    for (const en of entries) {
        const a = en.bonusAnswers || {};
        if (a.goalsOver250 === 'Y') goalsY++;
        else if (a.goalsOver250 === 'N') goalsN++;
        if (a.winnerEuropean === 'Y') europeanY++;
        else if (a.winnerEuropean === 'N') europeanN++;
        if (a.australiaThroughGroup === 'Y') ausY++;
        else if (a.australiaThroughGroup === 'N') ausN++;
        if (a.penaltyShootouts !== '' && a.penaltyShootouts != null) shootouts.push(Number(a.penaltyShootouts));
    }
    const numOrDash = arr => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : '—';
    const rangeOrDash = arr => arr.length ? `${Math.min(...arr)} – ${Math.max(...arr)}` : '—';

    // --- Picks-still-alive per entry (team has won at least one KO round) ---
    const aliveCounts = entries.map(en => {
        let alive = 0;
        for (const team of en.picks) {
            const r = teamRecord(team);
            if (KO_ROUNDS.some(rd => r[rd.key])) alive++;
        }
        return { team: en.team, entrant: en.entrant, alive };
    }).sort((a, b) => b.alive - a.alive || a.team.localeCompare(b.team));

    const aliveLabel = (n) => `${n} / ${PICK_COUNT}`;

    const tierBlocks = TIER_KEYS.map(t => {
        const sorted = Object.entries(tierCounts[t]).sort((a, b) => b[1] - a[1]);
        const top = sorted.slice(0, 8);
        const maxN = top.length ? top[0][1] : 1;
        return `<div class="analytics-card">
            <h3>Group ${t} most-picked <span class="mult-mini">×${TIER_MULTIPLIERS[t]}</span></h3>
            ${top.length === 0 ? '<div class="empty-cell">No picks</div>' :
                top.map(([team, n]) => `
                    <div class="pick-bar-row">
                        <span class="pick-bar-team">${escapeHtml(team)}</span>
                        <div class="pick-bar"><div class="pick-bar-fill tier-fill-${t}" style="width:${(n / maxN) * 100}%"></div></div>
                        <span class="pick-bar-val">${n}</span>
                    </div>
                `).join('')}
        </div>`;
    }).join('');

    root.innerHTML = `<div class="analytics-grid">
        <div class="analytics-card">
            <h3>Field overview</h3>
            <div class="analytics-stat-row"><span>Total entries</span><span class="stat-val">${entries.length}</span></div>
            <div class="analytics-stat-row"><span>Average score</span><span class="stat-val">${formatPts(avg)}</span></div>
            <div class="analytics-stat-row"><span>Median score</span><span class="stat-val">${formatPts(median)}</span></div>
            <div class="analytics-stat-row"><span>Top score</span><span class="stat-val">${formatPts(max)}</span></div>
            <div class="analytics-stat-row"><span>Lowest score</span><span class="stat-val">${formatPts(min)}</span></div>
            <div class="analytics-stat-row"><span>Spread</span><span class="stat-val">${formatPts(max - min)} pts</span></div>
        </div>

        <div class="analytics-card">
            <h3>Top scoring teams in the tournament</h3>
            ${teamScores.length === 0
                ? '<div class="empty-cell">No tournament results entered yet</div>'
                : teamScores.map(t => `
                    <div class="analytics-stat-row">
                        <span><span class="tier-pill tier-pill-${t.tier || 1}">G${t.tier || '?'}</span> ${escapeHtml(t.team)}</span>
                        <span class="stat-val">${t.raw} pts</span>
                    </div>
                `).join('')}
        </div>

        <div class="analytics-card">
            <h3>Bonus question consensus</h3>
            <div class="analytics-stat-row"><span>&gt;290 goals: Yes / No</span><span class="stat-val">${goalsY} / ${goalsN}</span></div>
            <div class="analytics-stat-row"><span>Avg shootouts guess</span><span class="stat-val">${numOrDash(shootouts)}</span></div>
            <div class="analytics-stat-row"><span>Shootouts range</span><span class="stat-val">${rangeOrDash(shootouts)}</span></div>
            <div class="analytics-stat-row"><span>European winner: Yes / No</span><span class="stat-val">${europeanY} / ${europeanN}</span></div>
            <div class="analytics-stat-row"><span>Australia through groups: Yes / No</span><span class="stat-val">${ausY} / ${ausN}</span></div>
        </div>

        <div class="analytics-card analytics-card-tall">
            <h3>Picks still alive (in knockout)</h3>
            <p class="analytics-hint">Number of an entrant's ${PICK_COUNT} picks that have won at least one knockout round.</p>
            ${aliveCounts.slice(0, 14).map(e => `
                <div class="analytics-stat-row">
                    <span>${escapeHtml(e.team)} <span class="entrant-small">· ${escapeHtml(e.entrant)}</span></span>
                    <span class="stat-val alive-val alive-${e.alive}">${aliveLabel(e.alive)}</span>
                </div>
            `).join('')}
        </div>

        ${tierBlocks}
    </div>`;
}

// =============================================================
// ADMIN: PASSWORD + MODE
// =============================================================
function setupAdmin() {
    document.getElementById('adminToggle').addEventListener('click', () => {
        if (adminMode) {
            adminMode = false;
            clearAdminToken();
            document.body.classList.remove('admin-active');
            document.getElementById('adminToggle').classList.remove('active');
            renderEntriesList();
        } else {
            document.getElementById('adminPwModal').classList.add('active');
            document.getElementById('adminPwInput').value = '';
            document.getElementById('adminPwError').style.display = 'none';
            setTimeout(() => document.getElementById('adminPwInput').focus(), 50);
        }
    });
}

window.confirmAdminPassword = async function () {
    const val = document.getElementById('adminPwInput').value;
    if (!val) {
        document.getElementById('adminPwError').style.display = 'block';
        return;
    }
    try {
        const res = await fetch(ADMIN_VERIFY_API, {
            method: 'POST',
            headers: { 'X-Admin-Token': val },
        });
        if (!res.ok) {
            document.getElementById('adminPwError').style.display = 'block';
            return;
        }
        setAdminToken(val);
        adminMode = true;
        document.body.classList.add('admin-active');
        document.getElementById('adminToggle').classList.add('active');
        closeAdminModal();
        renderEntriesList();
        renderBonusAdminForm();
        renderSnapshotList();
    } catch (e) {
        document.getElementById('adminPwError').textContent = 'Verification failed: ' + e.message;
        document.getElementById('adminPwError').style.display = 'block';
    }
};

window.closeAdminModal = function () {
    document.getElementById('adminPwModal').classList.remove('active');
};

// =============================================================
// ADMIN: BONUS ANSWERS FORM (in Enter tab)
// =============================================================
function renderBonusAdminForm() {
    const root = document.getElementById('bonusAdminForm');
    if (!root) return;
    root.innerHTML = BONUS_QUESTIONS.map(q => {
        const val = bonus[q.key] ?? '';
        if (q.type === 'yn') {
            return `<div class="form-row">
                <label>${escapeHtml(q.label)}</label>
                <select data-bonus-key="${q.key}">
                    <option value="">-- pending --</option>
                    <option value="Y" ${val === 'Y' ? 'selected' : ''}>Yes</option>
                    <option value="N" ${val === 'N' ? 'selected' : ''}>No</option>
                </select>
            </div>`;
        }
        return `<div class="form-row">
            <label>${escapeHtml(q.label)}</label>
            <input type="number" min="0" data-bonus-key="${q.key}" value="${escapeAttr(String(val))}" placeholder="number">
        </div>`;
    }).join('') + `<button class="btn btn-submit" id="saveBonusBtn" style="margin-top:6px">Save Bonus Answers</button>`;

    document.getElementById('saveBonusBtn').addEventListener('click', () => {
        root.querySelectorAll('[data-bonus-key]').forEach(el => {
            bonus[el.dataset.bonusKey] = el.value;
        });
        persistAll();
        flashToast('Bonus answers saved.');
        renderLeaderboard();
        renderRulesBonus();
    });
}

// =============================================================
// ADMIN: SERVER SNAPSHOTS
// =============================================================
function setupSnapshotPanel() {
    const btn = document.getElementById('refreshSnapshotsBtn');
    if (btn) btn.addEventListener('click', renderSnapshotList);
}

function parseSnapshotTimestamp(filename) {
    // state-YYYYMMDD-HHMMSS(-mmm)?.json (UTC)
    const m = filename.match(/^state-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?\.json$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)));
}

async function renderSnapshotList() {
    const root = document.getElementById('snapshotList');
    const countEl = document.getElementById('snapshotCount');
    if (!root) return;
    root.innerHTML = '<p class="empty-cell" style="padding:8px">Loading...</p>';
    try {
        const res = await fetch('/api/backups', { headers: adminHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        if (countEl) countEl.textContent = `${list.length} snapshot${list.length === 1 ? '' : 's'}`;
        if (list.length === 0) {
            root.innerHTML = '<p class="empty-cell" style="padding:8px">No snapshots yet — save a change first.</p>';
            return;
        }
        root.innerHTML = list.map(s => {
            const ts = parseSnapshotTimestamp(s.filename) || new Date(s.mtime);
            const local = ts.toLocaleString();
            const entriesLabel = s.entries == null ? '—' : `${s.entries} entries`;
            return `<div class="snapshot-row">
                <div class="snapshot-meta">
                    <span class="snapshot-time">${escapeHtml(local)}</span>
                    <span class="snapshot-entries">${entriesLabel}</span>
                </div>
                <div class="snapshot-actions">
                    <button class="btn btn-small btn-export" onclick="downloadSnapshot('${escapeAttr(s.filename)}')" title="Download">&#8659;</button>
                    <button class="btn btn-small btn-restore" onclick="restoreSnapshot('${escapeAttr(s.filename)}')">Restore</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        root.innerHTML = `<p class="empty-cell" style="padding:8px;color:var(--red-600)">Failed to load snapshots: ${escapeHtml(e.message)}</p>`;
    }
}

window.downloadSnapshot = async function (filename) {
    try {
        const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { headers: adminHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('Download failed: ' + e.message);
    }
};

window.restoreSnapshot = async function (filename) {
    if (!confirm(`Restore from ${filename}? This will overwrite ALL current entries, results, and bonus answers.\n\nA fresh snapshot will be saved of the current state first.`)) return;
    try {
        const res = await fetch(`/api/backups/restore/${encodeURIComponent(filename)}`, { method: 'POST', headers: adminHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFromServer();
        populatePickSelects();
        renderLeaderboard();
        renderEntriesList();
        renderRulesBonus();
        renderSnapshotList();
        flashToast(`Restored from ${filename}`);
    } catch (e) {
        alert('Restore failed: ' + e.message);
    }
};

// =============================================================
// ADMIN: RESULTS EDITOR
// =============================================================
function setupResultsEditor() {
    const openBtn = document.getElementById('openResultsBtn');
    if (openBtn) openBtn.addEventListener('click', openResultsModal);
    document.getElementById('saveResultsBtn').addEventListener('click', saveResultsFromModal);
    document.getElementById('cancelResultsBtn').addEventListener('click', () => {
        document.getElementById('resultsModal').classList.remove('active');
    });
}

function openResultsModal() {
    const body = document.getElementById('resultsModalBody');
    const rows = [];
    for (const t of TIER_KEYS) {
        for (const team of tiers[t]) {
            const r = teamRecord(team);
            rows.push(`
                <div class="result-row tier-${t}" data-team="${escapeAttr(team)}">
                    <div class="team-name">${escapeHtml(team)}<span class="tier-tag">G${t}</span></div>
                    <div class="input-grid">
                        <div><label>W</label><input type="number" min="0" max="3" data-field="groupW" value="${r.groupW || 0}"></div>
                        <div><label>D</label><input type="number" min="0" max="3" data-field="groupD" value="${r.groupD || 0}"></div>
                        <div><label>L</label><input type="number" min="0" max="3" data-field="groupL" value="${r.groupL || 0}"></div>
                    </div>
                    <div class="ko-line">
                        ${KO_ROUNDS.map(rd => `<label title="${rd.label} win">${rd.label}<input type="checkbox" data-field="${rd.key}" ${r[rd.key] ? 'checked' : ''}></label>`).join('')}
                        <label title="Won 3rd-place playoff">3rd<input type="checkbox" data-field="thirdPlace" ${r.thirdPlace ? 'checked' : ''}></label>
                        <span class="pts-tag" data-pts>${teamRawPoints(team)} × ${TIER_MULTIPLIERS[t]} = ${formatPts(teamRawPoints(team) * TIER_MULTIPLIERS[t])}</span>
                    </div>
                </div>
            `);
        }
    }
    body.innerHTML = rows.join('');
    // Live recompute on input
    body.querySelectorAll('.result-row').forEach(row => {
        row.addEventListener('input', () => {
            const team = row.dataset.team;
            const tier = tierOf(team) || 1;
            const tempR = {
                groupW: clamp(parseInt(row.querySelector('[data-field=groupW]').value) || 0, 0, 3),
                groupD: clamp(parseInt(row.querySelector('[data-field=groupD]').value) || 0, 0, 3),
                groupL: clamp(parseInt(row.querySelector('[data-field=groupL]').value) || 0, 0, 3),
                r32: row.querySelector('[data-field=r32]').checked,
                r16: row.querySelector('[data-field=r16]').checked,
                qf: row.querySelector('[data-field=qf]').checked,
                sf: row.querySelector('[data-field=sf]').checked,
                final: row.querySelector('[data-field=final]').checked,
                thirdPlace: row.querySelector('[data-field=thirdPlace]').checked,
            };
            const raw = computeRawFromRecord(tempR);
            row.querySelector('[data-pts]').textContent = `${raw} × ${TIER_MULTIPLIERS[tier]} = ${formatPts(raw * TIER_MULTIPLIERS[tier])}`;
        });
    });
    document.getElementById('resultsModal').classList.add('active');
}

function computeRawFromRecord(r) {
    let pts = (r.groupW || 0) * 3 + (r.groupD || 0) * 1;
    pts += [r.r32, r.r16, r.qf, r.sf, r.final].filter(Boolean).length * 3;
    if (r.thirdPlace) pts += 3;
    return pts;
}

function saveResultsFromModal() {
    document.querySelectorAll('#resultsModalBody .result-row').forEach(row => {
        const team = row.dataset.team;
        results[team] = {
            groupW: clamp(parseInt(row.querySelector('[data-field=groupW]').value) || 0, 0, 3),
            groupD: clamp(parseInt(row.querySelector('[data-field=groupD]').value) || 0, 0, 3),
            groupL: clamp(parseInt(row.querySelector('[data-field=groupL]').value) || 0, 0, 3),
            r32: row.querySelector('[data-field=r32]').checked,
            r16: row.querySelector('[data-field=r16]').checked,
            qf: row.querySelector('[data-field=qf]').checked,
            sf: row.querySelector('[data-field=sf]').checked,
            final: row.querySelector('[data-field=final]').checked,
            thirdPlace: row.querySelector('[data-field=thirdPlace]').checked,
        };
    });
    persistAll();
    document.getElementById('resultsModal').classList.remove('active');
    flashToast('Results saved.');
    renderLeaderboard();
    if (activeTab === 'tiers') renderTiers();
    if (activeTab === 'detail') renderDetail();
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// =============================================================
// BACKUP / RESTORE
// =============================================================
window.exportStateBackup = function () {
    const blob = new Blob([JSON.stringify({ tiers, entries, results, bonus, settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wc-sweep-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
};

window.importStateBackup = function (event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const obj = JSON.parse(e.target.result);
            if (!confirm('Restoring will overwrite all current data. Continue?')) return;
            if (obj.tiers) tiers = obj.tiers;
            if (Array.isArray(obj.entries)) entries = normalizeEntries(obj.entries);
            if (obj.results) results = obj.results;
            if (obj.bonus) bonus = obj.bonus;
            if (obj.settings) settings = obj.settings;
            persistAll();
            populatePickSelects();
            renderLeaderboard();
            renderEntriesList();
            renderTiers();
            flashToast('Backup restored.');
        } catch (err) {
            alert('Invalid backup file.');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
};

window.exportTiersCSV = function () {
    const rows = [['Group', 'Multiplier', 'Team']];
    for (const t of TIER_KEYS) {
        for (const team of tiers[t]) rows.push([t, TIER_MULTIPLIERS[t], team]);
    }
    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wc-tiers.csv`;
    a.click();
    URL.revokeObjectURL(url);
};

// =============================================================
// UTILITIES
// =============================================================
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function flashToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
            background: '#0a1a3a', color: 'white', padding: '10px 16px', borderRadius: '8px',
            fontSize: '13px', zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            opacity: '0', transition: 'opacity 0.2s',
        });
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
}

// =============================================================
// INITIAL LOAD
// =============================================================
async function init() {
    // Local cache first (instant render)
    entries = normalizeEntries(load(STORAGE.entries, []));
    results = load(STORAGE.results, {});
    bonus = load(STORAGE.bonus, { goalsOver250: '', penaltyShootouts: '', redCards: '' });
    settings = load(STORAGE.settings, {});

    setupTabs();
    setupAdmin();
    setupEntryForm();
    setupResultsEditor();
    setupSnapshotPanel();
    // Restore admin mode if a stored token is still valid
    if (useServerStorage() && getAdminToken()) {
        try {
            const r = await fetch(ADMIN_VERIFY_API, { method: 'POST', headers: adminHeaders() });
            if (r.ok) {
                adminMode = true;
                document.body.classList.add('admin-active');
                document.getElementById('adminToggle').classList.add('active');
                renderBonusAdminForm();
                renderSnapshotList();
            } else {
                clearAdminToken();
            }
        } catch (_) { /* ignore */ }
    }
    document.getElementById('toggleBonusPicks').addEventListener('click', () => {
        showBonusPicks = !showBonusPicks;
        document.getElementById('toggleBonusPicks').textContent = showBonusPicks ? 'Hide bonus picks' : 'Show bonus picks';
        renderLeaderboard();
    });
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadFromServer();
        populatePickSelects();
        renderLeaderboard();
        renderEntriesList();
        if (activeTab === 'tiers') renderTiers();
    });

    populatePickSelects();
    renderLeaderboard();
    renderEntriesList();
    renderRulesBonus();

    // Then refresh from server
    if (useServerStorage()) {
        const ok = await loadFromServer();
        if (ok) {
            populatePickSelects();
            renderLeaderboard();
            renderEntriesList();
        }
    }

    document.getElementById('footerUpdated').textContent = new Date().toLocaleString();
}

document.addEventListener('DOMContentLoaded', init);
