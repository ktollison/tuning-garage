// Regression tests for the October 2026 calculation audit.
//
// Every case here reproduced a real bug in the log analysis before it was
// fixed. Several produced a confident number, or a green checkmark, on a
// condition that was wrong — the failure mode a tuning tool can least afford.

import { analyze, analyzeWideband, analyzeSpark, filterRows, parseCsv, densify, detectChannels }
  from "../../app/modules/loganalysis.mjs";
import { makeEval } from "../../app/modules/xdf.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const log = (names, units, rows) =>
  `HP Tuners CSV Log File\n\n[Channel Information]\n${names.split(",").map((_, i) => i).join(",")}\n${names}\n${units}\n\n[Channel Data]\n${rows.join("\n")}\n`;

// ---------------------------------------------------------------------------
console.log("— 1. lean is judged against what was COMMANDED, not just stoichiometric —");
{
  // Commanded 0.85, measured 0.95: 11.8% leaner than asked, but still richer
  // than stoich. The old absolute λ>1.0 test passed this with a green check.
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},5000,95,0.85,${(0.95 * 14.7).toFixed(3)}`);
  const r = analyze(log("Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR",
                        "s,rpm,%,λ,AFR", rows));
  const b = r.wideband.wot[0];
  t(b.errorPct > 11 && b.errorPct < 12.5, `error computed as ${b.errorPct}% lean of commanded`);
  t(b.lean === true, "an 11.8%-lean-of-target WOT bin is flagged lean");
  t(r.wideband.leanWotSamples > 0, `lean samples counted (${r.wideband.leanWotSamples}), not zero`);
  t(r.wideband.wotDefinition.leanMarginPct === 3, "the margin is 3% and reported");
}
{
  // Within the margin: 2% lean of commanded must NOT alarm.
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},5000,95,0.85,${(0.867 * 14.7).toFixed(3)}`);
  const r = analyze(log("Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR",
                        "s,rpm,%,λ,AFR", rows));
  t(r.wideband.wot[0].lean === false, `2% lean of target is within margin (${r.wideband.wot[0].errorPct}%)`);
}

// ---------------------------------------------------------------------------
console.log("— 2. commanded AFR is converted with the PCM's stoich, not the wideband's —");
{
  // A log whose ONLY commanded channel is AFR, produced with a 14.12 stoich.
  // Closed loop commands 14.12 AFR = λ 1.000. Dividing by 14.7 gave λ 0.9605,
  // so every closed-loop row looked like power enrichment.
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE),Air-Fuel Ratio Commanded,Equivalence Ratio Commanded";
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,15,-5,3500,190,14.12,1.000`);
  const r = analyze(log(names, "s,rpm,%,%,Hz,°F,,λ", rows), { channels: { commandedAfr: 6 } });
  t(r.keptCount > 200, `closed-loop rows survive the PE filter (${r.keptCount} kept, was ~0)`);
  t(r.rejected.powerEnrich === 0, `none misread as power enrichment (${r.rejected.powerEnrich})`);
  t(Math.abs((r.pcmStoich?.value ?? 0) - 14.12) < 0.01, `PCM stoich derived from the log (${r.pcmStoich?.value})`);
}
{
  // The VE grid must still refuse a closed-loop log when commanded is AFR.
  const names = "Offset,Engine RPM (SAE),Intake Manifold Absolute Pressure (SAE),Air-Fuel Ratio Commanded,Equivalence Ratio Commanded,MPVI2.1 -> AEM";
  const rows = []; for (let i = 0; i < 300; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,7,14.12,1.000,14.7`);
  const r = analyze(log(names, "s,rpm,psi,,λ,", rows), { channels: { commandedAfr: 3 } });
  t(!r.ve.present, "VE refuses: these are closed-loop samples, whatever unit commanded is in");
}
{
  // Wideband conversion is the controller's display stoich, independent of fuel.
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},5000,95,0.85,12.495`);
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR";
  const gas = analyze(log(names, "s,rpm,%,λ,AFR", rows));
  const e85 = analyze(log(names, "s,rpm,%,λ,AFR", rows), { fuel: "e85" });
  t(gas.wideband.wot[0].avgLambda === e85.wideband.wot[0].avgLambda,
    `choosing E85 does not re-scale a 14.7-display wideband (${gas.wideband.wot[0].avgLambda} both)`);
}

// ---------------------------------------------------------------------------
console.log("— 3. knock is attributed where retard RISES, not where it decays —");
{
  // One knock at 2000 RPM, then retard decays while RPM climbs through more
  // cells. Only the cell where it rose actually knocked.
  const names = "Offset,Engine RPM (SAE),Intake Manifold Absolute Pressure (SAE),Knock Retard,Timing Advance (SAE),Intake Air Temp (SAE)";
  const trace = [[2001, 0], [2001, 3.5], [2001, 3.5], [2400, 2.8], [2400, 2.8], [2800, 2.0], [3200, 1.2], [3600, 0.5], [3900, 0]];
  const rows = trace.map(([rpm, kr], i) => `${(i * 0.1).toFixed(1)},${rpm},10.7,${kr},25,80`);
  const r = analyze(log(names, "s,rpm,psi,°,°,°F", rows));
  const knocked = r.spark.sparkSuggestions.map(c => c.rpm);
  t(knocked.includes(2000), "the cell where retard rose is flagged");
  t(!knocked.some(x => x >= 2500), `decay cells are not (flagged: ${knocked.join(", ") || "none"})`);
  t(r.spark.sparkSuggestions.length === 1, `one event, one cell (got ${r.spark.sparkSuggestions.length})`);
}

// ---------------------------------------------------------------------------
console.log("— 4. WOT error is computed from paired samples only —");
{
  // Wideband on every row; commanded only on some. Mixing the two averages
  // compared the mean of one population to the mean of a subset.
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR";
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`${(i * 0.1).toFixed(1)},5000,95,0.85,${(0.85 * 14.7).toFixed(3)}`);   // paired, on target
  for (let i = 40; i < 80; i++) rows.push(`${(i * 0.1).toFixed(1)},5000,95,,${(1.10 * 14.7).toFixed(3)}`);      // wideband only
  const p = parseCsv(log(names, "s,rpm,%,λ,AFR", rows));   // NOT densified: commanded genuinely absent
  const w = analyzeWideband(p, detectChannels(p.headers), {}, {});
  t(Math.abs(w.wot[0].errorPct) < 0.5, `paired error is ~0% (${w.wot[0].errorPct}%), not inflated by unpaired rows`);
}

// ---------------------------------------------------------------------------
console.log("— 5. the steady-state filter sees through held values —");
{
  // TPS steps 10% every 200 ms on a 100 ms grid: each step is a jump then a
  // held row. The held row passed the old one-row comparison.
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE)";
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,${10 + Math.floor(i / 2) * 10},-5,3500,190`);
  const r = analyze(log(names, "s,rpm,%,%,Hz,°F", rows));
  t(r.keptCount < 5, `a sustained throttle ramp is rejected as transient (${r.keptCount} kept, was ~20)`);
}

