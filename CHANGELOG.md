# Changelog

What changed in each release of Tuning Garage, newest first. To update your
copy, run `node scripts/update.mjs` — see the User Guide, section 9.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions:
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — a MINOR release
adds features, a PATCH release fixes things. Releases before 0.40.0 predate
the public project.

## [0.46.0] - 2026-10-04

Reports and PDF, sharing a log from inside the app, and three features taken
from other tools: before/after log comparison, an event timeline and math
channels. The research behind them is in `reference/competitive-landscape.md`.

### Added

- **Reports, as Markdown and PDF.** A log analysis, a before/after
  comparison, the vehicle history, a bin compare and each session can be:
  - saved into `vehicles/<vehicle>/reports/`, versioned like everything else;
  - downloaded as Markdown;
  - printed through a clean print view, where the browser's "Save as PDF" makes
    the PDF.

  No dependencies. Every report states its units, ends with the draft-reading
  note, and redacts anything VIN-shaped as its last step. The vehicle history
  says only whether a VIN is on file.
- **Share a log from the app.** The **share** link beside a CSV scrubs it,
  packages it outside the repository, and shows what was redacted and the exact
  issue text before anything leaves. Four confirmations are required.
  - With the GitHub CLI signed in, the app posts the scrubbed log as a secret
    gist and the issue linking to it.
  - Otherwise it opens GitHub's issue form pre-filled, with platform and
    vehicle from your profile (first clause only, never the VIN), and hands you
    the scrubbed file.

  `scripts/submit-log.mjs` uses the same code and now also posts the gist, so
  there is nothing left to attach by hand.
