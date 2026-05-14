// =============================================================
// WORLD CUP 2026 SWEEPSTAKE
// =============================================================

// =============================================================
// CONFIGURATION
// =============================================================
const STATE_API = '/api/state';
const STORAGE = {
    entries:  'wcSweep_entries',
    results:  'wcSweep_results',
    bonus:    'wcSweep_bonus',
    settings: 'wcSweep_settings',
};
const STORAGE_BACKUP_SUFFIX = '_backup';
const ADMIN_PASSWORD = 'fifa2026';

const TIER_MULTIPLIERS = { 1: 1, 2: 1.5, 3: 2, 4: 4 };
const TIER_LABELS = { 1: 'Tier 1 (×1)', 2: 'Tier 2 (×1.5)', 3: 'Tier 3 (×2)', 4: 'Tier 4 (×4)' };

// 48-team roster from ESPN/DraftKings outright odds, early April 2026.
const DEFAULT_TIERS = {
    1: ['Spain', 'France', 'England', 'Brazil'],
    2: ['Argentina', 'Portugal', 'Germany', 'Netherlands', 'Norway', 'Belgium'],
    3: ['Colombia', 'Japan', 'Morocco', 'USA', 'Uruguay', 'Turkey', 'Mexico', 'Ecuador',
        'Sweden', 'Croatia', 'Switzerland', 'Austria', 'Senegal', 'Czechia'],
    4: ['Canada', 'Paraguay', 'Scotland', 'Ivory Coast', 'Bosnia', 'Egypt', 'Iran', 'Algeria',
        'South Korea', 'Ghana', 'Australia', 'Tunisia', 'DR Congo', 'South Africa',
        'Saudi Arabia', 'Panama', 'Qatar', 'New Zealand', 'Iraq', 'Cape Verde',
        'Uzbekistan', 'Jordan', 'Haiti', 'Curacao'],
};

const KO_ROUNDS = [
    { key: 'r32', label: 'R32' },
    { key: 'r16', label: 'R16' },
    { key: 'qf',  label: 'QF'  },
    { key: 'sf',  label: 'SF'  },
    { key: 'final', label: 'F' },
];

const BONUS_QUESTIONS = [
    { key: 'goalsOver250', label: 'More than 250 goals in the tournament?', type: 'yn', short: '>250 goals' },
    { key: 'penaltyShootouts', label: 'Penalty shootouts in the knockout stage (16 games)', type: 'num', short: 'Shootouts' },
    { key: 'redCards', label: 'Total red cards in the tournament', type: 'num', short: 'Red cards' },
];
const BONUS_POINTS_PER_CORRECT = 5;

// =============================================================
// APPLICATION STATE
// =============================================================
let tiers          = JSON.parse(JSON.stringify(DEFAULT_TIERS));
let entries        = [];
let results        = {};   // teamName -> { groupW, groupD, groupL, r32, r16, qf, sf, final, thirdPlace }
let bonus          = { goalsOver250: '', penaltyShootouts: '', redCards: '' };
let settings       = {};
let activeTab      = 'sweep';
let adminMode      = false;

function useServerStorage() {
    return window.location.protocol !== 'file:';
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
                tiers = {
                    1: state.tiers['1'] || state.tiers[1] || DEFAULT_TIERS[1],
                    2: state.tiers['2'] || state.tiers[2] || DEFAULT_TIERS[2],
                    3: state.tiers['3'] || state.tiers[3] || DEFAULT_TIERS[3],
                    4: state.tiers['4'] || state.tiers[4] || DEFAULT_TIERS[4],
                };
            }
        }
        entries = Array.isArray(state.entries) ? normalizeEntries(state.entries) : [];
        results = isObject(state.results) ? state.results : {};
        bonus = isObject(state.bonus) ? {
            goalsOver250: state.bonus.goalsOver250 || '',
            penaltyShootouts: state.bonus.penaltyShootouts ?? '',
            redCards: state.bonus.redCards ?? '',
        } : { goalsOver250: '', penaltyShootouts: '', redCards: '' };
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(partial),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.warn('Server persist failed:', e);
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
    return arr.map(en => ({
        id: en.id || cryptoRandomId(),
        entrant: (en.entrant || '').trim(),
        team: (en.team || '').trim(),
        picks: Array.isArray(en.picks) ? en.picks.slice(0, 4).map(p => `${p || ''}`) : ['', '', '', ''],
        bonusAnswers: isObject(en.bonusAnswers) ? {
            goalsOver250: en.bonusAnswers.goalsOver250 || '',
            penaltyShootouts: en.bonusAnswers.penaltyShootouts ?? '',
            redCards: en.bonusAnswers.redCards ?? '',
        } : { goalsOver250: '', penaltyShootouts: '', redCards: '' },
        createdAt: en.createdAt || Date.now(),
    }));
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
    if (r.thirdPlace) pts += 1;
    return pts;
}

