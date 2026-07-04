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
| `.github/workflows/ios.yml` | TestFlight pipeline (push to `main` touching `app/**`) |

## Disruption collector (`collector/`)

Polls `https://api.tfl.gov.uk/Line/Mode/tube,dlr,overground,elizabeth-line/Status?detail=true` every 5 minutes and appends one row per line per status to `disruptions.db` (SQLite, WAL). Good Service rows are recorded too, so "line was fine" is distinguishable from "collector wasn't running".

- `collector.mjs` — one-shot poll (run by a timer). `TFL_APP_KEY` optional: anonymous access covers 1 req/5 min comfortably; set a registered key to be polite. `TFL_DB_PATH` overrides DB location.
- `db.mjs` — schema + `wasDisrupted(line, fromISO, toISO)` → `{ disrupted, coverage, statuses }` (`coverage` = polls in window; 0 means no evidence either way).
- `was-disrupted.mjs` — CLI: `node was-disrupted.mjs victoria 2026-07-04T08:00:00Z 2026-07-04T09:30:00Z`. Exit 0 disrupted / 1 clean / 3 no data.
- `test-collector.mjs` — unit tests (fixture payload, in-memory DB): `node test-collector.mjs`.
- `export-ledger.mjs` — compacts the ledger into `app/src/data/ledger.json` for bundling (poll timestamps → coverage ranges, consecutive identical statuses → disruption spans). Run before committing app changes so each build ships fresh evidence.
- `tfl-collector.service` / `tfl-collector.timer` — systemd units for VM install:
  ```bash
  sudo cp tfl-collector.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now tfl-collector.timer
  ```
  Adjust `WorkingDirectory`/`ExecStart` to the repo's location on the VM.
- `poll-task.sh` — NanoClaw scheduled-task wrapper (current deployment): runs a poll, wakes the agent only after 3 consecutive failures.

**Currently deployed:** NanoClaw scheduled task, every 5 min, DB at `/workspace/ig-bot/projects/tfl-delay-repay/disruptions.db` on the VM. Collecting since 2026-07-04.

Requires Node 22+ (`node:sqlite`).

## App (`app/`)

Expo (React Native) iOS app, bundle id `com.nanoluke.tfldelayrepay`, owner `nanoluke`. Built and shipped to TestFlight by `.github/workflows/ios.yml` on push to `main` (manual signing; secrets `IOS_P12_*`, `TFL_PROVISION_*`, `APP_STORE_CONNECT_*`, `IOS_TEAM_ID` live on the GitHub repo).

### Bundled dataset (`app/src/data/`)

- `stations.json` — 470 stations across 19 lines (Tube, DLR, Overground, Elizabeth line) with zone, coordinates and serving lines. From per-line StopPoints calls.
- `fares.json` — Adult PAYG single fare matrix (peak/off-peak) keyed by zone range `"a-b"`. Sampled via the TfL Single Fare Finder along radial corridors (Central line Z1–6, Metropolitan/Lioness Z7–9), picking geographically nearest station pairs so the priced route stays inside the zone range being measured. `pairsUsed` records which station pair produced each entry.
- `build-dataset.mjs` — regenerates both (`--fares-only` skips the station sweep). Fares change each March.
- `index.ts` — typed access: `searchStations()`, `estimateFare(fromId, toId)` (boundary stations like Z2+3 use whichever zone is cheaper, matching TfL charging).

The fare matrix is an *estimator* — the actual charge for an imported journey comes from the TfL CSV statement when present.

- `App.tsx` — two screens, state-switched (no navigation library): the journey list and the claim detail (TfL-5, below). `src/components/StationSearch.tsx` (the TfL-2 fare-lookup scaffold) is kept for reuse in the claim flow.
- `assets/gen-assets.mjs` — regenerates the placeholder icon/splash PNGs (zero-dependency PNG writer).

### Journey import (`app/src/journeys/`)

TfL journey-history CSV statements come in via the iOS share sheet ("Open in" — `CFBundleDocumentTypes` in `app.json`) or an in-app document picker; both paths funnel through `import.ts`.

