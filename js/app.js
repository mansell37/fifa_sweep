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

// 48-team roster. Order within each group is intentionally randomised
// (not odds-order) so the favourite isn't visually first and picks
// spread more evenly across each group.
const DEFAULT_TIERS = {
    1: ['Germany', 'France', 'Argentina', 'England', 'Brazil', 'Portugal', 'Spain'],
    2: ['Belgium', 'Norway', 'USA', 'Netherlands', 'Morocco', 'Japan', 'Colombia'],
    3: ['Switzerland', 'Senegal', 'Turkey', 'Mexico', 'Ecuador', 'Croatia', 'Austria',
        'Uruguay', 'Sweden'],
    4: ['Canada', 'Algeria', 'Paraguay', 'Czechia', 'Australia', 'Bosnia', 'South Korea',
        'Egypt', 'Ivory Coast', 'Iran', 'Ghana', 'Scotland'],
    5: ['DR Congo', 'Panama', 'Uzbekistan', 'Jordan', 'South Africa', 'Qatar',
        'New Zealand', 'Haiti', 'Cape Verde', 'Tunisia', 'Saudi Arabia', 'Iraq', 'Curacao'],
};

const KO_ROUNDS = [
    { key: 'r32', label: 'R32' },
    { key: 'r16', label: 'R16' },
    { key: 'qf',  label: 'QF'  },
    { key: 'sf',  label: 'SF'  },
    { key: 'final', label: 'F' },
];

const BONUS_QUESTIONS = [
    { key: 'goalsOver250', label: 'Will there be 300 or more goals in the tournament? (104 matches)', type: 'yn', short: '300+ goals', col: '300+?' },
    { key: 'winnerEuropean', label: 'Will the tournament winner be from continental Europe? (England & Scotland excluded)', type: 'yn', short: 'Continental Euro winner', col: 'Continental Euro?' },
    { key: 'australiaThroughGroup', label: 'Will Australia make it out of the group stage?', type: 'yn', short: 'Aus through groups', col: 'Aus?' },
];
const BONUS_POINTS_PER_CORRECT = 3;

// Prize pool: $10 per entry, split by finishing position.
// Percentages mirror the Rules & Prizes tab.
const ENTRY_FEE = 10;
const PRIZE_SPLITS = [
    { label: '1st place', pct: 0.60 },
    { label: '2nd place', pct: 0.25 },
    { label: '3rd place', pct: 0.10 },
    { label: 'Wooden spoon', pct: 0.05 },
];

// =============================================================
// APPLICATION STATE
// =============================================================
let tiers          = JSON.parse(JSON.stringify(DEFAULT_TIERS));  // { 1..5: [teamName, ...] }
let entries        = [];
let results        = {};   // teamName -> { groupW, groupD, groupL, r32, r16, qf, sf, final, thirdPlace }
let bonus          = { goalsOver250: '', winnerEuropean: '', australiaThroughGroup: '' };
let matches        = [];   // [{ id, espnId, stage, group, kickoffUTC, venue, home, away, scoreHome, scoreAway, status, manuallyOverridden }]
let settings       = {};
let activeTab      = 'sweep';
let adminMode      = false;
let showBonusPicks = false;
let leaderboardSearch = '';

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
            winnerEuropean: state.bonus.winnerEuropean || '',
            australiaThroughGroup: state.bonus.australiaThroughGroup || '',
        } : { goalsOver250: '', winnerEuropean: '', australiaThroughGroup: '' };
        matches = Array.isArray(state.matches) ? state.matches : [];
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
            winnerEuropean: en.bonusAnswers.winnerEuropean || '',
            australiaThroughGroup: en.bonusAnswers.australiaThroughGroup || '',
        } : { goalsOver250: '', winnerEuropean: '', australiaThroughGroup: '' },
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
    if (tab === 'enter' && !adminMode) tab = 'sweep';
    if (tab === 'emailguide' && !adminMode) tab = 'sweep';
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    if (tab === 'sweep') renderLeaderboard();
    if (tab === 'matches') renderMatches(true);
    if (tab === 'tiers') renderTiers();
    if (tab === 'rules') renderRulesBonus();
    if (tab === 'analytics') renderAnalytics();
    if (tab === 'emailguide') renderEmailGuide();
}