function tierOf(teamName) {
    for (const t of [1, 2, 3, 4]) if (tiers[t].includes(teamName)) return t;
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
    if (bonus.redCards !== '' && a.redCards !== '' && a.redCards != null
        && Number(a.redCards) === Number(bonus.redCards)) pts += BONUS_POINTS_PER_CORRECT;
    return pts;
}

function entryTotal(entry) {
    let total = 0;
    for (let i = 0; i < 4; i++) {
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
    if (tab === 'detail') renderDetail();
    if (tab === 'analytics') renderAnalytics();
}

// =============================================================
// ENTRY FORM
// =============================================================
function populatePickSelects() {
    for (let t = 1; t <= 4; t++) {
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
    form.addEventListener('submit', e => {
        e.preventDefault();
        const entrant = document.getElementById('entrantName').value.trim();
        const team = document.getElementById('teamName').value.trim();
        const picks = [
            document.getElementById('pickTier1').value,
            document.getElementById('pickTier2').value,
            document.getElementById('pickTier3').value,
            document.getElementById('pickTier4').value,
        ];
        if (!entrant || !team || picks.some(p => !p)) {
            alert('Please complete your name, team name, and all four tier picks.');
            return;
        }
        const bonusAnswers = {
            goalsOver250: document.getElementById('bonusGoals').value,
            penaltyShootouts: document.getElementById('bonusShootouts').value,
            redCards: document.getElementById('bonusReds').value,
        };
        if (!bonusAnswers.goalsOver250 || bonusAnswers.penaltyShootouts === '' || bonusAnswers.redCards === '') {
            alert('Please answer all three bonus questions.');
            return;
        }
        entries.push({
            id: cryptoRandomId(),
            entrant, team, picks, bonusAnswers,
            createdAt: Date.now(),
        });
        persistAll();
        form.reset();
        renderEntriesList();
        renderLeaderboard();
        flashToast(`Entry "${team}" submitted.`);
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
            <th>T1 (×1)</th>
            <th>T2 (×1.5)</th>
            <th>T3 (×2)</th>
            <th>T4 (×4)</th>
            <th class="bonus-cell">Bonus</th>
            <th style="text-align:right">Total</th>
        </tr>
    `;

    if (entries.length === 0) {
        body.innerHTML = `<tr><td colspan="8" class="empty-cell">No entries yet. Go to "Enter Team" to add teams.</td></tr>`;
        return;
    }

    const ranked = entries.map(en => ({ en, total: entryTotal(en) }))
        .sort((a, b) => b.total - a.total);

    body.innerHTML = ranked.map(({ en, total }, idx) => {
        const rankClass = idx === 0 ? 'r1' : idx === 1 ? 'r2' : idx === 2 ? 'r3' : '';
        return `
            <tr>
                <td class="rank ${rankClass}">${idx + 1}</td>
                <td>
                    <div class="team-name">${escapeHtml(en.team)}</div>
                    <div class="entrant-name">${escapeHtml(en.entrant)}</div>
                </td>
                ${[0, 1, 2, 3].map(i => pickCell(en.picks[i], i + 1)).join('')}
                <td class="bonus-cell">${bonusPointsFor(en)}</td>
                <td class="total">${formatPts(total)}</td>
            </tr>
        `;
    }).join('');
}

function pickCell(teamName, tier) {
    if (!teamName) return `<td class="pick-cell"><span class="pick-team">—</span></td>`;
    const raw = teamRawPoints(teamName);
    const scaled = raw * TIER_MULTIPLIERS[tier];
    return `<td class="pick-cell">
        <div class="pick-team">${escapeHtml(teamName)}</div>
        <div class="pick-pts">${raw} × ${TIER_MULTIPLIERS[tier]} = ${formatPts(scaled)}</div>
    </td>`;
}

function formatPts(n) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
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
    grid.innerHTML = [1, 2, 3, 4].map(t => `
        <div class="tier-card tier-${t}">
            <div class="tier-card-header">
                <span>Tier ${t} — ${tiers[t].length} teams</span>
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
// RENDER: DETAIL TAB
// =============================================================
function renderDetail() {
    const root = document.getElementById('detailContent');
    if (entries.length === 0) {
        root.innerHTML = `<p class="empty-cell" style="padding:20px">No entries yet.</p>`;
        return;
    }
    const ranked = entries.map(en => ({ en, total: entryTotal(en) }))
        .sort((a, b) => b.total - a.total);

    root.innerHTML = ranked.map(({ en, total }, idx) => {
        const rows = [0, 1, 2, 3].map(i => {
            const team = en.picks[i];
            const tier = i + 1;
            const raw = teamRawPoints(team);
            const r = teamRecord(team);
            const koWins = KO_ROUNDS.filter(rd => r[rd.key]).map(rd => rd.label).join(', ') || '—';
            const groupRec = `${r.groupW || 0}W ${r.groupD || 0}D ${r.groupL || 0}L`;
            const scaled = raw * TIER_MULTIPLIERS[tier];
            return `<tr>
                <td>Tier ${tier} (×${TIER_MULTIPLIERS[tier]})</td>
                <td><strong>${escapeHtml(team || '—')}</strong></td>
                <td>${groupRec}</td>
                <td>${koWins}${r.thirdPlace ? ' + 3rd' : ''}</td>
                <td>${raw}</td>
                <td class="pick-total">${formatPts(scaled)}</td>
            </tr>`;
        }).join('');

        const bonusTags = BONUS_QUESTIONS.map(q => {
            const guess = en.bonusAnswers?.[q.key];
            const correct = bonus[q.key];
            let cls = 'bonus-tag';
            if (correct !== '' && correct != null && guess !== '' && guess != null) {
                cls += (String(guess) === String(correct)) ? ' correct' : ' wrong';
            }
            return `<span class="${cls}">${q.short}: ${escapeHtml(String(guess ?? '—'))}</span>`;
        }).join('');

        return `<div class="detail-entry-card">
            <div class="detail-entry-head">
                <div class="name-block">
                    <div class="team">${escapeHtml(en.team)}</div>
                    <div class="entrant">${escapeHtml(en.entrant)} · rank #${idx + 1}</div>
                </div>
                <div class="total-block">${formatPts(total)} pts</div>
            </div>
            <table class="detail-picks-table">
                <thead>
                    <tr><th>Tier</th><th>Team</th><th>Group</th><th>KO Wins</th><th>Raw</th><th style="text-align:right">Scaled</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="detail-bonus-row">
                ${bonusTags}
                <span class="bonus-tag" style="margin-left:auto;font-weight:700;color:var(--wc-pitch)">Bonus total: +${bonusPointsFor(en)}</span>
            </div>
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
    const tierCounts = { 1: {}, 2: {}, 3: {}, 4: {} };
    for (const en of entries) {
        for (let i = 0; i < 4; i++) {
            const team = en.picks[i];
            if (!team) continue;
            const t = i + 1;
            tierCounts[t][team] = (tierCounts[t][team] || 0) + 1;
        }
    }
    const totals = entries.map(en => entryTotal(en));
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const max = Math.max(...totals);
    const min = Math.min(...totals);

    const tierBlocks = [1, 2, 3, 4].map(t => {
        const sorted = Object.entries(tierCounts[t]).sort((a, b) => b[1] - a[1]);
        const top = sorted.slice(0, 6);
        return `<div class="analytics-card">
            <h3>Tier ${t} most-picked</h3>
            ${top.length === 0 ? '<div class="empty-cell">No picks</div>' :
                top.map(([team, n]) => `<div class="analytics-stat-row"><span>${escapeHtml(team)}</span><span class="stat-val">${n}</span></div>`).join('')}
        </div>`;
    }).join('');

    root.innerHTML = `<div class="analytics-grid">
        <div class="analytics-card">
            <h3>Field overview</h3>
            <div class="analytics-stat-row"><span>Total entries</span><span class="stat-val">${entries.length}</span></div>
            <div class="analytics-stat-row"><span>Average score</span><span class="stat-val">${formatPts(avg)}</span></div>
            <div class="analytics-stat-row"><span>Top score</span><span class="stat-val">${formatPts(max)}</span></div>
            <div class="analytics-stat-row"><span>Lowest score</span><span class="stat-val">${formatPts(min)}</span></div>
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

window.confirmAdminPassword = function () {
    const val = document.getElementById('adminPwInput').value;
    if (val === ADMIN_PASSWORD) {
        adminMode = true;
        document.body.classList.add('admin-active');
        document.getElementById('adminToggle').classList.add('active');
        closeAdminModal();
        renderEntriesList();
        renderBonusAdminForm();
    } else {
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
    for (let t = 1; t <= 4; t++) {
        for (const team of tiers[t]) {
            const r = teamRecord(team);
            rows.push(`
                <div class="result-row tier-${t}" data-team="${escapeAttr(team)}">
                    <div class="team-name">${escapeHtml(team)}<span class="tier-tag">T${t}</span></div>
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
    if (r.thirdPlace) pts += 1;
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
    const rows = [['Tier', 'Multiplier', 'Team']];
    for (let t = 1; t <= 4; t++) {
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
