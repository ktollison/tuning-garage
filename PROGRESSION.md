# Tuning Progression Tracker

Status key: ⬜ not started · 🟡 learning · 🟢 comfortable

Update after each session — bump statuses, add the session link in Notes.

---

## Stage 1 — Foundations

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| Reading & backing up the PCM (full stock read) | ⬜ | |
| Flashing basics & write types (cal-only vs full) | ⬜ | |
| Recovery: what to do after a failed flash | ⬜ | |
| HP Tuners licensing (credits, VIN/OS locking) | ⬜ | |
| Commercial suite vs open-source J2534 — when to use which | ⬜ | |
| OS IDs, segments, and checksums (P01 layout) | ⬜ | |

## Stage 2 — Datalogging

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| Choosing logging channels (what matters, what's noise) | ⬜ | |
| Reading STFT/LTFT — what the trims are telling you | ⬜ | |
| Histograms & scanner math (trim vs MAF Hz, VE error) | ⬜ | |
| Wideband O2 basics (when narrowband isn't enough) | ⬜ | |
| Knock retard logging & separating true vs false knock | ⬜ | |

## Stage 3 — Fueling

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| MAF calibration (trim-based, then wideband) | ⬜ | |
| VE table / speed density (MAF-fail and blends) | ⬜ | |
| Power enrichment (PE) — WOT AFR targets | ⬜ | |
| DFCO & decel behavior | ⬜ | |
| Closed loop vs open loop — when the PCM listens to O2s | ⬜ | |

## Stage 4 — Spark

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| High/low octane tables & how they blend | ⬜ | |
| Timing vs load — reading the spark tables | ⬜ | |
| Diagnosing knock retard and pulling timing safely | ⬜ | |
| Spark corrections (IAT, ECT adders) | ⬜ | |

## Stage 5 — Drivability (LS1 / manual-specific)

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| Idle tuning (base airflow, adaptive idle) | ⬜ | |
| Throttle follower / cracker | ⬜ | |
| CAGS / skip-shift delete | ⬜ | |
| Fan on/off temps | ⬜ | |
| Rev limiter & speed limiter | ⬜ | |
| Torque management on a manual car | ⬜ | |

## Stage 6 — Tools depth

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| PCMHammer full read/write workflow | ⬜ | |
| UniversalPatcher: checksums, segment swaps, OS patches | ⬜ | |
| Comparing tunes across tools (bin vs hpt) | ⬜ | |
| DTC management (turning codes off the right way) | ⬜ | |

---

## Milestones

- [ ] Stock read archived and verified for your vehicle *(both formats, 2026-08-02: PCMHammer `.bin` — VIN <VIN>, OS <your OS ID>, all 8 checksums verify — plus the HPT `.hpt` base)*
- [ ] First successful flash (even a no-change write-back)
- [ ] First datalog reviewed end-to-end
- [ ] First fueling correction that measurably improved trims
- [ ] First full self-made tune revision daily-driven for a week
