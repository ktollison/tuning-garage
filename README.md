> **Tuning Starter Kit** — a file-based system for tracking DIY car tuning:
> versioned tune files, session logs, a learning tracker, and a local web app.
> To use it: create your own **private** git repo from this folder, rename
> `vehicles/example-vehicle` for your car, and run `node app/server.mjs`
> (or a start-tuning launcher). Nothing here phones home; the app binds to
> localhost and your data lives in your own repo.

# Tuning Repository

Tune file archive, session logs, and learning tracker for my car tuning work.

**Tools:** HP Tuners (MPVI3), PCMHammer, UniversalPatcher, GM SPS2.
📖 **New here? Start with the [User Guide](USER-GUIDE.md)** — a full worked
workflow with screenshots.

**Adapter policy:** prove the interface you write with before trusting it — see
`reference/tools/adapters.md` for why that rule exists.

> ⚠️ **Tuning can destroy engines and brick control modules.** A wrong
> calibration can hole a piston in seconds; an interrupted write can leave a PCM
> unrecoverable. This software produces **draft readings, not advice**, and
> never writes to your vehicle — every change is applied by you, on your
> authority, at your own risk. Read **[DISCLAIMER.md](DISCLAIMER.md)** in full
> before your first flash.

## Layout

```
vehicles/<vehicle>/
  vehicle.md          Profile — PCM, OS, VIN, mods, baseline status
  tunes/
    CHANGELOG.md      One entry per tune revision: what changed and why
    stock/            Original stock read. READ-ONLY. Never edited.
    vNNN_*.hpt/.bin   Working revisions (always copies, never edits-in-place)
  datalogs/           Logs named to the tune revision they ran against
  sessions/           One markdown log per tuning session
  flash-log.md        Every write recorded, checklist-gated (created on first flash)

app/                  The web app: server, UI, and analysis modules
scripts/              Tests, the docs/version guard, the smoke test
data/                 user-math.json, preferences.json, platforms/
definitions/<OS>/     XDF definitions, filed by operating system
vcm-scanner/          Channel lists, charts, graphs, layouts, math parameters
donor-files/          Practice and donor bins — never a vehicle's baseline
reference/            Tool, platform and process notes; FAQ; incidents
templates/            Vehicle profile, session log, pre-flash checklist
PROGRESSION.md        Learning tracker — concept checklist with status
BACKLOG.md            Categorised roadmap (private, not exported)
```


## Rules

1. **The stock read is sacred.** The first thing checked in for any vehicle is
   the unmodified stock read, stored in `tunes/stock/`. It is never edited,
   renamed, or overwritten. Every tune starts from a *copy*.
   On a PCMHammer-supported PCM, the baseline is **both formats**: a full
   PCMHammer read (`stock_YYYY-MM-DD_full-read.bin`) *and* an HP Tuners base
   (`stock_YYYY-MM-DD_hpt-base.hpt`). Two independent tools reading the same
   PCM is also a cross-check that the read is good.
2. **Never edit a tune revision in place.** A change means a new revision file.
   If v003 has a problem, v004 fixes it — v003 stays as the record of what was
   flashed.
3. **Every revision gets a CHANGELOG entry** before it gets flashed: what
   tables changed, what values, and why.
4. **Datalogs link to revisions.** A log is only useful if you know which tune
   it was recorded against — the filename carries the revision number.
5. **Commit and push after every session.** The GitHub remote is the backup;
   a dead laptop should cost nothing.

## Naming conventions

| Thing | Pattern | Example |
|-------|---------|---------|
| Vehicle folder | `YYYY-model-engine` | `example-vehicle` |
| Tune revision | `vNNN_YYYY-MM-DD_short-desc.ext` | `v003_2026-08-14_maf-cal-pass2.hpt` |
| Same tune, both formats | same `vNNN`, different extension | `v003_…​.hpt` + `v003_…​.bin` (one changelog entry) |
| Datalog | `YYYY-MM-DD_vNNN_short-desc.ext` | `2026-08-14_v003_cruise-ltft.hpl` |
| Session log | `YYYY-MM-DD_session.md` | `2026-08-14_session.md` |
| Commit message | `<vehicle>: <what>` | `your-car: v003 – leaned MAF cal 3000–4500 Hz` |

## Workflow

1. **Before flashing anything new:** run through `templates/pre-flash-checklist.md`.
2. **Check in a tune:** copy the file into `tunes/` with the next `vNNN` name,
   add the CHANGELOG entry, commit.
3. **After a session:** copy datalogs in, write the session log from
   `templates/session-log.md`, update `PROGRESSION.md`, commit, push.
4. **New vehicle:** copy `templates/vehicle-profile.md` into a new folder under
   `vehicles/`, read and archive the stock tune before touching anything.

The `tune-tracker` skill in the assistant workspace automates steps 2–4:
say "check in a tune" or "log a tuning session".

## Web app — Tuning Garage

Everything above is usable from a browser. Zero dependencies, plain Node (18+),
bound to localhost only.

```bash
node app/server.mjs
```

Then open <http://127.0.0.1:4590> — or use the launcher (`start-tuning.sh` /
`start-tuning.cmd`), which pulls from GitHub first and waits for the server
before opening the page. The app reads and writes the real repo files, so
everything it does is versioned in git exactly like a hand edit.

To keep it running permanently on a Mac — started at login, relaunched if it
ever dies — install the launchd agent:

```bash
sh scripts/autostart-macos.sh install
```

`status` reports whether the agent is loaded *and* whether the port actually
answers; `restart` reloads it after a pull; `uninstall` removes it. The agent
runs as you, not root, and the server still binds localhost only.

