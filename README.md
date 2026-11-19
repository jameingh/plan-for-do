<div align="center">
  <img src="assets/logo/masters/gongdao-symbol.svg" alt="Gongdao" width="96" height="96" />
</div>

# Gongdao · planfordo

### Your life, on your machine. One app for lists, habits, views, focus and notes.

**Lists with recurring rules. Habits with streaks and heatmaps. Focus timers that link to your tasks. Notes with attachments. All local-first, with pluggable sync.**

[![CI](https://github.com/jameingh/plan-for-do/actions/workflows/ci.yml/badge.svg)](https://github.com/jameingh/plan-for-do/actions/workflows/ci.yml) [![Release](https://github.com/jameingh/plan-for-do/actions/workflows/release.yml/badge.svg)](https://github.com/jameingh/plan-for-do/actions/workflows/release.yml) [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white) ![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black) ![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)

[Download](https://github.com/jameingh/plan-for-do/releases) · [Architecture](docs/architecture.md) · [Design reference](docs/design-reference.md)

---

## Is planfordo for you?

planfordo is a local-first desktop app for organizing your day. Use it if you want:

- **One place for lists, habits, focus and notes** — no stitching together four different apps.
- **Recurring lists that actually bend** — daily, weekly on chosen days, monthly dates, every N days, or weekly/monthly quotas; subtasks, time points and ranges, reminders, tags and overdue roll-forward.
- **Habit tracking with real history** — scheduled check-ins, backfill, quantitative habits with units, contexts, notes, and day/week/month/year statistics with heatmaps.
- **Focus sessions tied to tasks** — stopwatch, pomodoro and countdown, with a settlement page, event timeline and statistics.
- **Your data to stay yours** — no account, no server. Data lives on your machine and sync happens only after you configure a channel.
- **Pluggable sync** — Feishu Base, Feishu Drive, WebDAV, or a local folder, merged record-by-record with last-write-wins.

If you are happy with a single cloud service and want someone else to hold your data, you probably do not need planfordo.

Supported desktops: **Windows** (primary, tested), **Linux** and **macOS** (CGO-free experimental builds; see [Releases](#releases)). A browser-only mode with in-memory mock data is available for looking around the UI.

## Quick start

### 1. Install

Grab a build from [Releases](https://github.com/jameingh/plan-for-do/releases). The Windows build is the tested one; it uses the GUI subsystem, so no console window pops up.

To build from source (Go 1.27+, Node 20+; Windows needs the WebView2 runtime, bundled with Win10/11):

```bash
# 1) frontend assets (the desktop shell embeds them into the binary)
cd frontend && npm ci && npm run build && cd ..

# 2) desktop app
CGO_ENABLED=0 go build -o bin/planfordo.exe .   # on non-Windows: -o bin/planfordo
./bin/planfordo.exe

# just want a look at the UI in a browser (in-memory mock, same contract)
cd frontend && npm run dev
```

The core is deliberately CGO-free (`CGO_ENABLED=0`), so cross-compiling does not need a host of the target platform.

### 2. Use it

The desktop app opens on your lists. From there:

- Switch modules in the left rail: lists, habits, views, focus, notes and settings.
- Enter the habit statistics page from the top bar of the habits module.
- Enter the list statistics page from the top bar of the lists module.
- Configure a sync channel under Settings → Data & Sync, then hit "Sync now".

### 3. From the command line

`cmd/plando` uses the same kernel and the same data directory as the GUI:

```bash
go build -o bin/plando.exe ./cmd/plando
./bin/plando.exe add "Weekly report" --day 2026-11-10 --time 09:00-10:30
./bin/plando.exe habit "Morning run" --freq "weekly:1,3,5" --backfill 7
./bin/plando.exe habit-clock "Morning run" --day 2026-11-08
./bin/plando.exe focus --type pomo --minutes 25 --cycles 4 --item "Weekly report"
./bin/plando.exe sync            # run every enabled channel
./bin/plando.exe calendar        # which years of holiday data are loaded, and from where
./bin/plando.exe export backup.planfordo --with-attachments   # password-encrypted full backup (PLANDO_BACKUP_PASSWORD)
./bin/plando.exe import backup.planfordo                      # restore: merge by last-modified time, never wipe
./bin/plando.exe calendar day 2026-10-01     # is this day a workday or a holiday?
./bin/plando.exe where           # data directory and device ID
```

## What it does

### Lists

Three groupings — by date, by category, or by Eisenhower quadrant — over one recurring engine: daily, weekly on chosen weekdays, monthly dates, every N days, and weekly/monthly quotas. Items carry subtasks, time points and time ranges, reminders (with custom reminder times), tags, pinning and overdue roll-forward. Clock-in is three-state: success, skipped, failed.

### Views

Day, week and month calendars. The month grid draws cross-day bars; the Sunday view is a 24-hour grid with overlapping columns and collapsible hour blocks. Custom views let you multi-select content and pick a color mode from a 30-color palette. Two independent "show completed" switches control what is visible.

### Habits

Daily-once and daily-multiple habits, with quantities and units. Habits can be split into contexts, checked in against their schedule, backfilled, and annotated with notes. A guided creation flow asks questions step by step. The statistics page has four tabs — day, week, month and year — with check-in grids, perfect days, streaks and a full-year heatmap.

### Focus

Stopwatch, pomodoro and countdown, each linkable to a task. Immersive timer, pause and finish confirmation, a settlement page with session notes, and a detail page with an event timeline. The data page adds summary statistics (cumulative and today, duration distribution, all-day heatmap, duration breakdown, backfilled records and history) plus day/month/year distributions.

### Notes

Folders with drag-and-drop ordering, search (Enter to trigger, matched terms highlighted), sort by creation or modification time, pinning, a right-click menu, and a rich-text editor (font, size, color, alignment, lists, checkboxes, background). Attachments, a recycle bin and permanent delete are included.

### List statistics

A dedicated page reached from the lists top bar. It computes check-in rate, a four-hour-bucket day trend, week/month distribution over occurrences, and a self-discipline index built from control (check-in rate), efficiency (successes over check-ins) and diligence (daily check-ins over three, capped). It reuses a single `CalendarView(showDone=true)` call — no extra Go API, no regenerated bindings.

### Settings

Runtime handshake info, holiday and makeup-work data (covered years, sources, import directory), preferences (default grouping, theme, new-habit mode, show completed, system notifications), password-encrypted backup and restore, sync channel configuration (including guided Feishu Drive setup), and "Sync now".

## How it fits together

```
api.go / main.go            Wails v3 desktop shell: bound API, events, embedded static assets (//go:embed frontend/dist)
cmd/plando                  CLI over the same kernel: add / clock / habit / habit-clock / focus / sync / stats ...
internal/core/model         Domain objects (no UI, driver or sync dependencies; reusable by iOS later)
internal/core/store         Single-table entity (kind,id + JSON data + derived day/parent/status/sort columns), pure-Go sqlite
internal/core/repeat        Recurrence expansion, overrides, holidays
internal/core/calendar      Lunar calendar, solar terms, festivals + built-in statutory holiday tables (overridable locally)
internal/core/service       Use cases: lists / habits / views / focus / notes / reminders / statistics
internal/core/sync          Merge engine (record-level LWW + tombstone full snapshot) + channel interface
internal/core/sync/channel  feishuBase / feishuDrive / webdav / localdir
frontend/src                React + Vite + TS; api/client.ts is the single seam (Wails bindings and browser mock share one contract)
scripts                     CDP real-click self-checks, seed data, screenshot helpers
docs                        Design spec, architecture, iOS packaging steps
```

`frontend/src/api/client.ts` is the only seam between the UI and the kernel: Wails bindings on desktop, an in-memory mock in the browser, same contract on both sides.

## Sync and privacy

- Data lives in `%APPDATA%\planfordo` (system config directories on macOS/Linux): `planfordo.db`, attachments, sync state and `app-errors.log`.
- There is no account system and no server. Sync only happens after you configure a channel. Secrets stay in local `meta` — never in a snapshot, never in logs, never echoed in the UI.
- Attachment bytes travel in a separate `planfordo-blobs.json` archive (snapshots carry only metadata). localdir, WebDAV and feishuDrive support it; feishuBase does not. A single archive is capped at 14 MB of raw attachment bytes (~19 MB after base64).
- The current strategy is a full snapshot with record-level LWW and a union of both ends. Incremental sync is deliberately deferred until data volume justifies it (over 20k records, over 5 MB compressed snapshot, automatic scheduled sync, more than three devices, or metered mobile data). The full snapshot stays as a baseline even if incrementals are added later.
- This repository contains **no** user data: the database, logs, temporary self-check databases under `tmp/`, verification screenshots and local captures are all ignored by `.gitignore`. Material referenced in the docs is redacted (task names replaced with neutral examples, measurements unchanged).

## Documentation

- [Architecture](docs/architecture.md) — storage, merge engine, channel internals
- [Design reference](docs/design-reference.md) — UI and interaction spec
- [iOS / TestFlight packaging](docs/ios-testflight.md) — signed macOS and iOS builds
- [Sync solutions selection](docs/sync-solutions-selection.md) — why full snapshots for now
- [Reference site notes](docs/reference-zomoplan.md) — interaction references

## Testing

```bash
CGO_ENABLED=0 go vet ./internal/...
CGO_ENABLED=0 go test ./...          # kernel units: recurrence, store, use cases, sync merge, channels via httptest
cd frontend && npx tsc --noEmit
```

Every push runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): `kernel` (vet + go test) and `web` (tsc + build) on Ubuntu, plus one Windows runner job per UI self-check (they start a real Wails window + WebView2 and dispatch real mouse/keyboard events through CDP — Linux/macOS runners cannot do this). Failing jobs upload a screenshot and the instance log as artifacts.

UI regression uses real mouse and keyboard events through CDP — no human clicking, no trusted fake data:

```bash
bash scripts/verify-restart.sh 9256 focus && bash scripts/seed-focus.sh && node scripts/check-focus.mjs 9256
```

| Script | Covers | Checks |
| --- | --- | --- |
| `check-modal.mjs` | New/detail dialogs, panel by panel (date, time, recurrence, reminder, tags, priority, subtasks, end) + workday/holiday badges | 66 |
| `check-habit.mjs` | New-habit dialog (icon, frequency, unit, context, reminder, guided mode) | 66 |
| `check-view.mjs` | Day/week/month views, cross-day bars, folding, custom views, two switches, workday/holiday badges | 67 |
| `check-stat.mjs` | Habit statistics, four tabs, cross-checked against kernel records | 45 |
| `check-memo.mjs` | Notes (list, editor, folders, recycle bin, search and sort) | 81 |
| `check-focus.mjs` | Three timers + linked tasks + immersive/settlement/detail + data page (including a real 62-second pomodoro) + cross-device takeover | 106 |
| `check-mask.mjs` / `check-account.mjs` | Masking and layering, avatar menu and account center, holiday data disclosure, system notification chain, backup entry | 23 / 32 |
| `check-popup.mjs` | Every popup must satisfy position (gap ≤16px, no horizontal detachment) and no-overflow (no clipped descendants, nothing covered by lower elements) | — |

Seeds and assertions all use **relative dates** (`scripts/lib/d.mjs`: Monday `m N` / today `d N`), so the scripts work any day of the week. Each script must restart its instance with the start tab noted in its header comment; sharing an instance lets the previous script's page state leak in and produce false failures.

## Releases

Pushing a `v*` tag produces a build (you can also trigger the workflow manually; manual runs produce a prerelease):

```bash
git tag v0.4.0 && git push origin v0.4.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) cross-compiles six targets on one Ubuntu runner, packs zip files with sha256 checksums, then creates a GitHub Release and attaches the artifacts.

| Artifact | Build tags | Status |
| --- | --- | --- |
| `planfordo-windows-amd64.zip` | `production`, GUI subsystem (no console) | **Tested** (primary platform) |
| `planfordo-windows-arm64.zip` | same | Compiles, not run on ARM hardware |
| `planfordo-linux-amd64.zip` / `-arm64` | `production purego` | CGO-free experimental Wails backend; still needs system WebKitGTK at runtime, untested |
| `planfordo-darwin-amd64.zip` / `-arm64` | `production purego` | Unsigned (Gatekeeper will block), untested; signed macOS/iOS builds in [docs/ios-testflight.md](docs/ios-testflight.md) |

## Known limitations

The real gaps, by priority:

1. **feishuBase carries no attachment bytes.** localdir / WebDAV / feishuDrive already move attachment bytes with sync (missing bytes are filled in after record merge, see `docs/architecture.md` §7), so switching machines no longer means "the image is only on the other device". Feishu Base has no binary object semantics, so it syncs metadata only. One archive is capped at 14 MB of raw bytes (base64 stays under Feishu's 20 MB `upload_all` limit); beyond that, use a backup file with "include attachments" checked (design doc §27).
2. **Native notification banners.** Due reminders and pomodoro round switches do reach the Windows notification library (verified), but the packaged app still needs a Start-menu shortcut with an AppUserModelID for the banner to draw. That COM registration had no visible effect on this machine, so it was not committed. It can be resolved on a real machine or after packaged installation (§26).
3. **macOS / iOS packaging** needs a Mac and a developer account; iOS is deferred. Darwin artifacts are unsigned and untested.
4. **No account system.** The account center and login entry are placeholders; sync works through channels (Feishu / WebDAV / local folder).
5. **Timers do not keep running while the app is closed.** This is by design (at most one heartbeat period is caught up on resume), not a defect.

Already closed (2026-11-08): statutory holidays and makeup work (built-in 2025–2027, §25), native notification delivery (§26), password-encrypted backup and restore (§27), cross-device focus exclusion (§28), attachment byte sync across the three file-based channels (§7). Details are in [docs/design-reference.md](docs/design-reference.md).

## Community

Questions, bug reports and feature ideas are welcome through [GitHub Issues](https://github.com/jameingh/plan-for-do/issues). If you want to change the app, open an issue first so we can agree on the approach — most modules have detailed interaction specs in `docs/design-reference.md`, and UI changes must pass the CDP self-checks described above.

If planfordo is useful to you, a star helps other people find it.

## License

[GNU GPLv3](LICENSE). You may run, study, modify and redistribute the program freely; **any distribution of a modified version carries the same obligation**: publish the corresponding complete source and keep this license (GPL-3 copyleft), except for network use.

Dependencies are compatible with GPL-3: Wails v3 and `modernc.org/sqlite` are MPL-2.0 (file-level copyleft, coexists with GPL in a combined work), and React/Vite are MIT. Each dependency keeps its own license file.
