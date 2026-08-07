# FAQ

Questions that came up in real work, answered once so they stay answered.
Add to this whenever something takes more than a minute to figure out.

---

## When do I need GM SPS2 to flash to stock?

**Short answer: only when you don't already have the stock file.** SPS2 is how
you *obtain* a factory calibration from GM. If you archived one, you don't need
GM at all — PCMHammer or HP Tuners will write your own file back for free.

**You need SPS2 when:**

- **A donor or used module needs the right calibration for your car.** The
  module carries some other vehicle's calibration and no stock file for your
  VIN exists locally. SPS2's "Override VIN" is the sanctioned path.
- **A new/blank service module** has to be programmed and configured.
- **You want true factory-stock and never captured a baseline** — the tune has
  been modified for years, nobody has the original, and "stock" has to come
  from GM's servers.
- **A GM recalibration or TSB update** applies to the vehicle.

**You do NOT need SPS2 when:**

- **You have your archived stock read.** Flash it back with PCMHammer or HPT.
  *This is the entire reason the stock read is treated as sacred in this repo —
  an archived baseline turns a subscription-and-internet errand into a
  five-minute flash.*
- You want a custom tune (HP Tuners / EFILive).
- You need checksum repair or segment work (UniversalPatcher).

**What it costs you:** an ACDelco TDS subscription (per-VIN or per-period), a
Windows machine meeting current requirements, a supported MDI 2 or J2534
interface, an internet connection, and an in-vehicle connection — SPS2 detects
and refuses bench programming. Details: [tools/gm-sps2.md](tools/gm-sps2.md).

---

## My PCM bricked mid-write. Is it dead?

Usually not immediately — but the window closes with bad attempts, so work the
runbook rather than improvising: **[pcm-recovery.md](pcm-recovery.md)**.

The three things that matter most: get the module into **recovery mode** via
the **internal solder-pad ground** (the external connector pin is not enough
for a fully silent module), give the bench supply **full current headroom**,
and **use an adapter in the right mode** — some interfaces expose both native
and J2534 modes, and the tool may support only one of them.

And the honest warning from experience: if results get *worse* across attempts
(silence → "unable to transmit"), stop. That pattern means something is
unstable or degrading, and more attempts make it worse. Rest, re-inspect, then
one clean attempt.

**The hard-brick line:** if two known-good adapters both fail to reach
recovery mode, stop for good. Recovery lives in a hardware-protected boot
block at the start of the flash chip; grounding the pad only works while that
boot block is intact. Two interfaces getting nothing means it probably isn't —
and the only remaining paths are BDM or programming the flash chip externally.
Three P01s here reached that line.

**And the prevention that actually matters: use a write-grade adapter for
every single write.** On one bench, with the same software and the same
operation, one interface bricked three PCMs while another completed the job
cleanly. Bench programming wasn't the problem; the interface was. Pick the
adapter you have *proven* on your own bench, and use it for every write —
there is no such thing as a write too small to matter.

Also worth knowing before you write: a bad **calibration** flash is easy to
recover from; a bad **OS** flash often isn't. Prefer cal-only writes when
they'll do the job.

Worked example: [incidents/2026-06-17-p01-brick-during-sps2.md](incidents/2026-06-17-p01-brick-during-sps2.md).

---

## Which adapter should I trust for flashing?

**The one you have proven on your own bench — and only that one.** It needs
genuine J1850 VPW support for Gen 3 GM, ideally 4x speed, and the correct mode
for the software driving it.

The author lost **three PCMs** to an interface the community rates highly, on
the same bench where a different interface completed the identical job cleanly.
See [tools/adapters.md](tools/adapters.md).

The general lesson: **adapter reputation is not a substitute for your own
results on your own bench.** A device that writes reliably for a hundred
people can still be the one that kills your modules — and the forum consensus
will not refund your PCM. Trust your log, not the leaderboard.

And a bricked PCM often isn't dead: PCMHammer has recovery paths, and a second
tool can frequently rescue the other's failed write, especially on bench power.

