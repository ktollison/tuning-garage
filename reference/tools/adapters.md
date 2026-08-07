# Adapters (Gen III GM = J1850 VPW)

The whole Gen 3 ecosystem talks **J1850 VPW**. High-speed ("4x") support is what
separates a three-minute read from a thirty-minute one — but speed is worth
nothing if the write doesn't complete.

## The rule that matters most

> **Prove the adapter you write with, on your own bench, before you trust it
> with a write.**

This is not generic caution. The author of this toolkit lost **three PCMs** to
an interface the community rates highly — the same bench, the same software and
the same operation completed cleanly once the interface was swapped. One
variable changed and the outcome flipped.

The generalisable lesson: **adapter reputation is not a substitute for your own
results.** A device that writes reliably for a hundred people can still be the
one that kills your modules, and the forum consensus will not refund a PCM.
Establish which interface works on *your* setup with something you can afford to
lose, then use only that one for writes.

## What to look for

| Requirement | Why |
|---|---|
| Genuine **J1850 VPW** support | Gen 3 GM speaks nothing else. Several J2534 devices advertise VPW without implementing it |
| **4x / high-speed** mode | Without it a 512 KB full read takes 30+ minutes, and a battery tender becomes mandatory |
| The **correct mode for your software** | Some interfaces expose both a native mode and a J2534 mode, and tools do not always support both. The wrong mode fails hardest during recovery, when timing matters most |
| A **second interface** available | One tool can sometimes recover another's failed write — and if both fail, you have learned something definitive |

Community-maintained compatibility lists are the place to start:
<https://pcmhammer.github.io/users/supported-devices>. Treat them as candidates
to test, not as guarantees.

## Known non-starters

Some devices claim VPW in their driver documentation without ever having
implemented it, and some inexpensive clones omit the J1850 circuitry entirely
while advertising the protocol. Check community reports for your exact model
and revision before buying.

## Which adapter for which job

| Job | Tool |
|---|---|
| Datalogging / commercial-suite flashing | Your commercial interface (MPVI3, FlashScan, …) |
| Full bin read/write on P01/P59 | A VPW-capable J2534 interface you have proven, with PCMHammer |
| Factory calibration programming | A supported pass-thru, with GM SPS2 / Techline Connect |
| Bin surgery (offline) | No interface needed — UniversalPatcher / TunerPro |

## Record your own results here

Replace this section with what *your* bench actually did. That record is worth
more than any list someone else wrote.

| Adapter | Verdict | Notes |
|---|---|---|
| | | |
