// Builds a throwaway, fully populated repo for documentation screenshots.
//   node scripts/make-demo.mjs /tmp/demo
//
// Everything in it is invented: a fictional vehicle, synthetic bins that are
// format-valid but meaningless, and logs generated to contain the exact
// conditions the guide needs to show (a MAF trim pattern, a lean WOT excursion,
// a knock event). It is built FROM THE EXPORTED STARTER KIT, so a screenshot
// can never accidentally contain the author's data.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] || "/tmp/tuning-demo");
const VEHICLE = "2002-camaro-ls1";
const OS_ID = 12587603;          // plausible, not the author's

// 1. start from a clean starter-kit export
await fsp.rm(OUT, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(REPO, "app/export-template.mjs"), OUT], { stdio: "pipe" });
await fsp.rm(path.join(OUT, "vehicles", "example-vehicle"), { recursive: true, force: true });

const V = path.join(OUT, "vehicles", VEHICLE);
for (const d of ["tunes/stock", "datalogs", "sessions"]) await fsp.mkdir(path.join(V, d), { recursive: true });

// 2. vehicle profile
await fsp.writeFile(path.join(V, "vehicle.md"), `# 2002 Chevrolet Camaro SS

| Field | Value |
|-------|-------|
| Year / Model | 2002 Camaro SS |
| Engine | 5.7L LS1 |
| Transmission | T56 manual |
| PCM / ECU | P01 ("0411") |
| OS ID | ${OS_ID} |
| VIN | 2G1FP22G522100418 |
| Injectors | Stock 26 lb/hr |
| Intake / exhaust mods | Lid, long-tube headers, catback |
| Fuel | 93 octane |

## Baseline (before any tuning)

- PCMHammer full read (.bin) archived: ☑ 2026-03-04
- HP Tuners base read (.hpt) archived: ☑ 2026-03-04
- Read date(s): 2026-03-04
- Notes on vehicle condition (plugs, filters, known issues): new plugs, clean filter

## Current state

- Current tune revision: v001 (flashed 2026-03-11)
- Last flashed: 2026-03-11
- Known issues / watch list: slight lean patch mid-range, being worked

## History summary

See \`tunes/CHANGELOG.md\` for the full revision log.
`);

// 3. a format-valid P01 bin, plus a revision differing inside EngineCal
function buildBin(engineCalTweak = null) {
  const buf = Buffer.alloc(512 * 1024);
  const w16 = (v, o) => { buf[o] = (v >> 8) & 0xff; buf[o + 1] = v & 0xff; };
  const w32 = (v, o) => { buf[o] = (v >>> 24) & 0xff; buf[o + 1] = (v >>> 16) & 0xff; buf[o + 2] = (v >>> 8) & 0xff; buf[o + 3] = v & 0xff; };
  const r16 = o => (buf[o] << 8) | buf[o + 1];
  buf[0x503] = 1; w32(OS_ID, 0x504); buf.write("AB", 0x508, "ascii");
  buf[0x20000] = 0x4e; buf[0x20001] = 0x56;
  buf[0x4088] = 0xa5; buf[0x4089] = 0xa0;                       // EEPROM check word
  buf.write("2G1FP22G522100418", 0x4000 + 33, "ascii");
  buf.write("DEMOSERIAL01", 0x4000 + 8, "ascii");
  buf.write("BXMD", 0x4000 + 28, "ascii");
  w32(12200411, 0x4000 + 4);

  const segs = [];
  let start = 0x30000;
  for (let s = 0; s < 7; s++) {
    w32(start, 0x514 + s * 8); w32(start + 0x1000 - 1, 0x514 + s * 8 + 4);
    w32(9360000 + s, start + 4); buf.write("A" + s, start + 8, "ascii");
    segs.push({ start, len: 0x1000 }); start += 0x2000;
  }
  // a MAF-airflow-looking table inside EngineCal, so the XDF has something real
  const MAF = 0x30200;
  [820, 905, 1010, 1140, 1265, 1390, 1520, 1660].forEach((v, i) => w16(v, MAF + i * 2));
  if (engineCalTweak) engineCalTweak({ w16, r16, MAF });

  for (const sg of segs) {                                       // segment checksums
    let s = 0; for (let i = sg.start + 2; i < sg.start + sg.len - 1; i += 2) s += r16(i);
    w16((65536 - (s & 0xffff)) & 0xffff, sg.start);
  }
  let os = 0;                                                    // OS checksum
  for (let i = 0; i < 0x4ff; i += 2) os += r16(i);
  for (let i = 0x502; i < 0x3fff; i += 2) os += r16(i);
  for (let i = 0x20000; i < 0x20000 + 0x5fffe - 1; i += 2) os += r16(i);
  w16((65536 - (os & 0xffff)) & 0xffff, 0x500);
  return buf;
}

