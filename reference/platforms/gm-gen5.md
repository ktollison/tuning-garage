# GM Gen V platform (E92) — family notes

Siblings: [gm-gen3.md](gm-gen3.md) · [gm-gen4.md](gm-gen4.md) · [global-b.md](global-b.md)

Direct-injection generation, 2014+ — EcoTec3 trucks (4.3L V6, 5.3L, 6.2L) and
LT-series cars (LT1 C7, LT4). ECM: **E92** (and variants).

## State of tuning (researched 2026-08-02)

- **No open-source path.** This generation is commercial-tool territory:
  - **EFILive** — E92 support since May 2013; full read under 4 minutes,
    cal reflash ~30 seconds.
  - **HP Tuners** — full support in VCM Suite.
- Direct injection adds high-pressure fuel tables and different airflow
  modeling vs Gen 3/4 — the tuning concepts transfer, the tables don't.

## Locking landscape

- **Tunerlock / EFILocker**: a shop can change the key (password) in the
  module without changing the seed, breaking the standard seed→key
  calculation so other tools can't unlock it. Recovering a custom-locked E92
  means bench brute-force — up to a week.
- Practical rule: know the lock state of any Gen 5 ECM before buying/tuning.

## What this means for the Tuning Garage

- A `gm-gen5` module is **metadata-only** realistically (no open bin format
  documentation to port). The repo still handles E92 tunes fine as opaque
  versioned files with session/changelog discipline.

## Sources

- <https://forum.efilive.com/archive/index.php/t-22637.html> (E92 support release)
- <https://www.customecm.com/tune-file-repo-and-info-here/gm-tunerlock-info>
- <https://ls1tech.com/forums/pcm-diagnostics-tuning/1648630-e92-supported-efilive.html>
