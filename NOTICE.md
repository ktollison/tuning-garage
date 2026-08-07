# Copyright and attribution

Tuning Garage — a process and history layer for DIY engine tuning.

Copyright (C) 2026 Kevin Tollison

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. The full text is in [LICENSE](LICENSE).

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

**The warranty disclaimer is not a formality here.** This software sits next to
a process that can destroy an engine or leave a control module unrecoverable.
Read [DISCLAIMER.md](DISCLAIMER.md) before using it.

---

## Why this project is GPL-3.0

Not a preference — an obligation, and one worth stating plainly.

`app/modules/gm-gen3.mjs` is a port of work by **Jouko Kylmäoja**:

| Project | Source | Licence |
|---|---|---|
| [PCMBinBuilder](https://github.com/joukoy/PCMBinBuilder) | `Source/PCmFunctions.cs` | GPL-3.0 |
| [UniversalPatcher](https://github.com/joukoy/UniversalPatcher) | — | GPL-3.0 |

What was taken: the P01/P59 bin layout (segment table at `0x514`, OS ID at
`0x504`, the EEPROM block and its `0xA0A5` check word) and the checksum
algorithm — a 16-bit two's complement of the big-endian word sum. Translating
code into another language produces an adaptation, so this project inherits
GPL-3.0 and could not have been licensed any other way.

Thanks are owed regardless of the licence. Gen III tuning is only open to
hobbyists because a handful of people documented these formats and gave the
work away.

---

## Referenced, not derived from

Named in the documentation for interoperability. No code or data from any of
them is included, and none of them endorse this project:

- **PCMHammer** — open-source Gen III flashing tool
- **HP Tuners** (VCM Suite, MPVI interfaces) — commercial; this reads the CSV
  logs it exports
- **TunerPro** — the XDF definition format is read, no TunerPro code is used
- **General Motors** — vehicle manufacturer. No GM calibration data, service
  material or software is included or redistributed

Trademarks belong to their respective owners.

---

## Contributions

Contributions are accepted under GPL-3.0 (inbound = outbound) with a
`Signed-off-by:` line per the Developer Certificate of Origin. See
[CONTRIBUTING.md](CONTRIBUTING.md) — it also explains what cannot be accepted,
and why.
