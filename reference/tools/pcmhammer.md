# PCM Hammer (+ PCM Logger)

Free, open-source read/write/datalog suite for GM VPW-era PCMs.
Project moved to **github.com/PcmHammer/PcmHammer** (originally LegacyNsfw/PcmHacks).
User docs: **pcmhammer.github.io/users**. Windows-only, volunteer-built — treat every
release note seriously.

## Capability matrix (researched 2026-08-02)

| Capability | Status |
|---|---|
| P01 (512 KB) full read / write | Mature — the flagship target; C kernel, trusted |
| P59 (1 MB) full read / write | Mature (full OS writes came later than cal-only; use current release) |
| Cal-only vs full write | Both supported — cal-only is the routine flash |
| Clone (VIN, serial, BCC, security) | Supported — parameter-section cloning for PCM swaps |
| "Read Properties" | Pulls VIN, OS ID, cal ID, hardware ID, serial, BCC, MEC over the wire without a full read |
| Quick compare | CRC-based PCM-vs-file compare (~30 s) — verify a flash without re-reading |
| Datalogging | PCM Logger (bundled) with per-OS XML channel definitions |
| Other PCMs (P04/P05/P08/P10/P11/P12, E38, E54, BlackBox) | Experimental to varying degrees — check release notes before touching hardware. **2.0.0 (June 2026)** added P08, P11 and P12 support and fixed P10 image sizes |
| Crossflash protection (2.0.0) | VIN validation, and the PCM's service number checked so an incompatible image is refused before it is written |

## Workflow facts that matter to me

- Full read of my P01 = exactly **524,288 bytes**; anything else is a bad read.
  (The Tuning Garage app checks this on upload.)
- Output `.bin` opens in TunerPro with the OS-matched XDF — XDFs are **not**
  interchangeable across OS IDs.
- 4x (high-speed) VPW requires a capable adapter; some inexpensive interfaces
  work at 1x only, which makes a 512 KB read take 30+ minutes.
- Write flow: always "Test communications" first; battery maintainer on.

Release notes: <https://github.com/PcmHammer/PcmHammer/releases> (2.0.0 also
moved to .NET 4.6.2, hardened J2534 re-initialisation, and fixed the BlackBox
checksum and OBDLink CRC reads).

## Sources

- <https://pcmhammer.github.io/users/> (capabilities, supported PCMs/devices)
- <https://github.com/PcmHammer/PcmHammer> (source, releases)
- <https://pcmhacking.net/forums/viewtopic.php?t=6080> (dev thread)

## My gotchas (fill in from experience)

*(Your notes go here — this section ships empty on purpose.)*