await fsp.writeFile(path.join(V, "tunes/stock/stock_2026-03-04_full-read.bin"), buildBin());
await fsp.writeFile(path.join(V, "tunes/stock/stock_2026-03-04_hpt-base.hpt"), Buffer.alloc(240 * 1024, 7));
// v001: raise three mid-range MAF cells ~6%, the correction the logs justify
await fsp.writeFile(path.join(V, "tunes/v001_2026-03-09_maf-cal-pass1.bin"),
  buildBin(({ w16, r16, MAF }) => { for (const i of [3, 4, 5]) w16(Math.round(r16(MAF + i * 2) * 1.06), MAF + i * 2); }));

await fsp.writeFile(path.join(V, "tunes/CHANGELOG.md"), `# Tune Changelog — 2002 Camaro SS

Newest at the top. One entry per revision, written **before** flashing.

---

## v001 — 2026-03-09 — First MAF correction
- **Base:** stock
- **Changed:** MAF airflow table, 3000–4500 Hz region, +6%
- **Why:** cruise log showed +6% total fuel trim consistently through that band
- **Result:** trims within ±1% on the follow-up log
`);

// 4. an XDF that maps that table, so the table-level diff renders
const defs = path.join(OUT, "definitions", String(OS_ID));
await fsp.mkdir(defs, { recursive: true });
await fsp.writeFile(path.join(defs, `LS1_${OS_ID}_demo.xdf`), `<?xml version="1.0" encoding="utf-8"?>
<XDFFORMAT version="1.70">
  <XDFHEADER>
    <deftitle>LS1 ${OS_ID} (demo definition)</deftitle>
    <description>Minimal definition used for the user guide</description>
    <BASEOFFSET offset="0" subtract="0" />
    <CATEGORY index="0" name="Fuel" />
  </XDFHEADER>
  <XDFTABLE uniqueid="0x1">
    <title>MAF Airflow vs Frequency</title>
    <description>Airflow in grams per second at each MAF frequency breakpoint</description>
    <CATEGORYMEM index="0" category="1" />
    <XDFAXIS id="z">
      <EMBEDDEDDATA mmedaddress="0x30200" mmedelementsizebits="16" mmedrowcount="1" mmedcolcount="8" />
      <units>g/s</units><decimalpl>2</decimalpl>
      <MATH equation="X*0.05"><VAR id="X" /></MATH>
    </XDFAXIS>
  </XDFTABLE>
</XDFFORMAT>
`);

// 5. logs built to contain exactly what the guide needs to explain
const H = "Time (s),Engine Speed (RPM),MAP (kPa),MAF Frequency (Hz),LTFT B1 (%),STFT B1 (%),ECT (F),IAT (F),TPS (%),Spark Advance (deg),Knock Retard (deg),AFR (wideband),Commanded AFR,Closed Loop,Power Enrichment";
const rows = (fn) => { const r = [H]; let t = 0; fn((...c) => r.push([(t += 0.1).toFixed(1), ...c].join(","))); return r.join("\n"); };

// cruise: a clean +6% lean band at 3000-4500 Hz, correct elsewhere
await fsp.writeFile(path.join(V, "datalogs/2026-03-06_v000_cruise-ltft.csv"), rows(p => {
  for (let i = 0; i < 70; i++) p(1500, 34, 1800, 1, 0, 197, 92, 12, 30, 0, 14.7, 14.7, 1, 0);
  for (let i = 0; i < 80; i++) p(2200, 45, 3400, 4, 2, 198, 96, 18, 28, 0, 14.7, 14.7, 1, 0);
  for (let i = 0; i < 60; i++) p(2900, 52, 5200, 1, 0, 198, 99, 24, 27, 0, 14.7, 14.7, 1, 0);
}));

