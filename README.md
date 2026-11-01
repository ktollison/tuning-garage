# Tuning Garage

A file-based system for DIY engine tuning: versioned tune files, datalog
analysis, session notes and a learning tracker, kept in **your own private git
repository**, with a local web app on top. It sits beside HP Tuners,
PCMHammer, UniversalPatcher and TunerPro. It never edits a tune and never
talks to your vehicle.

> ⚠️ **Tuning can destroy engines and brick control modules.** This software
> produces **draft readings, not advice**. Every change is applied by you, at
> your own risk. Read **[DISCLAIMER.md](DISCLAIMER.md)** before your first flash.

## Get started

1. **Set up** — **[Windows](SETUP-WINDOWS.md)** or **[macOS](SETUP-MAC.md)**.
   About 15 minutes. You install Git, Node.js and the GitHub CLI, then create
   your own **private** copy with **Use this template**.
2. **Learn the workflow** — the **[User Guide](USER-GUIDE.md)** walks one full
   tuning cycle with screenshots.
3. **Run it** — `start-tuning.cmd` (Windows) or `./start-tuning.sh` (macOS)
   opens the app at <http://127.0.0.1:4590>.

Zero dependencies (plain Node 20+), bound to localhost, and nothing phones
home. Your data stays in your repository.

## Updating to a new release

Your copy does not follow this project automatically — "Use this template"
creates a repository with no shared history, so `git pull` cannot bring you a
new release. The update script does:

```bash
node scripts/update.mjs
```

