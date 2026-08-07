// HP Tuners CSV format: preamble, sparse interval logging, session restarts.
//
// Every case here came from a real 42-channel export that the analyzer could
// not read at all — it took line 1 ("HP Tuners CSV Log File") as the header,
// found zero channels, and reported nothing wrong. The fixtures are synthetic;
// the shapes they encode are not.

import { parseCsv, densify, normalizeTime, detectChannels, detectScale, analyze }
  from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

// Sparse: each row carries only the channels that ticked on that interval.
const hpt = (rows, names = "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE)",
             units = "s,rpm,%,Hz,°F", ids = "0,12,6,2301,5") => `HP Tuners CSV Log File
Version: 1.0

[Log Information]
Creation Time: 1/1/2026 12:00:00 PM
Notes:

[Channel Information]
${ids}
${names}
${units}

[Channel Data]
${rows.join("\n")}
`;

console.log("— preamble —");
{
  const p = parseCsv(hpt(["0.1,800,,,", "0.2,,-5,,"]));
  t(p.format === "hptuners", "format detected");
  t(p.headers.length === 5, `5 channels, not 1 (got ${p.headers.length})`);
  t(p.rows.length === 2, "preamble rows are not data");
  t(p.parameterIds[1] === "12", "parameter IDs captured");
  t(p.timeIdx === 0, "Offset located");
}

console.log("— units are folded into the header —");
{
  const p = parseCsv(hpt(["0.1,800,,,"]));
  t(p.headers[4] === "Engine Coolant Temp (SAE) [°F]", `unit merged: ${p.headers[4]}`);
  // the whole point: downstream unit detection reads the header text
  t(detectChannels(p.headers).mafHz === 3, "Mass Airflow Sensor [Hz] detected as the frequency channel");
  t(detectChannels(p.headers).ect === 4, "coolant detected");
}

console.log("— MAF: frequency vs mass flow told apart by unit —");
{
  const p = parseCsv(hpt(["0.1,800,,,,"],
    "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Mass Airflow (SAE),Engine Coolant Temp (SAE)",
    "s,rpm,%,Hz,lb/min,°F", "0,12,6,2301,16,5"));
  const ch = detectChannels(p.headers);
  t(ch.mafHz === 3, "Hz column is mafHz");
  t(ch.mafGs === 4, "lb/min column is mafGs, not mafHz");
}

console.log("— sparse detection —");
{
  t(parseCsv(hpt(["0.1,800,,,", "0.2,,-5,,", "0.3,,,3200,"])).sparse === true, "interval log flagged sparse");
  const dense = parseCsv("rpm,stft\n800,-5\n810,-6\n");
  t(dense.format === "plain" && dense.sparse === false, "plain CSV unaffected");
}

console.log("— densify: forward fill onto a grid —");
{
  const rows = [];
  for (let i = 0; i < 40; i++) {                       // RPM @100ms, STFT @200ms
    rows.push(`${(i * 0.1).toFixed(1)},${800 + i},,,`);
    if (i % 2 === 0) rows.push(`${(i * 0.1).toFixed(1)},,-5,3200,190`);
  }
  const p = parseCsv(hpt(rows));
  t(p.rows.every(r => r.filter(v => v !== null).length < 5), "no source row holds every channel");
  const d = densify(p, { intervalMs: 100 });
  const full = d.rows.filter(r => r.every(v => v !== null));
  t(full.length > 30, `${full.length} rows carry all channels after fill`);
  t(d.resampled.intervalMs === 100 && d.resampled.toRows > 0, "resample reported");
}

console.log("— densify: held values expire —");
{
  // ECT reports once, then nothing for 100 s. It must not be held that long.
  const rows = ["0.0,800,-5,3200,190"];
  for (let i = 1; i <= 1000; i++) rows.push(`${(i * 0.1).toFixed(1)},${800 + (i % 5)},-5,3200,`);
  const d = densify(parseCsv(hpt(rows)), { intervalMs: 100 });
  const ectLive = d.rows.filter(r => r[4] !== null).length;
  t(ectLive > 0, "the one real ECT sample survives near its own timestamp");
  t(ectLive < 100, `stale ECT expires rather than filling all ${d.rows.length} rows (live in ${ectLive})`);
  t(d.rows.filter(r => r[1] !== null).length > 900, "a channel that keeps reporting is not expired");
}

console.log("— session restarts and corrupt timestamps —");
{
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(`${(i * 0.1).toFixed(1)},${800 + i},-5,3200,190`);
  rows.push("16778.048,900,-5,3200,190");             // single corrupt stamp
  for (let i = 0; i < 50; i++) rows.push(`${(i * 0.1).toFixed(1)},${900 + i},-6,3300,190`);

  const n = normalizeTime(parseCsv(hpt(rows)));
  t(n.droppedRows === 1, `the corrupt stamp is dropped (${n.droppedRows})`);
  t(n.segments === 2, `restart detected as a second session (${n.segments})`);
  t(n.rows.length === 100, `both sessions survive: ${n.rows.length} rows`);
  const times = n.rows.map(r => r[0]);
  t(times.every((v, i) => i === 0 || v >= times[i - 1]), "rebased timeline is monotonic");

  const d = densify(parseCsv(hpt(rows)), { intervalMs: 100 });
  t(d.resampled.sessions === 2 && d.resampled.corruptTimestamps === 1, "reported on the result");
  // the regression this guards: one bad stamp used to discard everything after it
  t(d.resampled.toRows > 90, `second session not swallowed (${d.resampled.toRows} rows)`);
}

