# GM Gen IV platform (E38 / E67 / E40) — family notes

Siblings: [gm-gen3.md](gm-gen3.md) · [gm-gen5.md](gm-gen5.md) · [global-b.md](global-b.md)

The CAN-bus generation, roughly 2005–2016. Where Gen 3 talked J1850 VPW, Gen 4
talks GMLAN/CAN — different adapters, different kernels, different bin layouts.

## ECM family

| ECM | Introduced | Typical engines | Notes |
|---|---|---|---|
| E40 | 2005 | early LS2 | short-lived transitional ECM; injector flow table caps at 64 lb/hr — a real ceiling with big injectors |
| E38 | 2006 | LS2 → LS3, LS9-era V8s, trucks/SUVs through ~2016 | the dominant Gen 4 ECM; Motorola MPC56x |
| E67 | 2009 | LSA (CTS-V), LS9 (ZR1), supercharged apps until LT4/2017 | near-identical to E38 plus supercharger tables |

## Architecture quirk that matters

E38/E67 have **two CPUs** — main and slave. The slave carries the
electronic-throttle (DBW) OS + calibration, and as of the research date **only
GM's own software writes the slave CPU**. Open-source flashing covers the main
CPU. Any future module/work here must respect that boundary.

## Open-source status (researched 2026-08-02)

- Active kernel/bootloader development on pcmhacking.net ("E38 E67 E40
  Kernel/Bootloader Development Extravaganza", thread t=6416) — reading and
  writing achieved in open source for main CPU.
- **PowerPCM_Flasher** — community E38/E67 flash tool (thread t=6666).
- PCMHammer lists E38 as **experimental** — check release notes per version.
- UniversalPatcher handles Gen 4 bins (checksums, analysis).
- Commercial: HP Tuners and EFILive both fully support Gen 4.

## What a future `gm-gen4` app module needs

- Bin layout differs from Gen 3 (no 0x500 segment table); OS ID/segment
  extraction rules must come from UP's XML configs or the kernel dev thread.
- File sizes vary by ECM — collect real reads before writing detection logic.
- Same verify-only philosophy: analyze, never modify.

## Sources

- <https://pcmhacking.net/forums/viewtopic.php?t=6416> (kernel dev)
- <https://pcmhacking.net/forums/viewtopic.php?f=3&t=6666> (PowerPCM_Flasher)
- <https://thetuningschool.com/blogs/news/differences-and-applications-of-gm-ecms>
- <https://pcmhacking.net/forums/viewtopic.php?t=7601> (PCM/ECM identification)
