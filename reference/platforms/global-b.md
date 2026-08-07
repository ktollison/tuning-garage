# GM Global B (VIP) platform (E99) — family notes

Siblings: [gm-gen3.md](gm-gen3.md) · [gm-gen4.md](gm-gen4.md) · [gm-gen5.md](gm-gen5.md)

GM's cybersecurity-era electrical architecture, 2020+ — C8 your-car (LT2),
CT5-V Blackwing, newer trucks. ECM: **E99**. Firmware is signed/locked; this is
the generation where "just flash it" died.

## State of tuning (researched 2026-08-02)

- Stock E99s cannot be tuned over OBD by any consumer tool.
- **HP Tuners' path**: a one-time **physical send-in ECM service** — you pull
  the E99, ship it to HP Tuners, they modify it, then you get full calibrate/
  log/scan over OBDII. Requirements:
  - **MPVI3 only** (MPVI2+ and older explicitly not compatible with Global B)
  - VCM Suite **BETA**
  - Supported: e.g., 2024 C8 6.2L LT2 (non-Z06); check current coverage
- Aftermarket shops resell the same service (Livernois, Deep Stage, etc.).

## What this means for the Tuning Garage

- Documentation/metadata only — there will likely never be an open bin format
  here. If a Global B vehicle enters the garage, the repo tracks its files as
  opaque blobs + the unlock service paperwork/dates in `vehicle.md`.
- My MPVI3 is the right hardware if this ever comes up.

## Sources

- <https://www.hptuners.com/product/gm-e99-ecm-service-global-b/>
- <https://www.hptuners.com/gmglobalb/>