console.log("— wideband scale: declared unit outranks the channel name —");
{
  // Real case: a wideband channel named "WB EQ Ratio 1" logging in λ.
  const s = detectScale("UEGO Wideband (30-03XX) WB EQ Ratio 1 [λ]", [0.85, 0.9]);
  t(s.scale === "lambda", `unit wins over name (got ${s.scale})`);
  t(!!s.nameConflict, "the disagreement is reported, not hidden");
  t(detectScale("Wideband AFR [AFR]", [14.7]).scale === "afr", "AFR unit respected");
  t(detectScale("EQ Actual", [1.0]).scale === "eq", "name still used when no unit is declared");
}

console.log("— channels present but silent —");
{
  // Fuel System Status in the layout, never reported. Left in place it reads as
  // "not closed loop" on every row and rejects the entire log.
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},${800 + (i % 3)},-5,3200,190,`);
  const r = analyze(hpt(rows,
    "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE),Fuel System #1 Status (SAE)",
    "s,rpm,%,Hz,°F,", "0,12,6,2301,5,3"));
  t(r.silentChannels.some(s => s.role === "closedLoop"), "empty closed-loop channel identified");
  t(r.keptCount > 0, `rows survive instead of all being rejected (${r.keptCount})`);
  t(r.rejected.openLoop === 0, "no rows rejected by a flag that never reported");
  t(r.warnings.some(w => /no samples/i.test(w)), "warned rather than silently skipped");
}

console.log("— channel names containing commas —");
{
  // Real export: "MPVI2.1 -> AEM 30-(03x0,2340,5130)" splits into three fields,
  // leaving the names row 2 wider than the IDs, units and data rows.
  const p = parseCsv(`HP Tuners CSV Log File

[Channel Information]
0,12,40001
Offset,Engine RPM (SAE),MPVI2.1 -> AEM 30-(03x0,2340,5130)
s,rpm,

[Channel Data]
0.1,800,14.6
0.2,810,14.5
`);
  t(p.headers.length === 3, `names rejoined to 3 columns, not 5 (got ${p.headers.length})`);
  t(p.headers[2] === "MPVI2.1 -> AEM 30-(03x0,2340,5130)", `name intact: ${p.headers[2]}`);
  t(p.rows[0][2] === 14.6, "data still aligns with its column");
}

console.log("— analog wideband on Gen III —");
{
  // No CAN wideband on Gen III: the controller feeds the MPVI's analog input
  // over ProLink, and the channel is named after the device.
  const ch = detectChannels(["Offset [s]", "Engine RPM (SAE) [rpm]", "MPVI2.1 -> AEM 30-(03x0,2340,5130)"]);
  t(ch.widebandAfr === 2, "device-named analog channel detected as the wideband");
  t(detectChannels(["AFR500V2.5 Actual Lambda [λ]"]).widebandAfr === 0, "AFR500 detected");
  t(detectChannels(["Innovate MTX-L"]).widebandAfr === 0, "other common controllers detected");
}

console.log("— the live column wins over the first match —");
{
  // Three wideband channels configured, only the analog one reporting.
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},${800 + (i % 3)},-5,3200,190,,14.6`);
  const r = analyze(hpt(rows,
    "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE),UEGO Wideband (30-03XX) WB EQ Ratio 1,MPVI2.1 -> AEM 30-(03x0",
    "s,rpm,%,Hz,°F,λ,", "0,12,6,2301,5,6181,40001"));
  t(/AEM/.test(r.channels.widebandAfr), `picked the reporting column: ${r.channels.widebandAfr}`);
  t(r.silentChannels.some(s => /UEGO/.test(s.column) && s.superseded), "the dead one is reported as superseded");
  // the warning must not claim the check was skipped when a live column covered it
  t(!r.warnings.some(w => /UEGO/.test(w) && /was skipped/.test(w)), "no false 'check was skipped' for a superseded channel");
  t(r.warnings.some(w => /UEGO/.test(w) && /is being used for/.test(w)), "says which column was used instead");
  t(r.wideband.present === true, "wideband analysis runs");
  t(r.wideband.scale.scale === "afr", `undeclared AFR-range channel inferred as AFR (${r.wideband.scale.scale})`);
}

console.log("— closed loop inferred from commanded mixture —");
{
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(`${(i * 0.1).toFixed(1)},${1500 + (i % 3)},-5,3200,190,1.000,14.7`);
  const r = analyze(hpt(rows,
    "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE),Equivalence Ratio Commanded,MPVI2.1 -> AEM 30-(03x0",
    "s,rpm,%,Hz,°F,λ,", "0,12,6,2301,5,6010,40001"));
  t(r.wideband.closedLoopCheck !== null, "cross-check produced without a Fuel System Status channel");
  t(/inferred/.test(r.wideband.closedLoopBasis), "the inference is disclosed");
  t(Math.abs(r.wideband.closedLoopCheck.errorPct) < 1, `stoich in, stoich out (${r.wideband.closedLoopCheck.errorPct}%)`);
}

console.log("\nHP Tuners format tests done");