// Analytics is always public now (moved to main section). Keeping the
// helpers as no-ops in case anything still calls them.
function isAnalyticsVisibleToCurrentUser() { return true; }
function applyAnalyticsVisibility() {
    const btn = document.getElementById('analyticsTabBtn');
    if (btn) btn.classList.remove('admin-only');
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
            winnerEuropean: document.getElementById('bonusEuropean').value,
            australiaThroughGroup: document.getElementById('bonusAustralia').value,
        };
        if (!bonusAnswers.goalsOver250 || !bonusAnswers.winnerEuropean || !bonusAnswers.australiaThroughGroup) {
            alert('Please answer all three bonus questions.');
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

window.openEditEntryModal = function (id) {
    const en = entries.find(e => e.id === id);
    if (!en) return;
    const modal = document.getElementById('editEntryModal');
    if (!modal) return;
    document.getElementById('editEntryEntrantInput').value = en.entrant || '';
    document.getElementById('editEntryTeamInput').value = en.team || '';
    document.getElementById('editEntryPicksPreview').textContent = en.picks.filter(Boolean).join(' · ') || '(no picks)';
    modal.dataset.entryId = id;
    modal.classList.add('active');
    setTimeout(() => document.getElementById('editEntryTeamInput').focus(), 50);
};

window.closeEditEntryModal = function () {
    document.getElementById('editEntryModal').classList.remove('active');
};

window.saveEditEntry = async function () {
    const modal = document.getElementById('editEntryModal');
    const id = modal.dataset.entryId;
    const entrant = document.getElementById('editEntryEntrantInput').value.trim();
    const team = document.getElementById('editEntryTeamInput').value.trim();
    if (!entrant || !team) {
        alert('Both fields are required.');
        return;
    }
    try {
        const res = await fetch(`/api/admin/entries/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: adminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ entrant, team }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await loadFromServer();
        closeEditEntryModal();
        renderEntriesList();
        renderLeaderboard();
        flashToast('Entry updated.');
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
};

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

    const bonusHeadCells = showBonusPicks
        ? BONUS_QUESTIONS.map(q => `<th class="bonus-col-head">${escapeHtml(q.col)}</th>`).join('')
        : '';

    head.innerHTML = `
        <tr>
            <th class="rank">#</th>
            <th>Team / Entrant</th>
            <th>Team 1: (×1)</th>
            <th>Team 2: (×1.5)</th>
            <th>Team 3: (×2)</th>
            <th>Team 4: (×4)</th>
            <th>Team 5: (×6)</th>
            ${bonusHeadCells}
            <th class="bonus-cell">Bonus</th>
            <th style="text-align:right">Total</th>
        </tr>
    `;

    const totalCols = 9 + (showBonusPicks ? BONUS_QUESTIONS.length : 0);

    if (entries.length === 0) {
        body.innerHTML = `<tr><td colspan="${totalCols}" class="empty-cell">No entries yet. Go to "Enter Team" to add teams.</td></tr>`;
        return;
    }

    const ranked = entries.map(en => ({ en, total: entryTotal(en), bonusPts: bonusPointsFor(en) }))
        .sort((a, b) => b.total - a.total || b.bonusPts - a.bonusPts);

    // Filter AFTER ranking so the # column shows each entrant's real position
    // out of the full field, not just their position within the filtered view.
    const q = leaderboardSearch.trim().toLowerCase();
    const visible = q
        ? ranked.map((r, idx) => ({ ...r, idx })).filter(({ en }) =>
            (en.team || '').toLowerCase().includes(q) ||
            (en.entrant || '').toLowerCase().includes(q))
        : ranked.map((r, idx) => ({ ...r, idx }));

    if (q) {
        countEl.textContent = `${visible.length} of ${entries.length} matching "${q}"`;
    }

    if (visible.length === 0) {
        body.innerHTML = `<tr><td colspan="${totalCols}" class="empty-cell">No entries match "${escapeHtml(q)}". Clear the search to see everyone.</td></tr>`;
        return;
    }

    body.innerHTML = visible.map(({ en, total, idx }) => {
        const rankClass = idx === 0 ? 'r1' : idx === 1 ? 'r2' : idx === 2 ? 'r3' : '';
        const bonusCells = showBonusPicks
            ? BONUS_QUESTIONS.map(q => bonusAnswerCell(en, q)).join('')
            : '';
        return `
            <tr>
                <td class="rank ${rankClass}">${idx + 1}</td>
                <td>
                    <div class="team-line"><span class="team-name">${escapeHtml(en.team)}</span><span class="team-sep">·</span><span class="entrant-name">${escapeHtml(en.entrant)}</span></div>
                </td>
                ${[0, 1, 2, 3, 4].map(i => pickCell(en.picks[i], i + 1)).join('')}
                ${bonusCells}
                <td class="bonus-cell">${bonusPointsFor(en)}</td>
                <td class="total">${formatPts(total)}</td>
            </tr>
        `;
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
                <span class="wdl-chip wdl-w">W${totalWins}</span>
                <span class="wdl-chip wdl-d">D${r.groupD || 0}</span>
                <span class="wdl-chip wdl-l">L${r.groupL || 0}</span>
            </div>
            <div class="pick-scaled" title="${raw} &times; ${mult}">${formatPts(scaled)}</div>
        </div>
    </td>`;
}

function formatPts(n) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
}

function bonusAnswerCell(entry, q) {
    const guess = entry.bonusAnswers?.[q.key];
    const correct = bonus[q.key];
    const guessLabel = guess === '' || guess == null ? '—' : String(guess);
    let cls = 'bonus-ans';
    if (guess === '' || guess == null) {
        cls += ' bonus-ans-missing';
    } else if (correct === '' || correct == null) {
        cls += ' bonus-ans-unknown';
    } else if (String(guess) === String(correct)) {
        cls += ' bonus-ans-correct';
    } else {
        cls += ' bonus-ans-wrong';
    }
    return `<td class="bonus-ans-cell"><span class="${cls}">${escapeHtml(guessLabel)}</span></td>`;
}

// =============================================================
// RENDER: ENTRIES LIST (Enter Team panel)
// =============================================================
function formatMoney(n) {
    const v = Math.round(n * 100) / 100;
    return '$' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

function prizePoolInnerHtml() {
    const count = entries.length;
    const total = count * ENTRY_FEE;
    const splits = PRIZE_SPLITS.map(s => `
        <div class="pp-row">
            <span class="pp-place">${s.label}</span>
            <span class="pp-pct">${Math.round(s.pct * 100)}%</span>
            <span class="pp-amt">${formatMoney(total * s.pct)}</span>
        </div>
    `).join('');
    return `
        <div class="pp-top">
            <span class="pp-title">&#127942; Prize Pool</span>
            <span class="pp-total">${formatMoney(total)}</span>
        </div>
        <div class="pp-sub">${count} ${count === 1 ? 'entry' : 'entries'} &times; ${formatMoney(ENTRY_FEE)} each</div>
        <div class="pp-splits">${splits}</div>
    `;
}

function renderPrizePool() {
    const box = document.getElementById('prizePoolBox');
    if (!box) return;
    box.innerHTML = prizePoolInnerHtml();
}

function renderEntriesList() {
    const list = document.getElementById('entriesList');
    const count = document.getElementById('teamCount');
    count.textContent = entries.length;
    renderPrizePool();
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
                <button class="icon-btn" title="Edit name / team" onclick="openEditEntryModal('${escapeAttr(en.id)}')">&#9998;</button>
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
                        <span class="pick-count"><span class="admin-only">${pickCounts[team] || 0} picks · </span>${formatPts(teamRawPoints(team) * TIER_MULTIPLIERS[t])} pts</span>
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

    // --- Top scoring teams (by scaled points — what entrants actually score) ---
    const teamScores = Object.entries(results)
        .map(([team, _r]) => {
            const tier = tierOf(team);
            const raw = teamRawPoints(team);
            const mult = tier ? TIER_MULTIPLIERS[tier] : 1;
            return { team, raw, scaled: raw * mult, mult, tier };
        })
        .filter(t => t.raw > 0)
        .sort((a, b) => b.scaled - a.scaled)
        .slice(0, 8);

    // --- Tournament goals + straight-line projection vs the 300 bonus question ---
    const TOURNAMENT_MATCH_COUNT = 104;
    const finishedMatches = (matches || []).filter(m =>
        m.status === 'finished' &&
        Number.isFinite(m.scoreHome) && Number.isFinite(m.scoreAway));
    const matchesPlayed = finishedMatches.length;
    const totalGoals = finishedMatches.reduce((s, m) => s + m.scoreHome + m.scoreAway, 0);
    const avgGoalsPerGame = matchesPlayed > 0 ? totalGoals / matchesPlayed : 0;
    const projectedTotal = matchesPlayed > 0 ? Math.round(avgGoalsPerGame * TOURNAMENT_MATCH_COUNT) : 0;
    const pacePct = matchesPlayed > 0 ? Math.min(100, Math.round((projectedTotal / 300) * 100)) : 0;

    // --- Bonus consensus ---
    let goalsY = 0, goalsN = 0, europeanY = 0, europeanN = 0, ausY = 0, ausN = 0;
    for (const en of entries) {
        const a = en.bonusAnswers || {};
        if (a.goalsOver250 === 'Y') goalsY++;
        else if (a.goalsOver250 === 'N') goalsN++;
        if (a.winnerEuropean === 'Y') europeanY++;
        else if (a.winnerEuropean === 'N') europeanN++;
        if (a.australiaThroughGroup === 'Y') ausY++;
        else if (a.australiaThroughGroup === 'N') ausN++;
    }

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

        <div class="prize-pool-box prize-pool-box-analytics">
            ${prizePoolInnerHtml()}
        </div>

        <div class="analytics-card">
            <h3>Top scoring teams in the tournament</h3>
            ${teamScores.length === 0
                ? '<div class="empty-cell">No tournament results entered yet</div>'
                : teamScores.map(t => `
                    <div class="analytics-team-row">
                        <span class="analytics-team-name">
                            <span class="tier-pill tier-pill-${t.tier || 1}">G${t.tier || '?'}</span>
                            ${escapeHtml(t.team)}
                        </span>
                        <span class="score-boxes">
                            <span class="score-box raw" title="Raw points scored at the tournament">
                                <span class="score-box-label">Raw</span>
                                <span class="score-box-val">${t.raw}</span>
                            </span>
                            <span class="score-box scaled" title="Scaled points — raw × group multiplier (what entrants score for this pick)">
                                <span class="score-box-label">&times;${t.mult}</span>
                                <span class="score-box-val">${formatPts(t.scaled)}</span>
                            </span>
                        </span>
                    </div>
                `).join('')}
        </div>

        <div class="analytics-card">
            <h3>Tournament goals <span class="mult-mini">vs 300+ bonus question</span></h3>
            ${matchesPlayed === 0
                ? '<div class="empty-cell">No finished matches yet</div>'
                : `
                <div class="analytics-stat-row"><span>Goals so far</span><span class="stat-val">${totalGoals} <span class="stat-sub">(${matchesPlayed} / ${TOURNAMENT_MATCH_COUNT} games)</span></span></div>
                <div class="analytics-stat-row"><span>Average per game</span><span class="stat-val">${avgGoalsPerGame.toFixed(2)}</span></div>
                <div class="analytics-stat-row"><span>Projected total (straight-line)</span><span class="stat-val ${projectedTotal >= 300 ? 'stat-val-over' : 'stat-val-under'}">${projectedTotal}</span></div>
                <div class="goal-pace-bar" title="Projected progress towards 300">
                    <div class="goal-pace-fill ${projectedTotal >= 300 ? 'is-over' : ''}" style="width:${pacePct}%"></div>
                    <span class="goal-pace-marker" style="left:${(300 / Math.max(projectedTotal, 300, 1)) * 100}%" title="300 goals — bonus threshold"></span>
                </div>
                <p class="analytics-hint" style="text-align:center;margin-top:6px">
                    ${projectedTotal >= 300
                        ? `On pace for <strong>${projectedTotal} goals</strong> &mdash; <strong>${(projectedTotal - 300)}</strong> over the bonus threshold.`
                        : `Tracking <strong>${300 - projectedTotal} short</strong> of the 300-goal bonus threshold.`}
                </p>`}
        </div>

        <div class="analytics-card">
            <h3>Bonus question consensus</h3>
            <div class="analytics-stat-row"><span>300+ goals: Yes / No</span><span class="stat-val">${goalsY} / ${goalsN}</span></div>
            <div class="analytics-stat-row"><span>Continental European winner: Yes / No</span><span class="stat-val">${europeanY} / ${europeanN}</span></div>
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
            applyAnalyticsVisibility();
            // Bounce off any admin-only tabs the user might be on.
            if (activeTab === 'enter' || activeTab === 'emailguide') activateTab('sweep');
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
        applyAnalyticsVisibility();
        if (activeTab === 'matches') renderMatches();
    } catch (e) {
        document.getElementById('adminPwError').textContent = 'Verification failed: ' + e.message;
        document.getElementById('adminPwError').style.display = 'block';
    }
};

window.closeAdminModal = function () {
    document.getElementById('adminPwModal').classList.remove('active');
};

// =============================================================
// ADMIN: EMAIL GUIDE TAB (screenshot-ready welcome email)
// =============================================================
function renderEmailGuide() {
    const root = document.getElementById('emailGuideContent');
    if (!root) return;
    const siteUrl = window.location.origin || 'https://your-sweep-url';

    const groupCards = TIER_KEYS.map(t => `
        <div class="eg-group eg-group-${t}">
            <div class="eg-group-head">
                <span class="eg-group-title">Group ${t}</span>
                <span class="eg-group-mult">&times;${TIER_MULTIPLIERS[t]}</span>
                <span class="eg-group-count">${tiers[t].length} teams</span>
            </div>
            <ul class="eg-group-teams">
                ${tiers[t].map(team => `<li>${escapeHtml(team)}</li>`).join('')}
            </ul>
        </div>
    `).join('');

    const bonusList = BONUS_QUESTIONS.map((q, i) => `
        <li><span class="eg-bonus-num">${i + 1}.</span> ${escapeHtml(q.label)}</li>
    `).join('');

    // Worked example: 5 mock entries showing how scoring works
    const example = [
        {
            entrant: 'Matt Ansell', team: 'Hoof It Long',
            picks: [
                { team: tiers[1][0], raw: 12, mult: TIER_MULTIPLIERS[1], note: '3W + R32' },
                { team: tiers[2][0], raw: 12, mult: TIER_MULTIPLIERS[2], note: '3W + R32' },
                { team: tiers[3][0], raw: 7,  mult: TIER_MULTIPLIERS[3], note: '2W 1D' },
                { team: tiers[4][0], raw: 4,  mult: TIER_MULTIPLIERS[4], note: '1W 1D' },
                { team: tiers[5][0], raw: 3,  mult: TIER_MULTIPLIERS[5], note: '1W' },
            ],
            bonus: 6,
        },
        {
            entrant: 'Joe Bloggs', team: 'Park The Bus',
            picks: [
                { team: tiers[1][1], raw: 9, mult: TIER_MULTIPLIERS[1], note: '3W' },
                { team: tiers[2][1], raw: 6, mult: TIER_MULTIPLIERS[2], note: '2W' },
                { team: tiers[3][2], raw: 4, mult: TIER_MULTIPLIERS[3], note: '1W 1D' },
                { team: tiers[4][3], raw: 3, mult: TIER_MULTIPLIERS[4], note: '1W' },
                { team: tiers[5][2], raw: 1, mult: TIER_MULTIPLIERS[5], note: '1D' },
            ],
            bonus: 9,
        },
        {
            entrant: 'Jane Doe', team: 'Tiki Taka',
            picks: [
                { team: tiers[1][2], raw: 7, mult: TIER_MULTIPLIERS[1], note: '2W 1D' },
                { team: tiers[2][2], raw: 4, mult: TIER_MULTIPLIERS[2], note: '1W 1D' },
                { team: tiers[3][3], raw: 6, mult: TIER_MULTIPLIERS[3], note: '2W' },
                { team: tiers[4][4], raw: 3, mult: TIER_MULTIPLIERS[4], note: '1W' },
                { team: tiers[5][5], raw: 1, mult: TIER_MULTIPLIERS[5], note: '1D' },
            ],
            bonus: 3,
        },
        {
            entrant: 'Alex Smith', team: 'Counter Press',
            picks: [
                { team: tiers[1][3], raw: 6, mult: TIER_MULTIPLIERS[1], note: '2W' },
                { team: tiers[2][3], raw: 3, mult: TIER_MULTIPLIERS[2], note: '1W' },
                { team: tiers[3][4], raw: 4, mult: TIER_MULTIPLIERS[3], note: '1W 1D' },
                { team: tiers[4][5], raw: 1, mult: TIER_MULTIPLIERS[4], note: '1D' },
                { team: tiers[5][7], raw: 0, mult: TIER_MULTIPLIERS[5], note: 'no pts' },
            ],
            bonus: 6,
        },
        {
            entrant: 'Sam Taylor', team: 'Top Bins',
            picks: [
                { team: tiers[1][4], raw: 4, mult: TIER_MULTIPLIERS[1], note: '1W 1D' },
                { team: tiers[2][4], raw: 1, mult: TIER_MULTIPLIERS[2], note: '1D' },
                { team: tiers[3][6], raw: 3, mult: TIER_MULTIPLIERS[3], note: '1W' },
                { team: tiers[4][8], raw: 0, mult: TIER_MULTIPLIERS[4], note: 'no pts' },
                { team: tiers[5][10], raw: 0, mult: TIER_MULTIPLIERS[5], note: 'no pts' },
            ],
            bonus: 0,
        },
    ];
    const exampleRows = example.map(e => {
        const totals = e.picks.map(p => p.raw * p.mult);
        const picksTotal = totals.reduce((s, v) => s + v, 0);
        const grand = picksTotal + e.bonus;
        return { ...e, totals, picksTotal, grand };
    }).sort((a, b) => b.grand - a.grand || b.bonus - a.bonus);
    const exampleTable = exampleRows.map((e, i) => {
        const rankClass = i === 0 ? 'eg-rank-1' : i === 1 ? 'eg-rank-2' : i === 2 ? 'eg-rank-3' : '';
        const pickCells = e.picks.map((p, idx) => {
            const scaled = e.totals[idx];
            return `<td class="eg-pick-cell">
                <div class="eg-pick-team">${escapeHtml(p.team)}</div>
                <div class="eg-pick-calc">${p.raw} &times; ${p.mult} = <strong>${formatPts(scaled)}</strong></div>
                <div class="eg-pick-note">${p.note}</div>
            </td>`;
        }).join('');
        return `<tr class="${rankClass}">
            <td class="eg-rank">${i + 1}</td>
            <td class="eg-entrant">
                <div class="eg-team-name">${escapeHtml(e.team)}</div>
                <div class="eg-entrant-name">${escapeHtml(e.entrant)}</div>
            </td>
            ${pickCells}
            <td class="eg-bonus">+${e.bonus}</td>
            <td class="eg-total">${formatPts(e.grand)}</td>
        </tr>`;
    }).join('');

    root.innerHTML = `
        <div class="eg-page">
            <div class="eg-header">
                <h1>🏆 World Cup 2026 Sweepstake</h1>
                <p class="eg-subhead">Pick 5 teams · score across the tournament · highest total wins</p>
                <p class="eg-url">Enter at <strong>${escapeHtml(siteUrl)}</strong></p>
            </div>

            <div class="eg-row">
                <div class="eg-card eg-steps-card">
                    <h2>How to enter</h2>
                    <ol class="eg-steps">
                        <li>Open <strong>${escapeHtml(siteUrl)}</strong></li>
                        <li>Click the <strong>Enter Team</strong> tab</li>
                        <li>Enter your <strong>name</strong> and a <strong>team name</strong></li>
                        <li>Pick <strong>one team</strong> from each of the 5 groups</li>
                        <li>Answer the <strong>3 bonus questions</strong> (Yes / No)</li>
                        <li>Click <strong>Submit Team</strong> — done!</li>
                    </ol>
                </div>
                <div class="eg-card eg-bonus-card">
                    <h2>Bonus questions <span class="eg-pill">+${BONUS_POINTS_PER_CORRECT} pts each</span></h2>
                    <ol class="eg-bonus-list">${bonusList}</ol>
                </div>
                <div class="eg-card eg-scoring-card">
                    <h2>Scoring</h2>
                    <ul class="eg-scoring">
                        <li><strong>3 pts</strong> per win</li>
                        <li><strong>1 pt</strong> per draw</li>
                        <li><strong>0 pts</strong> per loss</li>
                        <li>Each team's total &times; its <strong>group multiplier</strong></li>
                        <li>Total = sum of all 5 picks + bonus points</li>
                        <li><strong>Tie-breaker:</strong> bonus points decide</li>
                    </ul>
                </div>
            </div>

            <div class="eg-section">
                <h2>The 5 groups</h2>
                <p class="eg-section-hint">Pick one team from each group. Smaller groups have stronger favourites and smaller multipliers; bigger groups are riskier but score much more per point.</p>
                <div class="eg-groups-grid">${groupCards}</div>
            </div>

            <div class="eg-section">
                <h2>Worked example — how the leaderboard looks</h2>
                <p class="eg-section-hint">Sample after a few rounds. Each pick cell shows the team, the raw points &times; group multiplier, and the result. Bonus column is the 3 bonus answers. Highest grand total wins.</p>
                <div class="eg-leaderboard-wrap">
                    <table class="eg-leaderboard">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Team / Entrant</th>
                                ${TIER_KEYS.map(t => `<th>G${t} (&times;${TIER_MULTIPLIERS[t]})</th>`).join('')}
                                <th>Bonus</th>
                                <th class="eg-total-head">Total</th>
                            </tr>
                        </thead>
                        <tbody>${exampleTable}</tbody>
                    </table>
                </div>
                <p class="eg-footnote">Example only — actual leaderboard updates live as match results are entered.</p>
            </div>

            <div class="eg-footer">
                <strong>Good luck — and may the best (luckiest) pick win.</strong>
            </div>
        </div>
    `;
}

// =============================================================
// RENDER: MATCHES TAB
// =============================================================
// Matches data lives in `matches` (loaded from /api/state). The ESPN poller
// on the server bootstraps it on first run and refreshes scores during
// match windows. Admin can override any match score via the editor below.

let matchesFilter = 'all';

function setupMatchesFilters() {
    document.querySelectorAll('#matchesFilters .match-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            matchesFilter = btn.dataset.filter;
            document.querySelectorAll('#matchesFilters .match-chip').forEach(b => {
                b.classList.toggle('active', b.dataset.filter === matchesFilter);
            });
            renderMatches();
        });
    });
}

