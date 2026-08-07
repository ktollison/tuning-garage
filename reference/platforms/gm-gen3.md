# GM Gen III platform (P01 / P59) — family notes

Siblings: [gm-gen4.md](gm-gen4.md) · [gm-gen5.md](gm-gen5.md) · [global-b.md](global-b.md)

The platform family doc. your-car-specific measured facts stay in `ls1-p01.md`.
Machine-readable version the app uses: `data/platforms/gm-gen3.json`.

## PCM family

| PCM | Flash | Years (approx.) | Open-source support |
|---|---|---|---|
| P01 ("0411") | 512 KB | 1999–2003 | PCMHammer mature; LS Droid; UP full support |
| P59 | 1 MB | 2003–2007 | PCMHammer mature; LS Droid; UP full support |
| P04/P05/P08/P10/P11/P12, E38, E54, BlackBox | varies | varies | PCMHammer experimental — verify per release |

## Bin format (why our app can read these natively)

Documented publicly by the PCMBinBuilder/UniversalPatcher source and
pcmhacking.net (thread t=6240):

- `0x500` — stored OS checksum (uint16 BE)
- `0x503` — must be `1` (OS segment 1 valid)
- `0x504` — **OS ID**, uint32 BE, displayed decimal
- `0x514` — segment table: seven `{start,end}` uint32 BE pairs
  (EngineCal, EngineDiag, TransCal, TransDiag, Fuel, System, Speedo)
- each segment: stored checksum at `start`, part number (cal ID) at `start+4`,
  2-char version at `start+8`
- checksum algorithm: 16-bit two's complement of the big-endian word sum
- `0x20000` — OS segment 2 marker bytes `NV`
- `0x4000` — EEPROM data (VIN at +33, serial +8, BCC +28; check word `0xA0A5`)

The app's analyzer (`app/modules/gm-gen3.mjs`) is a verify-only port of this —
it never modifies a file. Checksum **fixing** belongs to UniversalPatcher.

## Family-level tuning notes (accumulate as I learn)

- OS ↔ XDF pairing is strict; the definitions library (`definitions/<OS>/`)
  keeps the right XDF with the right OS.
- Segment swaps (e.g., trans cal) require OS compatibility — UP's segment
  tools know the rules; don't hand-splice.

## Sources

- <https://pcmhacking.net/forums/viewtopic.php?t=6240>
- <https://github.com/joukoy/PCMBinBuilder> (`Source/PCmFunctions.cs`)
- <https://pcmhammer.github.io/users/supported-pcms>