It shows the release notes and every file it will change, then asks. It never
touches your data, keeps any project file you edited (merging the release in
where it can), runs the tests, and commits. If the tests fail it undoes
everything. Then push, and your other machines pick it up when they sync.
Full instructions: [User Guide → Updating](USER-GUIDE.md#9-updating-to-a-new-release).

Your version is shown in the app's header. To hear about new releases, click
**Watch → Custom → Releases** on
<https://github.com/ktollison/tuning-garage>. What changed in each release is
in [CHANGELOG.md](CHANGELOG.md).

## What is in your repository

**Yours** — an update never touches these:

```
vehicles/<vehicle>/   Profile, tunes, datalogs, sessions, flash log
PROGRESSION.md        Your learning tracker
data/user-math.json   Your formulas
data/preferences.json Display units
vcm-scanner/          Your scanner channel lists, charts, layouts, math
definitions/<OS>/     XDF definitions you add
```

**The project's** — replaced by updates (your own edits are kept and merged):

```
app/                  The web app: server, UI, analysis modules
scripts/              Updater, tests, log scrubber, submission tool
templates/            Vehicle profile, session log, pre-flash checklist
reference/            Tool, platform and process notes; FAQ
*.md guides           This README, setup guides, user guide, changelog
start-tuning.*        Launchers
```

## Rules the system is built around

1. **The stock read is sacred.** Archive it first, in `tunes/stock/`, and never
   edit it. Every tune starts from a copy. On a PCMHammer-supported PCM, keep
   both a full `.bin` read and the HP Tuners `.hpt` base.
2. **Never edit a revision in place.** A change is a new revision: v003 stays
   the record of what was flashed, and v004 fixes it.
3. **Every revision gets a changelog entry** before it is flashed.
4. **Every datalog names the revision** it was recorded against.
5. **Commit and push after every session.** Your GitHub repository is the backup.

| Thing | Pattern | Example |
|---|---|---|
| Vehicle folder | `YYYY-model-engine` | `2004-gto-ls1` |
| Tune revision | `vNNN_YYYY-MM-DD_short-desc.ext` | `v003_2026-08-14_maf-cal-pass2.hpt` |
| Datalog | `YYYY-MM-DD_vNNN_short-desc.ext` | `2026-08-14_v003_cruise.csv` |
| Session log | `YYYY-MM-DD_session.md` | `2026-08-14_session.md` |

The app applies these names for you when you upload through it.

## The app

| Tab | What it does |
|---|---|
| **Garage** | Every vehicle, its baseline status and what is flashed. Add a vehicle here |
| **Overview** | The selected vehicle: what is in the car vs newest on disk, milestones, profile |
| **Tunes** | Stock baseline, revisions, bin analysis, bin compare, checklist-gated "mark as flashed" |
| **Datalogs** | Upload logs; trim, wideband, knock, VE and airflow analysis; event timeline; math channels; before/after compare; share a log with the project |
| **Sessions** | Write and read session notes |
| **Progression** | The learning tracker |
| **User Math** | Your formula library, with VCM Scanner Math Lab import and export |
| **Timeline** | A vehicle's whole history, and the gaps worth noticing |
| **Scanner** | VCM Scanner channel lists, charts, layouts and the channel dictionary |
| **Library** | Practice bins, XDF definitions, and the reference docs |
| **Platforms** | PCM and adapter reference tables |

Every analysis, comparison, the vehicle history and each session exports as a
**Markdown report** saved into your repo, or as a **PDF** through the print view.

Everything the analysis produces is a **draft reading**: arithmetic on data you
supplied, with every unit stated. Nothing here writes to a tune file.

## What the code is

The server is `app/server.mjs`; the page is `app/public/index.html`. Everything
that does arithmetic lives in `app/modules/`, one concern per file:

| Module | What it does |
|---|---|
| `index.mjs` | Registry of platform modules; picks the one that understands a bin |
| `gm-gen3.mjs` | Gen III GM P01/P59 bin analysis: OS ID, segment checksums (verify only), VIN |
| `xdf.mjs` | Reads TunerPro XDF definitions and the tables they describe |
| `vcmscanner.mjs` | Reads VCM Scanner channel, chart, graph, layout and math files |
| `units.mjs` | The only place a unit conversion happens |
| `expr.mjs` | The arithmetic compiler behind XDF scaling and math channels |
| `loganalysis.mjs` | Datalog parsing and every analysis: trims, wideband, knock, VE, timeline |
| `report.mjs` | Markdown reports |
| `scrub.mjs` | Removes VINs and locating channels from a log |
| `submission.mjs` | Packages a log for the project and posts it |

And the scripts you may run:

| Script | What it does |
|---|---|
| `start-tuning.sh`, `start-tuning.cmd` | Launchers: pull, then start or restart the app |
| `scripts/update.mjs` | Updates your copy to a new release |
| `scripts/test.mjs` | Runs every test |
| `scripts/check-kit-docs.mjs` | Fails when the docs disagree with the code |
| `scripts/smoke.mjs` | Boots checks against a running app |
| `scripts/version-check.mjs` | Tells the launchers whether the running app is current |
| `scripts/scrub-log.mjs` | Redacts a log before you share it |
| `scripts/submit-log.mjs` | Scrubs a log and sends it to the project |
| `scripts/analyse-submission.mjs` | Summarises a submitted log for a pull request |
| `scripts/autostart-macos.sh` | Starts the app at login on a Mac |
| `scripts/make-demo.mjs`, `scripts/make-screenshots.sh` | Rebuild the User Guide's screenshots |
| `scripts/setup-labels.mjs`, `scripts/check-repo-settings.mjs`, `scripts/notify-pushover.sh`, `scripts/watch-submissions.mjs` | For running a public copy; see [MAINTAINING.md](MAINTAINING.md) |

The HTTP interface is in [reference/api.md](reference/api.md).

## Tests

```bash
node scripts/test.mjs
```

```bash
node scripts/check-kit-docs.mjs
```

The first runs the tests; the update script runs them too. The rule they
enforce: a silently wrong number is worse than a crash. The second fails when a
doc names a file that is not there, a link is broken, the changelog is out of
shape, or the docs and the code disagree about a tab, an endpoint or the
minimum Node version. CI runs both.

## Contributing

Real logs and channel names help most. See [CONTRIBUTING.md](CONTRIBUTING.md).
**Calibration files (`.bin`, `.hpt`, `.hpl`) cannot be accepted**, because they
carry the manufacturer's data and, on Gen III, your VIN. Scrub a log before
posting it anywhere:

```bash
node scripts/scrub-log.mjs --check yourlog.csv
```

Questions go to [Discussions](https://github.com/ktollison/tuning-garage/discussions).

## Licence

**GPL-3.0** — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
`app/modules/gm-gen3.mjs` is a port of Jouko Kylmäoja's
[PCMBinBuilder](https://github.com/joukoy/PCMBinBuilder) and
[UniversalPatcher](https://github.com/joukoy/UniversalPatcher), both GPL-3.0.
