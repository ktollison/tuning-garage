# Units contract

Every number this app shows states its unit. Nothing is silently converted.
This page is the contract: what each quantity is measured in, where that unit
comes from, and whether the app converts it.

## The rules

1. **Units are always stated.** A bare number is a bug.
2. **Conversions are always labelled** with the unit the value was recorded in
   — "71.1 °C (converted from 160 °F)", never just "71.1".
3. **Unknown units are never guessed.** If a log column has no unit in its
   header, the app says "not stated" and, where a threshold depends on it,
   *disables the filter and tells you* rather than assuming.
4. **XDF values keep the definition's units.** What you see here matches what
   TunerPro shows for the same table. That's more useful than matching a
   display preference.
5. **Absolute ≠ delta for temperature.** A 10 °F *change* is a 5.6 °C change,
   not −12.2 °C. The code has separate `convert` and `convertDelta` for this.

## Quantities

| Quantity | Units supported | Source of the unit | Converted? |
|---|---|---|---|
| Temperature (ECT, IAT) | °F, °C | log column header | ✅ to your preference |
| Pressure (MAP, fuel) | kPa, psi, inHg, bar | log column header | ✅ to your preference |
| Mass airflow (MAF) | g/s, lb/min | log column header | ✅ to your preference |
| Speed (VSS) | mph, km/h | log column header | ✅ to your preference |
| MAF frequency | Hz | log column header | ❌ unambiguous |
| Engine speed | RPM | log column header | ❌ unambiguous |
| Fuel trim (LTFT, STFT, total) | % | computed | ❌ always % |
| Suggested MAF correction | % | computed | ❌ always % |
| Correction multiplier | **dimensionless ratio** | computed | ❌ never a percentage |
| Spark / knock retard | ° crank | log column header | ❌ unambiguous |
| Injector pulse width | ms | log column header | ❌ unambiguous |
| AFR / lambda / EQ | AFR, λ, EQ | log column header | ✅ normalised to **λ** for comparison |
| Bin/segment sizes, addresses | bytes, hex | the bin itself | ❌ |
| Table values via XDF | whatever the XDF `<units>` says | the definition | ❌ by design (see rule 4) |

## Where the numbers come from

- **Log channels** — the unit is parsed from the column header's brackets:
  `ECT (F)`, `MAP (kPa)`, `MAF (g/s)`. Only brackets are read, so a channel
  *named* "Bank 1" can never be mistaken for the unit "bar".
- **XDF tables** — from the definition's `<units>` element.
- **Computed values** — fixed by the formula and documented above.

## Your preferences

`data/preferences.json`, in the repo so both machines agree after a sync:

```json
{ "units": { "temperature": "°F", "pressure": "kPa", "airflow": "g/s", "speed": "mph" } }
```

Change them on the Datalogs tab. kPa is the GM convention for MAP; the rest
are US-typical defaults.

## Air-fuel scales — the one place a wrong assumption inverts the answer

Three scales describe the same thing and two are visually identical in a log:

| Scale | Stoich | Rich is | Notes |
|---|---|---|---|
| **AFR** | 14.7 (gasoline), 9.765 (E85) | **lower** | fuel-dependent — the number means nothing without the fuel |
| **λ (lambda)** | 1.00 | **below 1** | fuel-independent; the app's comparison basis |
| **EQ (equivalence)** | 1.00 | **above 1** | the reciprocal of lambda; GM commands EQ |

λ and EQ both sit near 1.00, so **range alone cannot tell them apart**. The app
reads the scale from the channel name when it says one, infers AFR-vs-ratio
from magnitude otherwise, and when it lands on an ambiguous ratio it **says so
and states that it assumed lambda** — because if the truth is EQ, every rich
reading becomes lean. Set the scale explicitly on the analysis card to remove
the doubt.

AFR is always shown alongside λ with the stoichiometric ratio named, since the
same λ is a different AFR on a different fuel.

## HP Tuners unit codes

VCM Scanner configuration files identify units by number, not name — `Unit="156"`,
`[50070.56]`. There is no official public table, so `vcm-scanner/unit-codes.json`
maps the codes **inferred from evidence in your own labelled files**, each entry
recording what it was inferred from. The app displays them as
"% (code 156, inferred)" and shows unmapped codes as
"unit 92 *(meaning not established)*".

Two are explicitly ambiguous and left unmapped: **150** appears on both
Horsepower and a dimensionless ratio, and **71 / 92 / 240 / 242** only ever
appear inside math expressions or on parameters whose scale can't be pinned
down. Correct the file whenever you learn the real answer — it's data, not code.

## Why this exists

The warmed-up filter used to compare a hard-coded `160` against whatever the
log reported. Fed a log recording ECT in **°C**, a fully warm engine at 95 °C
was below 160 and **every row was discarded as "cold"** — the analysis
returned nothing and never said why. The threshold now carries its own unit
and is converted into the log's unit before any row is compared. Fixed in
v0.17.0; the regression test lives with the units tests.