---

## Can I put a donor PCM in my car?

Yes, and it's a standard workflow on P01/P59:

1. **Read and archive the donor as received** — before changing anything.
2. **Write the car's identity** into it (VIN, serial, security) — PCMHammer's
   clone/serial functions, or LS Droid.
3. **Write the correct factory calibration** for the car's VIN with **SPS2**
   (Override VIN), unless you already hold a correct stock file to flash.
4. **Read it again and archive that** — that post-setup read is the baseline
   you'll actually tune from.

Keep both reads. The before/after pair documents exactly what changed, and the
app's bin compare will show you (see the C5's history for a worked example:
712 bytes differed, all of them identity).

---

## Where are my scanner layouts, channel lists and math parameters?

The **Scanner tab**, backed by `vcm-scanner/`. Files keep their original
VCM Scanner names, so downloading one and loading it back into the scanner
works unchanged.

The useful part: channel lists are just numeric ParameterIDs, but your charts,
graphs and layouts carry labels — so the app builds a dictionary from them and
uses it to name parameters in channel lists and to decode math expressions
(`([2312] * [50030.92] / [2126.240])*[50070.56]/15` becomes readable in terms
of Manifold Air and RPM). Coverage is limited to what you've charted, and
unknown IDs are shown as unknown, never guessed.

Math Lab parameters can be imported into the User Math repository with one
click, arriving as `unverified` with the decoded expression in their notes.

---

## What units is the app working in?

Every displayed number states its unit, and the full contract — what's
converted, what isn't, and where each unit comes from — is in
[units.md](units.md). Short version: log channels take their unit from the
column header, XDF tables keep the definition's units (so they match
TunerPro), computed values like fuel trim are always %, and the correction
multiplier is a **dimensionless ratio**, not a percentage.

Set your display preferences on the Datalogs tab; they're stored in the repo
so both machines agree. Anything converted for display names the unit it was
recorded in, and a channel whose header states no unit is shown as "not
stated" rather than assumed.

---

## How do I get a CSV out of VCM Scanner, and why should I?

`Scan → Open Log File`, then `Scan → Export` (verify the path on your version).
Full guide including a starting channel list:
[vcm-scanner-csv-export.md](vcm-scanner-csv-export.md).

Why: `.hpl` is proprietary and only HP Tuners can read it. Keep both — the
`.hpl` for HPT work, the `.csv` so the log stays readable by this app,
MegaLogViewer, Excel, and by you on a machine without a licence.

---

## Two of my bins look identical — how do I tell what actually changed?

Library or Tunes tab → **Compare two bins**. It reports total bytes changed
plus a per-region breakdown (OS, EEPROM identity block, and each calibration
segment) and flags cal ID or OS differences. Changes confined to the EEPROM
region mean identity only — same calibration, different car. That pattern is
the signature of a clone or a re-VIN, not a different tune.

---

## The app says a file's VIN doesn't match the vehicle. Now what?

Don't treat it as that vehicle's baseline. Either it came from a different car
(use **"Not this vehicle's file → move to donor files"** on the analysis card),
or the profile VIN is wrong. The app will not auto-complete the stock-read
milestone on a VIN mismatch — identity has to be proven, not assumed.

---

## Why does the repo want both a `.bin` and a `.hpt` baseline?

They're different views from independent tools, and each covers the other's
gap. The `.bin` (PCMHammer) is the open, parseable, full-flash truth — the app
can verify its checksums and read its OS ID and VIN. The `.hpt` (HP Tuners) is
what you'll actually open to make edits. Reading the same PCM with two tools
also cross-checks the read itself.

---

## What does "all checksums OK" actually prove?

That the file is internally consistent: each segment's stored checksum matches
the bytes in that segment, so the read wasn't truncated or corrupted. It does
**not** prove the file belongs to your car (check the VIN), that the
calibration is appropriate for your combination, or that a tune is any good.
