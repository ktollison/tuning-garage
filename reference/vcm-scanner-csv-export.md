# Exporting CSV from VCM Scanner

Why bother: `.hpl` is proprietary — nothing but HP Tuners can read it. A CSV
export of the same log is readable by this app's log summary, MegaLogViewer,
Excel, and anything else. **Every datalog worth keeping should land in the
repo as both**: the `.hpl` for HPT work, the `.csv` for analysis and for
future-you on a machine without a licence.

## Export steps

> **Menu paths vary between VCM Suite versions — verify these against your
> install. Draft reading.**

1. Open the log: **Scan → Open Log File** (or finish a live scan)
2. **Scan → Export** — pick a filename; the `.csv` extension is appended
   automatically, defaulting to the `.hpl` base name
3. For part of a log only: **Log File → Export Log File**, zoom to the range
   you care about, and use the **Visible Range** option

## Channels worth logging (LS1 starting set)

A starting point, not gospel — build a layout per goal and save it.

**Fuelling / MAF calibration**
- Engine speed (RPM), MAF frequency (Hz), MAF airflow (g/s)
- STFT and LTFT, both banks (%)
- Commanded AFR, O2 sensor voltages (mV)
- Closed-loop status, PE (power enrichment) active flag
- IAT and ECT (°F) — needed to filter for warmed-up, steady-state data
- Throttle position (%), vehicle speed (MPH)

**Spark / knock**
- Knock retard (°), spark advance (°), cylinder airmass, MAP (kPa)
- Same RPM/load/IAT/ECT context channels

**Why the context channels matter:** trim analysis is only valid warmed up, in
closed loop, out of PE, at steady state. Without ECT/IAT/PE in the log you
cannot filter for that, and any correction you derive is contaminated.

## Naming and check-in

Follow the repo convention so the log stays tied to the tune it ran against:

```
YYYY-MM-DD_vNNN_short-desc.csv
```

Upload through the app's **Datalogs** tab — it applies the naming for you and
asks which revision the log was recorded against. Upload the `.hpl` too; both
can share a description.

## What the app does with the CSV

The Datalogs tab's **summary** link parses the header row and every numeric
column, reporting rows, duration, and per-channel min / average / max. That's
a sanity check — did I actually capture what I thought? — not analysis. For
real work use VCM Scanner's histograms or MegaLogViewer HD.

## The exported file is not a plain CSV

Worth knowing before pointing any other tool at it:

- **There is a preamble.** `[Log Information]`, then `[Channel Information]`,
  then `[Channel Data]`. The real header is inside `[Channel Information]`, as
  three rows — parameter IDs, channel names, units. Anything that assumes the
  header is line 1 reads the title line instead and finds one column.
- **Units live in their own row**, not in the channel name.
- **Rows are sparse.** Each channel logs on its own interval, so a row carries
  only the channels that ticked. In a 42-channel log of this car, *no row
  carried both RPM and STFT*. Channels must be put on a common time base
  before anything can be compared across them.
- **One file can hold more than one session.** The `Offset` column restarts
  near zero. A 129k-row export here held two runs plus a single stray
  timestamp of 16778.048 s between them.
- **Channel names can contain unquoted commas** — `MPVI2.1 -> AEM
  30-(03x0,2340,5130)` — so the names row can be wider than the data rows.

The app handles all of the above (`app/modules/loganalysis.mjs`).

## Wideband on Gen III: analog, not CAN

**Confirmed on this car.** Gen III has no CAN wideband path. The controller
feeds the **MPVI's analog input over the ProLink cable**, and VCM Scanner names
that channel after the device rather than after what it measures:

```
MPVI2.1 -> AEM 30-(03x0,2340,5130)
```

Consequences worth remembering:

- The channel name contains no "AFR", "UEGO", "lambda" or "wideband". Anything
  searching for those words will not find your wideband.
- **It carries no declared unit**, so the scale has to be inferred from the
  magnitude of the values. Confirm whether yours reports AFR or λ.
- A CAN-style wideband channel (for example `a CAN wideband controller (30-03XX) WB EQ
  Ratio 1`) can sit in the same layout and log **nothing at all** while the
  analog one works. Having several wideband channels configured with only one
  reporting is normal — check sample counts, not just presence.

## Sources

- <https://www.hptuners.eu/help/vcm_scanner_scan_menu.htm> (Scan menu / export)
- <https://ls1tech.com/forums/pcm-diagnostics-tuning/765815-help-converting-files-hpl-csv.html>
- <https://powerlabstuning.com/pages/datalogging-your-vehicle-hp-tuners>

## My notes (confirm on my install)

*(Your notes go here — this section ships empty on purpose.)*

