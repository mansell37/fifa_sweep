# World Cup 2026 Sweepstake (Railway Ready)

Companion sweep app for the FIFA World Cup 2026. Static frontend + tiny Express server, deployed to Railway from GitHub with auto-deploys.

## Format

- 48 teams across 4 groups, ranked by outright odds (ESPN/DraftKings, early April 2026)
- Each entrant picks **one team per group**
- Group multipliers: **G1 ×1, G2 ×1.5, G3 ×2, G4 ×4**

### Scoring per team
- **3 pts** per win (group stage, knockouts, and 3rd-place playoff)
- **1 pt** per group-stage draw
- Max raw per team: **24 pts × group multiplier**

### Bonus questions (+5 each, exact match)
1. More than 290 goals in the tournament? (104 matches) (Y/N)
2. Number of penalty shootouts in the knockout stage
3. Number of red cards in the whole tournament

Max bonus: 15 pts.

## Local run

```bash
npm install
npm start
# open http://localhost:3000
```

## Admin

- Default password: `fifa2026` (change `ADMIN_PASSWORD` in `js/app.js` before going live)
- Admin mode reveals: bonus-answer entry, team-results editor, manual backup/restore, server auto-snapshots panel, delete-entry buttons

## Railway deploy

1. Push this folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub Repo** → select the repo.
3. Railway auto-detects Node and uses `npm install` + `npm start`.
4. Attach a Railway volume mounted at `/app/data` so entries survive redeploys (already declared in `railway.toml`).
5. Set environment variables (see below) if you want email notifications.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RESEND_API_KEY` | optional | _empty_ | Enables email notification on each new entry. Get from [resend.com](https://resend.com). |
| `BACKUP_EMAIL` | optional | `matt.ansell1@nab.com.au` | Comma-separated recipient(s). |
| `BACKUP_FROM_EMAIL` | optional | `WC Sweep <onboarding@resend.dev>` | From address. The default works without verifying a domain, but Resend will only deliver to the email you signed up with. To send to other addresses, verify your own domain in Resend and update this to e.g. `WC Sweep <noreply@yourdomain.com>`. |
| `DATA_SEED` | optional | _empty_ | One-time JSON blob to seed initial state. Used only when no `state.json` exists. |

## Endpoints

- `GET  /health` → `{ ok: true }`
- `GET  /api/state` → full state object
- `PUT  /api/state` → partial update (`tiers`, `entries`, `results`, `bonus`, `settings`)
- `GET  /api/backups` → list of server auto-snapshots
- `GET  /api/backups/:filename` → download a specific snapshot
- `POST /api/backups/restore/:filename` → restore from a snapshot

## Data safety

Three layers of backup:

1. **`data/state.json` on the Railway volume** — source of truth, survives redeploys.
2. **Auto-snapshots in `data/backups/`** — every state change writes a timestamped JSON file. Most recent 50 kept. Browse/download/restore from the admin "Server Auto-Snapshots" panel.
3. **Email-on-new-entry** — if `RESEND_API_KEY` is set, every new entry triggers an email with entry details + the full state JSON attached. Your inbox becomes a permanent off-site archive.

Manual backup/restore is also available in the admin panel — download a copy any time, restore from a local JSON file.
