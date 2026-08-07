# GM factory programming — SPS2 / Techline Connect

The manufacturer's own programming path. Not a tuning tool: SPS2 writes
**GM factory calibrations only**, chosen by VIN. It's how you get a blank,
donor, or modified module back to a legitimate factory calibration.

Researched 2026-08-02 — subscription terms, OS requirements and device
support change; verify current details before buying.

## The stack, in current names

| Piece | What it is |
|---|---|
| **ACDelco TDS** (acdelcotds.com) | The account and subscription portal for non-dealer users |
| **Techline Connect** | The desktop application that hosts the tools |
| **SPS2** | Service Programming System, 2nd gen — module programming/calibration, inside Techline Connect |
| **GDS2** | Global Diagnostic System 2 — diagnostics, not programming |
| **Service Information (Si)** | Factory service manuals/procedures |
| (historical) TIS2Web / TIS2000 | The predecessors SPS2 replaced |

## What SPS2 does and doesn't do

**Does:** retrieve the latest GM calibration(s) for a specific VIN and write
them to the module · program a new/blank service module · set up and configure
a module after replacement · apply TSB/recall recalibrations.

**Does not:** custom tuning of any kind. There are no table edits, no
parameter changes. That's what HP Tuners, EFILive, and UniversalPatcher are
for — and any custom work must come *after* SPS2, not before (SPS2 overwrites).

## Requirements

- **Subscription** — through ACDelco TDS. Sold per-VIN and per-period
  (2-day / month / year); community reports around **$45 for a VIN slot**
  with a long validity window. Check current pricing.
- **Windows** — current GM software requires Windows 11 **Pro** (Home and
  Win 10 are no longer supported); 16 GB RAM recommended for programming.
- **Interface** — GM MDI 2 (hard-wired Ethernet preferred, USB acceptable),
  the older Tech 2, or a **supported J2534 pass-thru** (MongoosePro GM II,
  VXDIAG VCX Nano, AEZ Flasher and similar).
  ⚠️ **Counterfeit/clone MDI devices get your account locked.** Legitimate
  aftermarket J2534 devices are unaffected.
- **Internet** — calibrations are pulled from GM's servers per session.
- **Stable power** — a maintainer, as with any flash. A voltage sag during a
  factory write is just as fatal as during an aftermarket one.
- **In-vehicle connection** — SPS2 detects off-board/bench programming and
  refuses it; it wants to see the vehicle. Bench work needs a harness that
  presents a convincing vehicle, and even then this is the friction point
  people hit most.

## Donor / used modules

SPS2 notices when the module's stored VIN doesn't match the session VIN and
offers **"Override VIN"** — that's the sanctioned path for putting a used or
donor module into a different car. Combined with an aftermarket tool for the
serial/identity block, that's the standard donor-PCM workflow.

## Where it fits alongside the aftermarket tools

| Goal | Tool |
|---|---|
| Factory calibration onto a blank/donor/modified module | **SPS2** |
| Restore a calibration you already archived | PCMHammer or HP Tuners — no subscription needed |
| Custom tuning | HP Tuners / EFILive |
| Bin surgery, checksums, segment swaps | UniversalPatcher |
| Free read/write/clone on P01/P59 | PCMHammer |

## Sources

- <https://www.nexus-auto.net/blogs/news/gm-techline-connect-sps2-module-programming-guide>
- <https://lswiring.com/blogs/bench-programming/gm-service-programming-system>
- <https://knowledgebase.aetools.us/gm-j2534-pass-thru-device-setup-for-sps2-/-gds2-/-techline-connect-aez-flasher-3-mdi-2>
- <https://www.acdelcotds.com>

## My notes (fill in from experience)

*(Your notes go here — this section ships empty on purpose.)*

