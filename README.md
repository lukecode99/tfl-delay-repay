# TfL Delay Repay

Personal-use iOS app (Expo → TestFlight) that detects refund-eligible delays on Luke's actual TfL journeys and guides claim filing.

**Design principles (deliberate — do not "improve" away):**
- **No TfL credential storage and no automated claim submission.** Claims are filed by the user in a guided flow. This keeps the app inside TfL's ToS and App Store rules.
- Journeys come from TfL journey-history **CSV statements** imported via the iOS share sheet.
- Delay evidence comes from **our own disruption collector** (below) — TfL has no historical delay API, so the ledger only accrues from the day the collector runs.

## Components

| Path | What |
|------|------|
| `collector/` | VM-side disruption collector (Node + SQLite, zero npm deps) |
| `app/` | Expo iOS app (TfL-2 onward) |

## Disruption collector (`collector/`)

Polls `https://api.tfl.gov.uk/Line/Mode/tube,dlr,overground,elizabeth-line/Status?detail=true` every 5 minutes and appends one row per line per status to `disruptions.db` (SQLite, WAL). Good Service rows are recorded too, so "line was fine" is distinguishable from "collector wasn't running".

- `collector.mjs` — one-shot poll (run by a timer). `TFL_APP_KEY` optional: anonymous access covers 1 req/5 min comfortably; set a registered key to be polite. `TFL_DB_PATH` overrides DB location.
- `db.mjs` — schema + `wasDisrupted(line, fromISO, toISO)` → `{ disrupted, coverage, statuses }` (`coverage` = polls in window; 0 means no evidence either way).
- `was-disrupted.mjs` — CLI: `node was-disrupted.mjs victoria 2026-07-04T08:00:00Z 2026-07-04T09:30:00Z`. Exit 0 disrupted / 1 clean / 3 no data.
- `test-collector.mjs` — unit tests (fixture payload, in-memory DB): `node test-collector.mjs`.
- `tfl-collector.service` / `tfl-collector.timer` — systemd units for VM install:
  ```bash
  sudo cp tfl-collector.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now tfl-collector.timer
  ```
  Adjust `WorkingDirectory`/`ExecStart` to the repo's location on the VM.
- `poll-task.sh` — NanoClaw scheduled-task wrapper (current deployment): runs a poll, wakes the agent only after 3 consecutive failures.

**Currently deployed:** NanoClaw scheduled task, every 5 min, DB at `/workspace/ig-bot/projects/tfl-delay-repay/disruptions.db` on the VM. Collecting since 2026-07-04.

Requires Node 22+ (`node:sqlite`).