- **Before/after comparison** [from HP Tuners' comparison logs and Datazap].
  Pick another log of the same vehicle to see trim per MAF bin, enrichment
  error per RPM band and knock side by side with the change. Only conditions
  both logs covered are compared; anything else is shown and labelled.
- **Event timeline** [from Datazap and NorCal's LogApp]. A strip across the log
  with lanes for knock, lean of commanded, wideband off, PCM not reporting,
  warm-up, decel fuel cut and session restarts. Clicking a marker shows every
  channel at that moment. On a real idle log it shows both key-offs,
  the AEM heating, and the 16 s hot-restart warm-up.
- **Math channels** [from MegaLogViewer and LibreTune]. Your User Math formulas
  are evaluated on the log. `[50030.92]` references resolve through the
  parameter IDs HP Tuners writes into its CSV, and names like `RPM` or `LTFT`
  through the channels the analysis found. A formula with a missing input, a
  function, or another platform's tag is listed with the reason, never computed
  from zeros. AFR inputs are put on one stoich first: the seed "AFR error"
  formula read 1376% on a real log, because commanded was in λ and the wideband
  in AFR. It now reads +0.46%, matching the closed-loop check.

### Fixed

- **Under the macOS agent, tools installed with Homebrew were "not
  installed".** launchd's `PATH` lacks Homebrew, so the app could not find `gh`.
  The agent now records the `PATH` it was installed from; re-run
  `sh scripts/autostart-macos.sh install` once to pick this up.
- **Units read from a log no longer report a channel's name as its unit**
  ("SAE" for Fuel System Status); text in brackets that is not a unit now shows
  as "not stated".
- **One expression compiler** (`app/modules/expr.mjs`) now serves both XDF
  scaling and math channels, so the unary-minus and power fixes live in one
  place.

## [0.45.0] - 2026-10-04

A full code audit, and guards that keep the public project in step with its
source. **Update promptly**: the first two fixes close holes that let any web
page you visit write files on your computer, or read your tunes, through the
app.

### Security

- **Any website could write files through the app.** The server binds to
  127.0.0.1, which keeps the network out but not your browser: a page can send
  a plain POST to localhost without asking. The upload endpoint also put its
  `date` and `rev` values into file names unchecked, so one such request wrote
  a file outside the repository, wherever your account can write. This was
  demonstrated against the running app before the fix. The session `date` had
  the same flaw. Now:
  - the server refuses any request whose `Host` or `Origin` is not its own,
    which also stops a site using DNS rebinding to read your tunes and VIN;
  - writes must carry an `X-Tuning-Garage` header that other sites cannot add;
  - dates and revisions are validated, and every file written is confined to
    its folder.
- **A file name could run code in the app.** 33 click handlers placed names
  into `onclick` strings in a way the browser decodes before running them, so a
  quote ended the string. A VCM Scanner file named to carry code would have run
  it inside the app, which can write files and push to git. Every handler now
  passes values as proper JavaScript strings. A test proves this with hostile
  names, and another refuses the old pattern anywhere in the page.

### Fixed

- **XDF tables read wrong values.** A minus after `*` or `/` was mis-parsed:
  `X*-2` at X=3 gave −2 instead of −6, `X/-4` gave nothing, and `X*-0.1+40` at
  100 gave 39.9 instead of 30. Floating-point tables were decoded as integers,
  so 1.5 read as 1069547520. `^` now groups right to left.
- **Editing a User Math formula erased what the form doesn't show**: its
  platform and assumptions (the Gen 5 quarantine), and the flag that decides
  whether a sample formula ships publicly. Edits now merge into the entry.
- **The quick log summary was wrong for every HP Tuners log.** It reported one
  channel named "HP Tuners CSV Log File". It now uses the analyser's parser
  and its timestamp clean-up: a single corrupt timestamp had made a 35-minute
  log report 16,777 s.
- **A CRLF checkout emptied the Progression tab and the flash log**, so every
  revision showed as never flashed. Git for Windows offers CRLF by default.
  Markdown and JSON are now kept LF in every checkout, and the server reads them
  line-ending-blind either way.
- **Read errors no longer pass for empty files.** An unreadable `vehicle.md` or
  flash log showed as "nothing flashed", and an unreadable definitions folder as
  "none"; both now show the error. An unreadable donor index is no longer
  rewritten over its moves log.
- **Recording a flash validates first.** A revision containing `|` broke the
  flash-log table, and a profile missing one of its bullets got half a record.
  Both are now refused before anything is written.
- **The submission workflow turned every fork pull request red.** A fork's
  read-only token cannot post the analysis comment; the step no longer fails
  the check, and the analysis is in the run summary. Its header also wrongly
  claimed it ran no contributed code.
- **The submission tool** never found the GitHub CLI on Windows, put a VIN in
  the public issue title if the file name held one, and posted without asking.
  It now finds `gh` on any system, refuses a VIN-like file name, and asks
  before posting (`--yes` skips the question).
- **The scrubber misaligned columns** when it removed a GPS channel from a log
  whose names contain commas, as an AEM channel's do.
- **A failed submission alert counted as sent**, so that submission was never
  announced. It is now retried on the next poll.
- **The public app assumed the author's car.** "(your P01 is)", a P01-specific
  warning on other-platform formulas, a default write adapter, and a hardware
  brand in a placeholder are gone. The adapter field now offers whatever was
  used for the last recorded flash.
- **The bin analyser said its checksum maths was unvalidated.** It verifies on
  two real P01 reads and catches a single changed byte; the note now says so,
  and that P59 is still unchecked.
- **Smaller fixes:**
  - The knock tables label load in the log's own unit, and state IAT's unit.
  - "Check-in failed" no longer appears when only the changelog step failed.
  - Commit & push says when it pushed an earlier commit.
  - The document viewers show errors as errors, and follow `#anchor` links.
  - The git identity hint no longer uses `&&`, which PowerShell rejects.
  - A collision rename no longer touches folder names.
  - The relocate check judges paths inside the repo.

- **Two public releases, v0.31.2 and v0.31.3, had no source tag.** Their
  sources were identified by reproducing them exactly and are now tagged.
- `scripts/update.mjs` no longer runs when imported, and compares paths
  case-insensitively on Windows when deciding whether it was invoked directly.
- **The Windows launcher blamed the port when Node was missing.** A missing
  `node` returns error code 9009, which the launcher read as "port in use by
  something that is not this app". It now checks for Git and Node.js 18+ up
  front and names whichever is missing. The Mac launcher does the same.
- **A broken checkout was also reported as "port in use".** The version check
  now has its own exit code for a missing or versionless `app/server.mjs`, and
  both launchers say what is actually wrong.
- **`start-tuning.cmd` is checked out with CRLF line endings.** cmd.exe can fail
  to find a `goto` label in a batch file with LF-only endings, depending on
  where the label falls, and the launcher is built on `goto`. It worked by
  luck of layout. The update script applies the same rule to files it
  installs.
- The launcher's "use another port" hint no longer prints a chained `&&`
  command, which PowerShell rejects. Its console window is titled
  "Tuning Garage".

### Added

- **Every public release is checked against its source.** The public
  repository must be exactly the export of the source at the same tag, with
  nothing committed there directly. This is checked on every push to the
  source, once a day on a schedule (a change merged on the public side would
  otherwise go unnoticed until the next release erased it), and before every
  publish. All 22 public releases, v0.31.0 to v0.44.0, reproduce byte for byte.
- **Publishing refuses a release it could not reproduce later**: from
  uncommitted source, from a commit that isn't the version's tag, or with the
  tag unpushed. It also refuses while the public repository has commits the
  source doesn't, which would otherwise be silently erased.
- **The export accounts for every file.** Each tracked file must be either
  shipped or explicitly kept private, so a new file can no longer miss a
  release, or slip into one, unnoticed. Hand-written public versions of files
  (README, CI workflow, platform data) must be re-reviewed whenever the source
  they were written from changes.
- **The update script's promise is tested against the docs.** The README and
  User Guide list what an update never touches; a test checks that the update
  script protects exactly those paths.

## [0.44.0] - 2026-10-04

A clear update path for template users, and a documentation pass over the
public kit.

### Added

- **`scripts/update.mjs` updates your copy to a new release.** "Use this
  template" creates a repository with no shared history with the project, so
  `git pull` could never deliver a release, and nothing said so. The script
  shows the release notes and every file it will change, then asks. Project
  files you never edited are replaced. Ones you edited are merged, and a
  collision keeps your version with the new one saved beside it as `.new`.
  Your data is never touched: `vehicles/`, `PROGRESSION.md`, your formulas,
  preferences, scanner configs and definitions. It runs the tests and commits;
  if they fail, it undoes everything. `--check` only reports, and `--to` pins a
  release. Copies on v0.43.0 or earlier fetch the script once; the User Guide
  gives the command.
- **Release notes for template users.** The kit now ships `CHANGELOG.md` with
  every release from 0.40.0 on, and each publish creates a GitHub Release, so
  **Watch → Custom → Releases** notifies you. The update script shows the same
  notes before it changes anything.
- **"Updating to a new release"** in the User Guide (section 9) and both setup
  guides. Hovering the version in the app's header shows the command.

### Fixed

- **A private copy's CI failed on every push once it held a tune file.** The
  shipped workflow refused `.bin`, `.hpt` and `.hpl` files, which is right for
  the public project and wrong for a private copy that exists to hold them.
  The binary, scrub and submission checks now run only on the public project.
  The next update replaces the workflow in existing copies.
- **Commit & push attributed your commits to an AI model.** Every commit made
  through the app carried a `Co-Authored-By: Claude` trailer. It is gone; the
  commit is yours.
- **The public README described the author's own repository**: files that
  don't ship (the release tooling, a backlog, a donor folder), a stale test
  count, and no word on updating. Template users now get a README written for
  them. It covers getting started, updating, and which files are theirs and
  which the project's.
- **The Windows guide said the repository lives in `Documents\Tuning`**, the
  OneDrive-synced location its own warning tells you to avoid.
  `SETUP-WINDOWS.html` had drifted from the Markdown and is now generated from
  it, and `check-docs` fails if they disagree.
- **The "issue forms" link in CONTRIBUTING pointed at your own repository's
  issues** inside a private copy. It now points at the project.
- **Maintainer-only setup** (issue labels, submission alerts) moved out of the
  Mac setup guide into `MAINTAINING.md`. Troubleshooting rows that only
  applied to old versions were removed, and the User Guide's section on
  exporting a starter kit, which used tooling that doesn't ship, was replaced
  by the update section.

## [0.43.0] - 2026-10-04

A direction audit: every lean/rich, trim, VE and knock figure checked for
being read the wrong way round. On the author's three real logs, results are
independently recomputed and **unchanged**. The physics agrees with the app:
commanded AFR ÷ commanded λ is constant to 0.58%, the wideband reads rich
when the narrowband O2 sensors do, and short-term trim pulls fuel after
rich readings. A synthetic truth table, however, failed 16 of 26 cases, each
one export setting away from a real log. It is now a permanent test suite.

### Fixed

- **A commanded channel could be taken for the wideband.** "Air-Fuel Ratio
  Commanded [AFR]" matched the wideband pattern on its unit. Commanded was then
  compared with itself, giving a constant −3.9% (14.124 ÷ 14.7), and lean was
  never reported. Commanded and target channels are now excluded from the
  wideband role, and one column can't fill both.
- **Throttle could be read in volts.** "Throttle Position Sensor [V]" came
  before "Throttle Position (SAE) [%]" in a real logging layout and was chosen.
  On a pull, the WOT threshold would never be met and every knock event would
  be marked possible false knock. Every role now refuses a channel whose
  declared unit doesn't fit, and names the refused channel if none is left.
- **A name saying "equivalence ratio" was trusted as EQ.** HP Tuners' SAE
  "Equivalence Ratio Commanded" is λ, so on a log exported without units it
  read inverted. With no unit the scale is now worked out from the data: the
  commanded-AFR pairing, which way commanded moves at WOT, or the narrowband O2
  sensors. Only with no evidence is λ assumed, with a warning. With its unit
  stripped, the cruise log resolves to λ and still shows 626 of 708 lean.
- **"EQ Ratio Commanded" and "Commanded EQ Ratio" weren't recognised** as
  commanded channels, so only the λ 1.0 backstop ran.
- **Knock retard logged as negative numbers was ignored.** All-negative values
  are now read as magnitude, and mixed signs are flagged.
- **psig was read as absolute psi**, which would have shifted load cells by
  101.3 kPa. Gauge pressure is now refused with the reason.
- **Unitless trims near 1.0 are refused as multipliers** instead of being
  summed as percent.
- **The PCM stoich included engine-off rows.** With the key on and the engine
  off, commanded AFR reads about 5.4 while commanded λ reads 1.00. Those rows
  are now excluded; on the author's logs the result was unaffected (14.124).

## [0.42.0] - 2026-10-04

Three defects found by an idle log containing a hot restart, a wideband that
was off and then heating, and an hour of rows written with the key off.

### Added

- **Rows written after the PCM stopped reporting are removed** before any
  analysis. They are detected by module voltage below 8 V, or by every channel
  staying identical for 30 s or more, and are shown as "PCM not reporting" in
  the filtered-out table with a warning. The idle log carried 4.8 minutes
  of engine data and 60.3 minutes of frozen key-off rows: 103,247 rows are now
  removed. Before, its VE section offered ×0.4975 from 102,449 dead rows and its
  airflow comparison read +257.4%.
- **Wideband readings richer than λ 0.60 are rejected**, along with the 2 s
  after each stretch, because they come from the controller, not the engine.
  The AEM read 7.3125 AFR with no power and λ 0.50–0.53 for 27.5 s after key-on.
  That produced "190 power-enrichment samples at λ 0.526" (now 0) and dragged
  the closed-loop check from λ 1.005 (+0.5%) to λ 0.992 (−0.8%). Lean-pegged
  readings are kept.

### Fixed

- **A hot restart was taken for closed loop switched off.** 0.41.0 treated
  "OL - Not Ready" with warm coolant as deliberate open loop. A restart at
  185 °F sat in it for 16 s while the O2 sensors heated. "Not ready" is now
  warm-up for up to 120 s after an engine start, until closed loop is first
  reached, as well as whenever the coolant is cold.
- **The loop cross-check counted the status channel being right as
  disagreement.** "Not ready" and decel fuel cut with stoich still commanded
  are now counted as explained. Only unexplained disagreement can trigger the
  warning. The idle log goes from 92.7% (warning) to 0%, and the cruise log
  from 3.9% to 0.1%. No other figure in either cruise log changed.

## [0.41.1] - 2026-10-04

### Fixed

- **The starter kit export left out the Fuel System Status tests.** The export
  ships tests from an explicit list, and `fuel-status.test.mjs` was not on it,
  so the public kit would have received the 0.41.0 code without the tests that
  cover it.

## [0.41.0] - 2026-10-03

### Added

- **Fuel System Status is now read and used.** HP Tuners logs SAE PID 03 as
  text ("CL - Normal", "OL - Not Ready", "OL - Accel/Decel"), and the app
  counted only numbers as data. It reported a live channel holding 4,057
  samples as "logged but contains no samples" and guessed closed loop and
  power enrichment from commanded λ. The status now decides closed and open
  loop for trims, wideband and VE. Numeric SAE codes (1/2/4/8/16) and plain 0/1
  closed-loop flags are also decoded.
- **The commanded-λ inference remains as a cross-check.** The trim section
  shows how often it agrees with the status channel, and a warning appears
  above 5% disagreement. Status values that cannot be read are counted
  separately as "loop state unknown", never as open loop, and named in a
  warning.

### Fixed

- **Cold warm-up was judged as power enrichment.** In the cruise log, 539 rich
  "OL - Not Ready" samples taken with the engine cold went into the lean check,
  most of them as WOT bins at 500–1,500 RPM. They are now excluded, and the excluded count is shown. The lean
  finding stands: 626 of 708 real enrichment samples above 2,000 RPM run more
  than 3% lean of commanded (+5.5% to +7.8%).
- **MAF trims included open-loop rows that commanded stoich.** In the 3,500 Hz
  bin, 298 rows the status reports as open loop were taken for closed loop, which
  pulled its average trim towards zero. It moves from −10.25% to −13.8%
  (multiplier 0.8975 → 0.862).
- **VE could correct cells from decel fuel cut.** With the status logged,
  "OL - Accel/Decel" at λ 1.00 is skipped as DFCO (the wideband reads air
  there), and warm-up rows are skipped as wall-wetting. Warm "not ready" rows
  at stoich now count as open loop, so a session with closed loop switched off
  for VE work is no longer thrown away.
- Rows rejected for having no data, or for having only one live trim channel,
  now show readable labels in the "Filtered out" table instead of internal key
  names.

## [0.40.1] - 2026-10-03

### Fixed

- **The user guide said both stoichiometric ratios were shown in the wideband
  section; only one was.** The wideband's display stoich was an input field and
  the PCM stoich derived in 0.40.0 appeared nowhere. Both are now stated in the
  section header with how each was arrived at — on the author's car, "Wideband read at
  14.7 AFR = λ 1.00 · PCM stoich 14.124 (derived from 7024 closed-loop samples)".
  The fuel setting is labelled "display only", since that is all it now does.

## [0.40.0] - 2026-10-03

A calculation audit of the log analysis. Nine defects, each reproduced by a
failing test before it was fixed (`scripts/test/audit-regressions.test.mjs`),
and every number that moved on the two real logs accounted for.

### Fixed — safety

- **A dangerously lean condition showed a green checkmark.** The WOT lean test
  was absolute — measured λ above 1.0 — so it only caught "leaner than
  stoichiometric", which is already catastrophic. A bin commanding λ 0.85 and
  getting 0.95, 11.8% leaner than asked, was not flagged and the UI read
  "✅ No WOT samples leaner than λ 1.0". Lean is now judged against what was
  **commanded**, warning above **3%** (configurable); the absolute limit stays
  as a backstop.
- **Power enrichment was never lean-checked below 80% throttle.** Found while
  verifying the fix above. With no PE channel logged, only TPS ≥ 80% qualified,
  so a real log peaking at 72.9% throttle had **zero** qualifying samples —
  while nine cells ran 5.5–8.8% lean of commanded. Commanded enrichment
  (λ < 0.98) now counts, disclosed as an inference. On that log: 629 of 1,256
  enrichment samples flagged, every bin above 2,000 RPM.

### Fixed — wrong numbers

- **One stoichiometric ratio converted two AFRs made with different ones.** A
  wideband's AFR is lambda × its *controller's display* stoich (14.7 by default
  on an AEM, whatever is in the tank); a PCM's commanded AFR is lambda × *the
  PCM's* stoich — **14.12** on the author's car, derived from 7,024 paired closed-loop
  samples. Using 14.7 for both meant a log with only an AFR commanded channel
  read λ 0.9605 in closed loop: the trim analysis kept **1 row of 21,078**, and
  the VE grid **silently** computed corrections from closed-loop cruise data.
  The PCM stoich is now derived from the log (paired channels, or the
  closed-loop plateau of commanded AFR) and the analysis refuses rather than
  assume when it cannot be. The fuel setting now drives display only.
  *Results on the author's car were unaffected:* it logs commanded mixture in λ, and the
  AEM is on its default 14.7 display.
- The fuel table labelled 14.7 as "Gasoline (E10 pump)". 14.7 is the E0 figure;
  E10 is ≈14.08 and is now listed separately.
- **Knock decay was attributed as knock.** GM retard is applied instantly and
  decays; every non-zero value was credited to whichever cell the engine was in.
  One event traced at t = 104.4–107.3 s rose in **2** cells and was reported in
  **6**, and the spark grid would have pulled timing from four cells that never
  knocked. Only a rise is now credited.
- **The WOT error compared two different populations** — every wideband sample
  against only those that also carried a commanded value. An on-target bin read
  14.7% lean in the test case. Now paired samples only.

### Fixed — biased statistics

- **The steady-state filter was blind on held rows.** Channels log at their own
  intervals (TPS every 200 ms) on a 100 ms grid, so a throttle ramp is a jump
  then a held row with a delta of exactly zero. It now compares across a 300 ms
  window, null-safely. On the real logs this rejected 176 and 278 more transient
  rows and moved MAF corrections by −0.78 to +0.52 points.
- **Trims were summed from incomplete rows.** With only STFT live, `0 + STFT` was
  averaged with full `LTFT + STFT` rows. Such rows are now skipped and counted as
  `incompleteTrim`.
- **XDF division by zero returned 0** — in two places, the second silently
  undoing a fix to the first. It is now undefined, and the table diff neither
  counts such cells as changed nor lets them poison the average.

### Changed

- Empty rows (the gap between logging sessions) are counted as `noData` rather
  than blamed on the trims: 12,694 rows on the real log were mislabelled.
- A wideband test asserted the stoich conflation as correct behaviour — its
  header said "E85 changes the AFR math, not the lambda", and its assertion
  checked the opposite. Corrected to match its own header.
- New options: lean margin (% of commanded), and the wideband's display stoich.
  450 assertions.