function formatLocalTime(utcStr, timeZone, locale) {
    try {
        const d = new Date(utcStr);
        return new Intl.DateTimeFormat(locale, {
            timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(d);
    } catch (e) { return '--:--'; }
}

function formatHeadingDate(utcStr) {
    const d = new Date(utcStr);
    return new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney',
        weekday: 'long', day: 'numeric', month: 'long',
    }).format(d);
}

function sydneyDateKey(utcStr) {
    const d = new Date(utcStr);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Australia/Sydney',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${day}`;
}

function stageLabel(m) {
    if (m.stage === 'group') return `Group ${m.group || '—'}`;
    return ({ r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-final',
              sf: 'Semi-final', final: 'Final', '3rd': '3rd-place Playoff' })[m.stage] || m.stage;
}

function matchPasses(m, filter, todayKey) {
    if (filter === 'all') return true;
    const k = sydneyDateKey(m.kickoffUTC);
    if (filter === 'today') return k === todayKey;
    if (filter === 'upcoming') return m.status !== 'finished';
    if (filter === 'finished') return m.status === 'finished';
    return true;
}

function renderMatches(scrollToToday = false) {
    const root = document.getElementById('matchesContent');
    if (!root) return;

    const all = (matches || []).slice().sort((a, b) => (a.kickoffUTC || '').localeCompare(b.kickoffUTC || ''));
    const todayKey = sydneyDateKey(new Date().toISOString());
    const filtered = all.filter(m => matchPasses(m, matchesFilter, todayKey));

    if (filtered.length === 0) {
        const hint = matches.length === 0
            ? `<p class="empty-cell" style="padding:20px">No matches loaded yet. The server pulls fixtures from ESPN every 30 minutes during match windows.</p>`
            : `<p class="empty-cell" style="padding:20px">No matches in this view.</p>`;
        root.innerHTML = hint + adminMatchesToolbar();
        return;
    }

    // Group by Sydney calendar date
    const groups = new Map();
    for (const m of filtered) {
        const k = sydneyDateKey(m.kickoffUTC);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m);
    }

    const dayBlocks = [...groups.entries()].map(([dateKey, list]) => {
        const heading = formatHeadingDate(list[0].kickoffUTC);
        const isToday = dateKey === todayKey;
        const rows = list.map(matchCardHtml).join('');
        return `
            <div class="match-day">
                <div class="match-day-head">
                    ${isToday ? '<span class="match-today-pill">Today</span>' : ''}
                    <span class="match-day-title">${escapeHtml(heading)}</span>
                    <span class="match-day-count">${list.length} match${list.length === 1 ? '' : 'es'}</span>
                </div>
                ${rows}
            </div>
        `;
    }).join('');

    root.innerHTML = adminMatchesToolbar() + dayBlocks;
    attachMatchAdminHandlers();

    // On initial open of the tab, jump to today's matches so the user isn't
    // staring at Mexico vs South Africa from match-day one. Falls back to the
    // first upcoming day when nothing's scheduled for today (Sydney time).
    if (scrollToToday) {
        setTimeout(() => {
            let target = root.querySelector('.match-today-pill');
            if (target) target = target.closest('.match-day');
            if (!target) {
                const upcomingCard = Array.from(root.querySelectorAll('.match-card'))
                    .find((c) => !c.classList.contains('is-final'));
                if (upcomingCard) target = upcomingCard.closest('.match-day');
            }
            if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
        }, 0);
    }
}

