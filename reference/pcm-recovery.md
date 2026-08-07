# Runbook — recovering a bricked Gen III PCM

For a P01/P59 that failed mid-write and won't respond. Written after the
2026-06-17 incident (`incidents/2026-06-17-p01-brick-during-sps2.md`).

**Read this before your first write, not after your first brick.** Knowing
the solder-pad location and the timing variants in advance is the difference
between a bad afternoon and a dead module.

## First: is it actually bricked?

Failed-write symptoms escalate in a specific order. Where you land tells you
how bad it is:

| PCMHammer says | Meaning |
|---|---|
| `Unlock was not successful` | Comms fine, security handshake failing — least bad |
| `PCM is in recovery mode` | **Good news** — the boot block is alive and listening |
| `Recovery mode failed` | It isn't confirming the boot-block state |
| `Not responding to OSID, kernel version, or recovery mode checks` | Total silence |
| `Unable to transmit` (repeated) | Can't even key the bus — adapter, wiring, or a transceiver in a bad state |

Rule out the boring causes first: **the harness reads a different known-good
PCM**, connectors fully seated, voltage measured **at the PCM's own pins**
(not just at the supply readout).

## Bench setup

- Supply at **13.7–14 V** with the **current limit opened up** (no 3.5 A cap).
  Watch for a constant-current/CC indicator during the attempt — if it lights,
  you were current-limiting.
- P01 bench harness: constant 12 V to **pin 20**, ignition 12 V to **pin 19**.
  *(Verify against your harness's own documentation — draft reading.)*
- Adapter in the **correct mode for the tool** — check whether your interface
  needs native/COM mode rather than J2534 for the software you are using.

## Forcing recovery mode

Two different grounds get conflated. For a fully silent module, it's the
internal one:

1. **Internal solder pad (the real recovery trigger).** Open the case; briefly
   ground the pad — same location on P01 and P59 boards, next to two vertical
   components — to the **bare metal** of the case. Reference photos:
   <https://www.customecm.com/tune-file-repo-and-info-here/diy-gen-3-gm-bricked-pcm-recovery>
   (the second photo is the P01 board). Mark the pad with a paint pen once
   you've identified it.
2. **External connector pin** (commonly cited as pin 23 on the blue connector,
   varies by variant) — no disassembly, but reported as insufficient for
   hard-bricked modules.

**Timing has two variants — try both:**

- **Momentary:** ground for ~1 second at power-up, then release.
- **Hold-through:** keep it grounded while you start the read in PCMHammer,
  releasing only once the log shows activity.

If holding produces `unable to transmit`, the ground may be interfering with
the bus — switch to releasing right as the command fires.

## The attempt, in order

1. Full power rest — everything disconnected, **10–15 minutes**.
2. Supply to 13.7–14 V, current limit fully open.
3. Fresh PCMHammer session (restart the app, re-select the device).
4. Power the PCM, apply the ground per one of the timing variants.
5. Start **Read Properties** or **Read Entire PCM** while grounded.
6. Watch for `PCM is in recovery mode` — that's the win. Then write a
   **known-good full bin** (this is what the archived stock read is for).

## When to stop

**Results getting worse across attempts** (silence → unable to transmit) means
something is unstable or degrading — stop, rest, re-inspect the pad and clip
for shifted contact or solder bridging. More attempts in that state make
things worse, not better.

**The definitive stop signal: two known-good adapters both fail to reach
recovery mode.** Recovery lives in the on-flash bootloader at the start of the
flash chip and is hardware-protected — pad grounding only works while that
boot block is intact. If two different interfaces get nothing back, the boot
block itself is likely damaged and no amount of grounding or retiming will
help. That's the hard-brick line. (This is what happened to three P01s here in
2026 — see `incidents/`.)

After a handful of clean attempts with correct pad, both timing variants, full
current, and a second adapter tried, the remaining options are:

- **BDM interface** or **desolder and program the flash chip externally** —
  beyond bench-harness territory, but a real path if the module holds
  something worth preserving.
- **Replacement P01** — typically $60–100 used. Often the pragmatic call once
  you count the hours. (A donor then needs identity + calibration — see the
  FAQ's donor-PCM workflow.)

## Prevention (the actually important part)

- **Use a write-grade adapter for every write.** This lesson cost three
  modules. On an identical bench with identical software, one interface bricked
  them and another completed the same job cleanly. Bench programming was not
  the problem — the interface was.
- Archive the stock read. A local file means never needing SPS2 for stock.
- Prefer calibration-only writes when they'll do — bad cal flashes recover
  easily; bad OS flashes often don't.
- Full current headroom, stable voltage, nothing else on the bus (GM documents
  write failures caused by aftermarket devices wired into the comm bus).
- Use the adapter you have proven for writes, in the correct mode for the
  software.
- Have a second interface on hand — one tool can sometimes recover the other's
  failed write, and if both fail you've learned something definitive.
