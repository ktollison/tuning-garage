# Tool Radar — Gen III GM ecosystem

Tools worth knowing about beyond HPT / PCMHammer / UniversalPatcher.
Researched 2026-08-02; statuses change — check the linked threads.

## On the radar

| Tool | What it is | Why it matters to me |
|---|---|---|
| **LS Droid** | Android app: P01/P59 cal+OS flashing **and full cloning** over Bluetooth via OBDLink MX+ | Flash or clone a PCM with a phone in the garage — no laptop. Cal write 2–3 min, OS write ~10 min. Cloning writes every byte incl. VIN/serial/BCC/security. Bench use: 13.8 V / 3 A supply |
| **TunerPro RT** | Free(ish) bin editor driven by community XDF definition files | The editing side of the PCMHammer workflow; RT adds emulation/datalog features |
| **GM checksum plugins for TunerPro** | Plugins so TunerPro fixes GM checksums on save | Closes the "edited in TunerPro, forgot the checksum" hole |
| **PCMBinBuilder** | joukoy's original P01/P59 tool: build a bin from OS + cal segments | Also the cleanest documentation of the bin format (our app's analyzer is ported from its `PCmFunctions.cs`) |
| **PCM Logger** | Datalogger bundled with PCMHammer, XML channel definitions per OS | Free datalogging without burning HPT licensing on experiments |
| **MegaLogViewer HD** | Log analysis app (CSV) — histograms, scatter, filters, formulas | Much stronger analysis than eyeballing VCM Scanner; eats CSV exports |
| **Dedicated VPW interfaces** (hardware) | Purpose-built J1850 VPW adapters with 4x support | Faster and more reliable than repurposed generic tools — but prove yours before writing with it |

## Factory tooling

| Tool | What it is | Why it matters to me |
|---|---|---|
| **GM SPS2 / Techline Connect** | GM's own service programming — factory calibrations by VIN | Used it to program this car's donor P01. Full writeup: [gm-sps2.md](gm-sps2.md); when it's actually required: [../faq.md](../faq.md) |
| GDS2 | GM factory diagnostics (not programming) | Pairs with SPS2 under the same subscription |

## Definition / OS sources

- pcmhacking.net forums — XDF threads per OS (e.g., t=7949, t=7916), OS
  discussion (f=42 t=6208), bin internals (t=6240)
- ls1tech.com — "Bin and XDF Repository" thread (t=1930537)
- gearhead-efi.com — older GM platform definitions and docs
- UniversalPatcher — can generate an XDF when nobody has published one

## Commercial context

- **HP Tuners** (owned) — licensing per VIN/OS via credits; the polished path
- **EFILive** — the other commercial Gen3/Gen4 suite; mostly matters if a file
  arrives in its format

## Evaluation queue

*(Your notes go here — this section ships empty on purpose.)*

## Sources

- <https://pcmhacking.net/forums/viewtopic.php?t=6249> (LS Droid)
- <https://pcmhammer.github.io/users/> (PCM Logger, devices)
- <https://universalpatcher.net/> (companion tools)
- <https://ls1tech.com/forums/pcm-diagnostics-tuning/1930537-bin-xdf-repository.html>
