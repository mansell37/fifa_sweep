# World Cup 2026 Sweepstake (Railway Ready)

Companion sweep app for the FIFA World Cup 2026. Same architecture as the Masters sweepstake — static frontend + tiny Express server, deployed to Railway from GitHub with auto-deploys.

## Format

- 48 teams across 4 tiers, ranked by outright odds (ESPN/DraftKings, early April 2026)
- Each entrant picks **one team per tier**
- Tier multipliers: **T1 ×1, T2 ×1.5, T3 ×2, T4 ×4**

### Scoring per team
- Group stage: 3 win / 1 draw / 0 loss (max 9)
- Knockout wins: +3 per round (R32, R16, QF, SF, Final) — max 15
- 3rd-place playoff win: +1
- Max raw per team: **24 pts × tier multiplier**

### Bonus questions (+5 each, exact match)
1. More than 250 goals in the tournament? (Y/N)
2. Number of penalty shootouts in the knockout stage (16 games)
3. Number of red cards in the tournament

Max bonus: 15 pts.

## Local run

```bash
npm install
npm start
# open http://localhost:3000
```

## Admin

- Default password: `admin2026` (change `ADMIN_PASSWORD` in `js/app.js` before going live)
- Admin mode reveals: bonus-answer entry, team-results editor, backup/restore, delete-entry buttons

## Railway deploy

1. Push this folder to a new GitHub repo (e.g. `world-cup-2026`).
2. In Railway: **New Project → Deploy from GitHub Repo** → select the repo.
3. Railway auto-detects Node and uses `npm install` + `npm start`.
4. Attach a Railway volume mounted at `/app/data` so entries survive redeploys (already declared in `railway.toml`).
5. (Optional) Set `DATA_SEED` env var with a JSON blob to seed/recover state.

## Endpoints

- `GET  /health` → `{ ok: true }`
- `GET  /api/state` → full state object
- `PUT  /api/state` → partial update (`tiers`, `entries`, `results`, `bonus`, `settings`)

## Persistence

- Source of truth: `data/state.json` on the server (Railway volume)
- Frontend keeps a localStorage mirror for resilience
- Backup/restore JSON is available in the admin panel