// ---------------------------------------------------------------------------
console.log("— 6. trims are only summed when both are present —");
{
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Short Term Fuel Trim Bank 1 (SAE),Long Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE)";
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,15,-2,8,3500,190`);   // both: total +6
  for (let i = 30; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,15,-2,,3500,190`);   // LTFT missing
  const p = parseCsv(log(names, "s,rpm,%,%,%,Hz,°F", rows));
  const f = filterRows(p, detectChannels(p.headers), {}, {});
  t(f.kept.every(k => k.total === 6), `no row is summed as STFT alone (totals: ${[...new Set(f.kept.map(k => k.total))].join(", ")})`);
  t(f.rejected.incompleteTrim > 0, `incomplete rows are counted as such (${f.rejected.incompleteTrim})`);
}

// ---------------------------------------------------------------------------
console.log("— 7. XDF division by zero is undefined, not zero —");
{
  const v = makeEval("1000/X")(0);
  t(Number.isNaN(v), `1000/0 -> ${v}, not a plausible 0`);
  t(makeEval("X/2")(8) === 4, "ordinary division unaffected");
}

// ---------------------------------------------------------------------------
console.log("— 8. empty rows are 'no data', not a trim problem —");
{
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Short Term Fuel Trim Bank 1 (SAE),Mass Airflow Sensor,Engine Coolant Temp (SAE)";
  const rows = ["0.0,2000,15,-5,3500,190", "0.1,,,,,", "0.2,,,,,", "0.3,2000,15,-5,3500,190"];
  const p = parseCsv(log(names, "s,rpm,%,%,Hz,°F", rows));
  const f = filterRows(p, detectChannels(p.headers), {}, {});
  t(f.rejected.noData === 2, `2 empty rows counted as noData (${f.rejected.noData})`);
  t((f.rejected.noTrimData || 0) === 0, "and not blamed on the trims");
}

// ---------------------------------------------------------------------------
console.log("— 9. commanded enrichment is lean-checked even below the WOT throttle threshold —");
{
  // Found while verifying fix 1: no PE channel and a 72.9% throttle peak meant
  // ZERO samples qualified as WOT, so a real log running 5.5-8.8% lean of
  // commanded across nine cells produced no warning at all.
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR";
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},3500,55,0.869,${(0.937 * 14.7).toFixed(3)}`);
  const r = analyze(log(names, "s,rpm,%,λ,AFR", rows));
  t(r.wideband.wotSamples > 0, `enrichment at 55% throttle is checked (${r.wideband.wotSamples} samples)`);
  t(r.wideband.wot[0].lean === true, `and flagged lean (${r.wideband.wot[0].errorPct}% of commanded)`);
  t(!!r.wideband.wotDefinition.enrichmentProxy, "the inference is disclosed");
}
{
  // ...but closed-loop cruise at the same throttle is not enrichment.
  const names = "Offset,Engine RPM (SAE),Throttle Position (SAE),Equivalence Ratio Commanded,Wideband AFR";
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},3500,55,1.000,14.7`);
  t(analyze(log(names, "s,rpm,%,λ,AFR", rows)).wideband.wotSamples === 0, "closed-loop cruise is not counted");
}

console.log("\naudit regression tests done");