- `parse.ts` — pure CSV parser (no RN imports; testable with `node --experimental-strip-types src/journeys/test-parse.ts`). Handles Oyster and contactless export layouts by mapping columns from the header row; only "X to Y" rows count as rail journeys (bus journeys, top-ups, refunds are skipped — Delay Repay doesn't cover buses). Journeys missing a tap-out (`[No touch-out]` or empty End Time) are kept and flagged `incomplete` for the claim flow to handle later; rows with no touch-*in* are unusable and counted as malformed.
- `db.ts` — expo-sqlite store. Dedupe on re-import is a UNIQUE index on (card, date, tap-in time, origin) with `INSERT OR IGNORE`, per the card+tap-in-datetime+origin key.
- `import.ts` — document-picker and file-URL entry points → read → parse → insert, returning an `ImportOutcome` (inserted / duplicates / incomplete / skipped counts) for the UI.

### Eligibility engine (`app/src/eligibility/`)

Pure modules with injected I/O (tests: `node --experimental-strip-types src/eligibility/test-eligibility.ts`).

- `planner.ts` — expected duration + plausible lines per station pair from the TfL Journey Planner API, cache-first (`TimingCache` injected). `plausibleLines` is the union of line ids across the returned routes — it doubles as the disruption match set.
- `resolve-core.ts` / `resolve.ts` — CSV station names → dataset stations ("Kings Cross [London Underground]" → King's Cross St. Pancras). Core is data-injected for node tests; `resolve.ts` binds the bundled dataset.
- `engine.ts` — `assessJourney`: actual = tapOut − tapIn (Europe/London → UTC incl. BST rules, overnight wrap), overage vs threshold (15 min Tube/DLR, 30 min Overground/Elizabeth, by the fastest route's modes), then ledger corroboration → confidence: **high** = severity <9 disruption on a plausible line during the journey (with 45 min lead), **medium** = Minor Delays during, or severe within ±3 h, **low** = Minor Delays within ±3 h, or a collector coverage gap (can't corroborate, can't refute). Healthy lines with coverage → not eligible. Refund value = CSV charge, else peak/off-peak zone estimate by tap-in time.
- `assess.ts` — orchestrator: resolve → timing → verdict.
- `adapters.ts` — expo-sqlite implementations of `TimingCache` (used by the app) and `DisruptionLookup` (kept for a future live-synced ledger).
- `ledger-json.ts` / `ledger.ts` — `DisruptionLookup` over the bundled ledger snapshot (`src/data/ledger.json`, see below). Span/range overlap tests, pure and node-tested.
- `deadline.ts` — 28-day claim window: deadline date + days left.
- `use-assessments.ts` — React hook wiring it all up: global `fetch` (anonymous Journey Planner calls, SQLite-cached per station pair so a statement costs few requests), bundled ledger lookup, sequential assessment of stored journeys.

### Journeys & eligibility UI (TfL-5)

- `src/screens/JourneysScreen.tsx` — journey list grouped by day (`SectionList`); eligible journeys get a green badge with the estimated refund and confidence, incomplete ones a ⚠.
- `src/screens/ClaimDetailScreen.tsx` — the evidence behind a verdict: expected vs actual duration (with overage and threshold), the logged disruption (line, severity description, reason, timestamp), fare/refund value, and days left in the 28-day claim window.
- `src/format.ts` — pure display helpers (day formatting, grouping) — node-tested.

### Guided claim filing (TfL-6, `src/claims/`)

From an eligible claim detail, "File this claim" opens TfL's service-delay-refund flow in a WebView (`src/screens/ClaimWebScreen.tsx`) with an assist bar:

- **Fill form** — injects `prefill.ts`'s keyword-heuristic script: matches visible inputs/selects by id/name/placeholder/label text, sets values through the native setter so React/Knockout pages notice, and reports how many fields it filled. The form sits behind TfL sign-in so its markup can't be pinned down ahead of time — hence heuristics, not selectors.
- **Copy chips** — one-tap copy for every claim value (date, touch in/out, stations, delay minutes): the always-works fallback.
- **Mark claimed** — records the claim locally (`db.ts`, one row per journey) once the user has submitted on the TfL page; claimed journeys show a ✓ badge in the list and the detail screen offers unmark.

The user signs in and submits on tfl.gov.uk themselves — no credential storage, no automated submission (design principle above). Prefill tests: `node --experimental-strip-types src/claims/test-claims.ts`.

**Ledger delivery (interim):** the app bundles a snapshot of the collector ledger (`src/data/ledger.json`, regenerated by `collector/export-ledger.mjs` before each commit), so evidence is as fresh as the latest TestFlight build. Journeys before the collector started — or newer than the bundled snapshot — assess as eligible/**low** ("collector gap") rather than being wrongly cleared. A live-synced ledger (hosted endpoint + the `adapters.ts` SQLite lookup) is the planned upgrade.