### The tabs

| Tab | What it does |
|---|---|
| **Garage** | Every vehicle with its baseline status, currently-flashed revision and counts. Add a vehicle here — it scaffolds the folders, profile and changelog. |
| **Overview** | The selected vehicle: baseline, what's in the car vs newest on disk, learning progress, milestones, editable profile |
| **Tunes** | Stock baseline (both formats), revisions with SHA-256, **bin analysis**, **compare two bins**, checklist-gated **mark as flashed**, flash log |
| **Datalogs** | Upload logs, quick per-channel summary, and full **trim / wideband / knock analysis** |
| **Sessions** | Write and read session logs |
| **Progression** | The learning tracker — click a status to cycle it |
| **User Math** | Formula repository: hand-written entries, `.MathParameter.xml` upload, export back to VCM Scanner |
| **Timeline** | One chronological history per vehicle, plus the gaps worth noticing |
| **Scanner** | VCM Scanner channel lists, charts, graphs, layouts and the channel dictionary |
| **Library** | Donor/practice bins, XDF definitions, and every reference doc rendered inline |
| **Platforms** | PCM and adapter matrices from `data/platforms/` |

### What the analysis actually does

- **Bin analysis** (`app/modules/gm-gen3.mjs`) — P01/P59 detection, OS ID, cal
  IDs, checksum **verification** (fixing stays in UniversalPatcher), SHA-256,
  VIN cross-check against the vehicle profile.
- **Log analysis** (`app/modules/loganalysis.mjs`) — filters to warmed-up,
  closed-loop, steady-state data and reports what it rejected; trims binned by
  MAF frequency with correction suggestions; **wideband** coverage of open loop
  and WOT with lean detection; **knock** events and maps.
- **XDF** (`app/modules/xdf.mjs`) — read-only definition parsing, so bin
  compare reports *which tables changed* rather than byte counts.
- **Units** (`app/modules/units.mjs`) — the only place a conversion happens.
  See `reference/units.md`.

Everything the analysis produces is a **draft reading**. Nothing in this app
writes to a tune file.

### Data it keeps

`data/user-math.json` (formulas), `data/preferences.json` (units, synced
between machines), `data/platforms/` (PCM metadata), `definitions/<OS>/`
(XDFs), `vcm-scanner/` (scanner configs), `donor-files/` (practice bins).

### Tests

```bash
node scripts/test.mjs
```

126 assertions over the analysis maths — Gen3 checksums, unit conversion,
air-fuel scales, XDF scaling, knock detection. CI runs them on every push;
run them yourself before changing anything under `app/modules/`.

## Development rules (the system itself)

- **Versioning:** [Semantic Versioning](https://semver.org). `APP_VERSION` in
  `app/server.mjs` is the source of truth; each release is tagged `vX.Y.Z`.
- **Change tracking:** [Keep a Changelog](https://keepachangelog.com) format in
  `CHANGELOG.md` (system changes — separate from per-vehicle tune changelogs).
- **Docs move with code:** every feature or enhancement updates the relevant
  docs (README, SETUP-WINDOWS, templates, skill) and adds a CHANGELOG entry
  **in the same push**.
- **Enforcement:** GitHub Actions runs on every push to main —
  `scripts/check-docs.mjs` fails the build if feature files changed without a
  CHANGELOG entry or if `APP_VERSION` ≠ newest CHANGELOG release;
  `scripts/test.mjs` runs the analysis unit tests; the starter kit is
  re-exported (personal-data leak sweep) and the app smoke-tested. Run them
  locally: `node scripts/check-docs.mjs && node scripts/test.mjs`.

## Sharing the system (without sharing my data)

The app is a generic engine — it operates on whatever repo it's pointed at
(`TUNING_REPO` env var). Everything personal lives in `vehicles/`, `data/`,
`PROGRESSION.md` state, and `dashboard/`. To produce a shareable starter kit:

```bash
node app/export-template.mjs ../tuning-starter
```

That builds a clean copy containing the app, templates, docs, launchers, a
fully reset PROGRESSION.md, generic user-math formulas (all `unverified`),
and an empty `example-vehicle` — then **sweeps the output and refuses to
finish if any personal string (name, vehicle, repo) survives**. Publish the
output folder as its own public repo whenever ready; this repo stays private.

## Licence

**GPL-3.0** — see [LICENSE](LICENSE), and [NOTICE.md](NOTICE.md) for why it has
to be: `app/modules/gm-gen3.mjs` is a port of Jouko Kylmäoja's
[PCMBinBuilder](https://github.com/joukoy/PCMBinBuilder) and
[UniversalPatcher](https://github.com/joukoy/UniversalPatcher), both GPL-3.0.

GPL §15 and §16 disclaim all warranty and liability. That is not a formality
for a project that sits beside a process which can destroy an engine —
[DISCLAIMER.md](DISCLAIMER.md) says the same thing in plain language, and is
worth reading before you use any of this.

## Contributing

The project lives at
**<https://github.com/ktollison/tuning-garage>** — issues, submissions and
releases are there.

Real logs and real channel names are the most useful thing you can send. See
[CONTRIBUTING.md](CONTRIBUTING.md) — and note that **calibration binaries
(`.bin`, `.hpt`, `.hpl`) cannot be accepted**: they carry the manufacturer's
copyrighted data and, on Gen III, your VIN.

Scrub any datalog before posting it anywhere public:

```bash
node scripts/scrub-log.mjs --check yourlog.csv
```
