# UniversalPatcher (suite)

Open-source Swiss-army knife for GM bins by Jouko Kylmäoja (joukoy) — grew from
the LS1 "PCM BinBuilder" segment-swap tool into a full suite: **Tuner · Patcher ·
Logger**. Source: **github.com/joukoy/UniversalPatcher**; site: universalpatcher.net.

## Capability matrix (researched 2026-08-02)

| Capability | Notes |
|---|---|
| Checksum verify + autofix | "Almost any GM binary"; extra checksums on newer controllers autofixed (v22.11+); checksums re-fixed on every save |
| CVN stock check | Detects whether a bin is stock via CVN database |
| Bin identification | Autodetect module identifies PCM/OS from the file |
| Segment extract / swap | The original feature — move OS/cal segments between compatible bins |
| Patch create / apply | Diff two bins into a distributable patch; apply patches to other bins |
| Table search engine | Opcode-based search finds tables in unmapped bins (highly sophisticated) |
| XDF generation | Generates TunerPro XDF files from its table data |
| Tuner | Its own table editor (multi-file, advanced) |
| Logger / Analyzer | Datalogging + log analysis components |
| DTC tools | DTC search/edit support |

## Companion tools (same author / site)

- **GM 5-byte keys** utility (seed/key)
- **E41 (de)compress** tool
- **Checksum plugins for GM PCMs** (for TunerPro)
- **A2L file converter**
- **PCMBinBuilder** (predecessor; its `PCmFunctions.cs` documents the P01/P59
  bin layout our app's analyzer is ported from)

## Where it fits in my workflow

- Checksum authority: our app **verifies** Gen3 checksums; UniversalPatcher
  **fixes** them. Any bin edited outside HPT goes through UP before flashing.
- Segment swaps (e.g., trans cal between OS-compatible bins) happen here.
- XDF generation fills gaps when no community XDF exists for an OS.

## Sources

- <https://github.com/joukoy/UniversalPatcher>
- <https://universalpatcher.net/> (+ /history/)
- <https://pcmhacking.net/forums/viewtopic.php?t=6642> (segment swap thread)

## My gotchas (fill in from experience)

*(Your notes go here — this section ships empty on purpose.)*