// WOT pull: rich and safe low down, lean and knocking up top
await fsp.writeFile(path.join(V, "datalogs/2026-03-12_v001_wot-pull.csv"), rows(p => {
  for (let i = 0; i < 50; i++) p(1600, 36, 1900, 1, 0, 197, 94, 14, 30, 0, 14.7, 14.7, 1, 0);
  for (let i = 0; i < 22; i++) p(3200, 94, 7200, 0, 0, 199, 118, 93, 24, 0, 12.4, 12.5, 0, 1);
  for (let i = 0; i < 22; i++) p(4300, 96, 8400, 0, 0, 200, 132, 96, 23, 0, 12.5, 12.5, 0, 1);
  p(5100, 97, 9100, 0, 0, 201, 141, 98, 21, 2.5, 13.4, 12.5, 0, 1);
  p(5200, 97, 9200, 0, 0, 201, 142, 98, 18, 5.0, 14.9, 12.5, 0, 1);
  p(5300, 97, 9300, 0, 0, 201, 143, 98, 19, 3.5, 15.2, 12.5, 0, 1);
  for (let i = 0; i < 14; i++) p(5600, 97, 9500, 0, 0, 202, 144, 98, 22, 0, 12.6, 12.5, 0, 1);
}));

// 6. flash log, session, progression — so Timeline and Overview are alive
await fsp.writeFile(path.join(V, "flash-log.md"), `# Flash log — ${VEHICLE}

Every write recorded here, newest at the bottom. Written by the app only
after the full pre-flash checklist has been completed.

| Date | Revision | Adapter | Notes |
|---|---|---|---|
| 2026-03-05 | stock | proven J2534 interface | write-back test, no changes |
| 2026-03-11 | v001 | proven J2534 interface | cal-only write, in vehicle |
`);

await fsp.writeFile(path.join(V, "sessions/2026-03-12_session.md"), `# Tuning Session — 2026-03-12

**Vehicle:** ${VEHICLE}
**Goal for this session:** verify the MAF correction and take a first WOT pull
**Tune revision flashed:** v001
**Tools used:** HP Tuners VCM Scanner, PCMHammer

## Datalogs captured

| File | Conditions |
|------|------------|
| \`datalogs/2026-03-12_v001_wot-pull.csv\` | warm cruise then one 2nd-gear pull to 5600 |

## Observations

- Cruise trims now within ±1% where they were +6% before the correction.
- Pull went lean above 5000 RPM (measured 15.2 AFR against 12.5 commanded) and
  the PCM pulled up to 5° of timing. Aborted the next pull.

## Changes made

| Table | Region / axis | Before | After | Annotation |
|-------|---------------|--------|-------|------------|
| — | — | — | — | No changes made — investigating fuel supply before touching timing |

## Result

MAF correction confirmed good. Lean-at-WOT is the open item.

## Next steps

- Check fuel pressure under load before the next pull.

## Concepts practiced (update PROGRESSION.md)

- Reading LTFT/STFT, wideband vs commanded, knock retard interpretation
`);

let prog = await fsp.readFile(path.join(OUT, "PROGRESSION.md"), "utf8");
prog = prog
  .replace("| Reading & backing up the PCM (full stock read) | ⬜ |", "| Reading & backing up the PCM (full stock read) | 🟢 |")
  .replace("| Flashing basics & write types (cal-only vs full) | ⬜ |", "| Flashing basics & write types (cal-only vs full) | 🟢 |")
  .replace("| Choosing logging channels (what matters, what's noise) | ⬜ |", "| Choosing logging channels (what matters, what's noise) | 🟢 |")
  .replace("| Reading STFT/LTFT — what the trims are telling you | ⬜ |", "| Reading STFT/LTFT — what the trims are telling you | 🟢 |")
  .replace("| MAF calibration (trim-based, then wideband) | ⬜ |", "| MAF calibration (trim-based, then wideband) | 🟡 |")
  .replace("| Knock retard logging & separating true vs false knock | ⬜ |", "| Knock retard logging & separating true vs false knock | 🟡 |")
  .replace("- [ ] Stock read archived", "- [x] Stock read archived")
  .replace("- [ ] First successful flash", "- [x] First successful flash")
  .replace("- [ ] First datalog reviewed end-to-end", "- [x] First datalog reviewed end-to-end");
await fsp.writeFile(path.join(OUT, "PROGRESSION.md"), prog);

console.log(`Demo repo built at ${OUT}`);
console.log(`  vehicle ${VEHICLE}, OS ${OS_ID}, 2 baseline files, 1 revision, 1 XDF, 2 datalogs, 2 flashes, 1 session`);