function matchCardHtml(m) {
    const sydTime = m.kickoffUTC ? formatLocalTime(m.kickoffUTC, 'Australia/Sydney', 'en-AU') : '--:--';
    const lonTime = m.kickoffUTC ? formatLocalTime(m.kickoffUTC, 'Europe/London', 'en-GB') : '--:--';
    const finished = m.status === 'finished';
    const live = m.status === 'live';
    const homeWin = finished && m.scoreHome > m.scoreAway;
    const awayWin = finished && m.scoreAway > m.scoreHome;
    const draw = finished && m.scoreHome === m.scoreAway;
    const totalGoals = finished ? (m.scoreHome + m.scoreAway) : null;
    const statusPill = finished
        ? `<span class="match-status match-status-final">Final</span>`
        : live
            ? `<span class="match-status match-status-live">Live</span>`
            : `<span class="match-status match-status-sched">Scheduled</span>`;
    const goalsBadge = finished
        ? `<span class="match-goals">${totalGoals} goal${totalGoals === 1 ? '' : 's'}</span>`
        : '';
    const scoreCell = finished || live
        ? `<span class="match-score">${m.scoreHome ?? 0} – ${m.scoreAway ?? 0}</span>`
        : `<span class="match-vs">vs</span>`;
    const overridePill = m.manuallyOverridden
        ? `<span class="match-override-pill" title="Manually entered by admin. Auto-poll won't overwrite this score.">Admin</span>`
        : '';
    const editBtn = `<button class="match-edit-btn admin-only" data-match-edit="${escapeAttr(m.id)}" title="Enter or correct the score">${finished ? 'Edit' : 'Set score'}</button>`;
    return `
        <div class="match-card ${finished ? 'is-final' : ''}" data-match-id="${escapeAttr(m.id)}">
            <div class="match-meta-row">
                ${statusPill}
                <span class="match-stage">${escapeHtml(stageLabel(m))}</span>
                ${overridePill}
                ${goalsBadge}
            </div>
            <div class="match-teams">
                <div class="match-team ${homeWin ? 'is-winner' : ''} ${draw ? 'is-draw' : ''}">
                    <span class="match-team-name">${escapeHtml(m.home)}</span>
                    ${homeWin ? '<span class="match-winner-pill">Winner</span>' : ''}
                </div>
                <div class="match-score-cell">${scoreCell}</div>
                <div class="match-team ${awayWin ? 'is-winner' : ''} ${draw ? 'is-draw' : ''}">
                    <span class="match-team-name">${escapeHtml(m.away)}</span>
                    ${awayWin ? '<span class="match-winner-pill">Winner</span>' : ''}
                </div>
            </div>
            <div class="match-footer">
                <div class="match-times">
                    <span class="match-tz"><strong>SYD</strong> ${sydTime}</span>
                    <span class="match-tz"><strong>LON</strong> ${lonTime}</span>
                </div>
                <div class="match-venue">${escapeHtml(m.venue || '')}</div>
                ${editBtn}
            </div>
        </div>
    `;
}

