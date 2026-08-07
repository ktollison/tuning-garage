# Pre-Flash Checklist

Run through this **every time** before writing to a PCM. A failed flash with no
recovery plan is how PCMs become paperweights.

## Before anything else

- [ ] I accept the risk: a bad write can brick this module, and a bad
      calibration can destroy the engine. See `DISCLAIMER.md`.

## Power & connection

- [ ] Battery fully charged or on a maintainer (a voltage sag mid-write can brick the PCM)
- [ ] Key on, engine OFF; HVAC, headlights, radio off (minimize bus chatter and draw)
- [ ] Cable/adapter seated firmly; laptop on AC power, sleep disabled
- [ ] **Using the adapter I have proven for writes** — never an untested one
      (see `reference/tools/adapters.md`)

## Files

- [ ] Stock read is archived in `tunes/stock/` and verified readable
- [ ] The file being flashed is a **copy** with a `vNNN` name — never the stock original
- [ ] CHANGELOG entry written for this revision (what changed and why)
- [ ] Checksums valid (UniversalPatcher / tool confirms before write)

## Recovery plan

- [ ] **Writing through the interface I have proven for writes** — every write,
      no exceptions (see `reference/tools/adapters.md`)
- [ ] I have read `reference/pcm-recovery.md` **before** starting this write
- [ ] I know where this board's **recovery solder pad** is (marked with paint pen?)
- [ ] Bench supply current limit is **fully open** — not capped (a 3.5 A cap was
      the leading suspect in the 2026-06-17 brick)
- [ ] Adapter is in the **correct mode for the tool** — some interfaces expose
      both native and J2534 modes and tools do not always support both
- [ ] I have a second flash tool/adapter available (one can often recover the other's failed write)
- [ ] Cal-only write if that will do the job — bad OS writes are much harder to recover
- [ ] The car is somewhere it can sit if it won't start (not blocking, not remote)

## Sanity

- [ ] The change in this revision is small enough to attribute results to it
- [ ] I know what I expect the next datalog to show if the change worked
