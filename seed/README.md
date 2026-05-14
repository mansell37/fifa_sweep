# Seed files

Two backup files for the admin "Restore from Backup" flow.

## How to load

1. Download the file you want from this folder (use the "Download raw file" button on GitHub, or `git pull` if you have the repo cloned locally).
2. Open the sweep app, click **Admin** in the header, enter the admin password.
3. On the **Enter Team** tab, scroll down to the admin-only "Data Backup & Restore" panel.
4. Click **Restore from Backup** and select the JSON file.
5. Confirm the overwrite prompt.

## Files

- **`demo-backup.json`** — 14 entries with varied picks across all 4 tiers, group stage complete, R32 partially played. Bonus admin answers left pending so the leaderboard shows realistic mid-tournament state. Use for showcasing to others.
- **`blank-backup.json`** — empty entries, empty results, empty bonus answers. Use when you're ready to go live to wipe the demo data.

## Notes

- Restoring does **not** overwrite the tier roster — only entries, results, bonus answers, settings.
- Restore writes to both localStorage and the server, so all clients will see the new state on next refresh.