function adminMatchesToolbar() {
    return `
        <div class="match-admin-toolbar admin-only">
            <button class="btn btn-small" id="matchesRefreshBtn" title="Pull fixtures + scores from ESPN now">&#8635; Refresh from ESPN</button>
            <span class="match-admin-hint">Scores auto-update every 30 min during match windows. Admin-edited scores are kept on subsequent polls.</span>
        </div>
    `;
}

function attachMatchAdminHandlers() {
    document.querySelectorAll('[data-match-edit]').forEach((btn) => {
        btn.addEventListener('click', () => openMatchScoreEditor(btn.dataset.matchEdit));
    });
    const refreshBtn = document.getElementById('matchesRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshMatchesFromEspn);
}

async function refreshMatchesFromEspn() {
    const btn = document.getElementById('matchesRefreshBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
        const res = await fetch('/api/admin/matches/refresh', { method: 'POST', headers: adminHeaders() });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        await loadFromServer();
        renderMatches();
        flashToast(out.ok ? `Refreshed ${out.fetched} matches.` : (out.skipped || 'Nothing to refresh.'));
    } catch (e) {
        alert('Refresh failed: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh from ESPN'; }
    }
}

function openMatchScoreEditor(matchId) {
    const m = matches.find((x) => x.id === matchId);
    if (!m) return;
    const modal = document.getElementById('matchScoreModal');
    if (!modal) return;
    document.getElementById('matchScoreModalTitle').textContent = `${m.home} vs ${m.away}`;
    document.getElementById('matchScoreModalMeta').textContent =
        `${stageLabel(m)} · ${m.kickoffUTC ? formatHeadingDate(m.kickoffUTC) + ', ' + formatLocalTime(m.kickoffUTC, 'Australia/Sydney', 'en-AU') + ' SYD' : ''}`;
    document.getElementById('matchScoreHomeLabel').textContent = m.home;
    document.getElementById('matchScoreAwayLabel').textContent = m.away;
    document.getElementById('matchScoreHomeInput').value = m.scoreHome ?? '';
    document.getElementById('matchScoreAwayInput').value = m.scoreAway ?? '';
    document.getElementById('matchScoreModal').dataset.matchId = matchId;
    const clearBtn = document.getElementById('matchScoreClearBtn');
    clearBtn.style.display = m.manuallyOverridden ? 'inline-block' : 'none';
    modal.classList.add('active');
}

window.closeMatchScoreModal = function () {
    document.getElementById('matchScoreModal').classList.remove('active');
};

window.saveMatchScore = async function () {
    const modal = document.getElementById('matchScoreModal');
    const id = modal.dataset.matchId;
    const scoreHome = parseInt(document.getElementById('matchScoreHomeInput').value, 10);
    const scoreAway = parseInt(document.getElementById('matchScoreAwayInput').value, 10);
    if (!Number.isFinite(scoreHome) || !Number.isFinite(scoreAway) || scoreHome < 0 || scoreAway < 0) {
        alert('Enter both scores as non-negative numbers.');
        return;
    }
    try {
        const res = await fetch(`/api/admin/matches/${encodeURIComponent(id)}/score`, {
            method: 'POST',
            headers: adminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ scoreHome, scoreAway }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        await loadFromServer();
        closeMatchScoreModal();
        renderMatches();
        flashToast('Score saved.');
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
};

window.clearMatchOverride = async function () {
    const modal = document.getElementById('matchScoreModal');
    const id = modal.dataset.matchId;
    if (!confirm('Clear admin override? The auto-poller will overwrite this score next time it runs.')) return;
    try {
        const res = await fetch(`/api/admin/matches/${encodeURIComponent(id)}/score`, {
            method: 'POST',
            headers: adminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ clearOverride: true }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await loadFromServer();
        closeMatchScoreModal();
        renderMatches();
        flashToast('Override cleared.');
    } catch (e) {
        alert('Failed: ' + e.message);
    }
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
            // Flag this team as admin-authoritative so the ESPN-driven derive
            // step on the server won't overwrite the manual entry.
            manuallyOverridden: true,
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
window.resetGroupsToDefault = function () {
    if (!adminMode) { alert('Admin mode required.'); return; }
    const sizes = TIER_KEYS.map(t => `G${t}: ${DEFAULT_TIERS[t].length}`).join(', ');
    if (!confirm(`Reset the group roster to the canonical layout (${sizes})?\n\nThis overwrites the server-side tiers. Existing entries and results stay.`)) return;
    tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
    persistAll();
    populatePickSelects();
    if (activeTab === 'tiers') renderTiers();
    if (activeTab === 'sweep') renderLeaderboard();
    flashToast('Groups reset to defaults.');
};

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
    bonus = load(STORAGE.bonus, { goalsOver250: '', winnerEuropean: '', australiaThroughGroup: '' });
    settings = load(STORAGE.settings, {});

    setupTabs();
    setupAdmin();
    setupEntryForm();
    setupResultsEditor();
    setupSnapshotPanel();
    setupMatchesFilters();
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
    const searchInput = document.getElementById('leaderboardSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            leaderboardSearch = e.target.value;
            renderLeaderboard();
        });
    }
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
    setupAnalyticsVisibilityToggle();
    applyAnalyticsVisibility();

    // Then refresh from server
    if (useServerStorage()) {
        const ok = await loadFromServer();
        if (ok) {
            populatePickSelects();
            renderLeaderboard();
            renderEntriesList();
            applyAnalyticsVisibility();
        }
    }

    document.getElementById('footerUpdated').textContent = new Date().toLocaleString();
}

function setupAnalyticsVisibilityToggle() {
    const cb = document.getElementById('analyticsVisibleToggle');
    if (!cb) return;
    cb.addEventListener('change', () => {
        if (!adminMode) { alert('Admin mode required.'); cb.checked = !cb.checked; return; }
        settings.analyticsVisible = cb.checked;
        save(STORAGE.settings, settings);
        persistToServer({ settings });
        applyAnalyticsVisibility();
        flashToast(cb.checked ? 'Analytics tab shown to entrants.' : 'Analytics tab hidden from entrants.');
    });
}

document.addEventListener('DOMContentLoaded', init);
