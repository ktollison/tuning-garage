// Gen 3 VE and spark analysis.
//
// The load axis is the thread running through all of it: GM indexes VE and
// spark tables in kPa, this car logs manifold pressure in psi, and a 10-unit
// bin sized for kPa collapsed an 11-97 kPa range into two rows. Every
// load-resolved map was one-dimensional and nobody noticed, because a map with
// two rows still looks like a map.

import { analyze, analyzeVE, analyzeAirModels, analyzeSpark, loadToKpa,
         parseCsv, densify, detectChannels } from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const hpt = (rows, names, units) => `HP Tuners CSV Log File

[Channel Information]
${names.split(",").map((_, i) => i).join(",")}
${names}
${units}

[Channel Data]
${rows.join("\n")}
`;

const NAMES = "Offset,Engine RPM (SAE),Intake Manifold Absolute Pressure (SAE),Timing Advance (SAE),Knock Retard,Intake Air Temp (SAE),Dynamic Airflow,Mass Airflow (SAE),Equivalence Ratio Commanded,MPVI2.1 -> AEM";
const UNITS = "s,rpm,psi,°,°,°F,lb/h,lb/min,λ,";
const row = (i, { rpm = 2000, psi = 7.25, adv = 25, kr = 0, iat = 80, dyn = 133.6, maf = 2.234, cmd = 1.0, wb = 14.7 } = {}) =>
  `${(i * 0.1).toFixed(1)},${rpm},${psi},${adv},${kr},${iat},${dyn},${maf},${cmd},${wb}`;

console.log("— the load axis is binned in the table's units, not the log's —");
{
  const rows = [];
  // 11 to 97 kPa expressed in psi — one full sweep of manifold pressure
  for (let i = 0; i < 300; i++) rows.push(row(i, { psi: 1.6 + (i % 100) * 0.125 }));
  const r = analyze(hpt(rows, NAMES, UNITS));
  t(r.spark.yUnit === "kPa", `spark load axis reported in kPa (got ${r.spark.yUnit})`);
  t(r.spark.sparkMap.ys.length > 5, `psi log yields ${r.spark.sparkMap.ys.length} load rows, not 2`);
  t(Math.max(...r.spark.sparkMap.ys) > 50, "rows span the real pressure range");
  t(r.heat.yUnit === "kPa", "trim heat map uses the same axis");
}
{
  const cu = { map: { unit: "psi", quantity: "pressure" } };
  const f = loadToKpa(cu, "map");
  t(Math.abs(f(14.069) - 97.0) < 0.05, `14.069 psi -> ${f(14.069).toFixed(2)} kPa`);
  t(loadToKpa({ map: { unit: "kPa", quantity: "pressure" } })(50) === 50, "kPa passes through unchanged");
  // never guess: an unstated unit must disable scaling rather than assume psi
  t(loadToKpa({ map: { unit: null } }) === null, "no unit -> no scaling");
  t(loadToKpa({}) === null, "no channel -> no scaling");
}

console.log("— MAF vs speed-density agreement —");
{
  const rows = [];
  // dynamic airflow 10% above the MAF reading: 133.6 lb/h = 2.2267 lb/min
  for (let i = 0; i < 120; i++) rows.push(row(i, { dyn: 133.6, maf: 2.2267 / 1.10 }));
  const a = analyze(hpt(rows, NAMES, UNITS)).airModels;
  t(a.present, "runs on a closed-loop log — no wideband or open loop needed");
  t(Math.abs(a.overallDiffPct - 10) < 0.5, `+10% divergence detected (got ${a.overallDiffPct}%)`);
  t(a.units.load === "kPa" && a.units.airflow === "g/s", "reports its units");
  t(a.cells.every(c => c.n > 0), "every cell carries a sample count");
}
{
  const rows = [];
  for (let i = 0; i < 120; i++) rows.push(row(i));
  const noUnits = "s,rpm,psi,°,°,°F,,,λ,";     // airflow units stripped
  const a = analyze(hpt(rows, NAMES, noUnits)).airModels;
  t(!a.present && /unit/.test(a.reason), "refuses to compare airflows with no stated units");
}

console.log("— knock: max per cell, and the IAT confound —");
{
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row(i, { kr: 0, iat: 80 }));
  rows.push(row(60, { kr: 4.0, iat: 80 }));      // one hard event in a quiet cell
  for (let i = 61; i < 120; i++) rows.push(row(i, { kr: 0, iat: 80 }));
  const s = analyze(hpt(rows, NAMES, UNITS)).spark;
  const cell = s.sparkSuggestions[0];
  t(!!cell, "a knock cell produced a suggestion");
  t(cell.maxKr === 4, `uses the MAX retard (${cell.maxKr}°), not the average of 120 mostly-zero samples`);
  t(cell.delta === -4, `suggests subtracting 4° (got ${cell.delta}°)`);
  t(cell.iatSuspect === false, "80 °F is not flagged as an IAT problem");
  t(/High Octane/.test(cell.advice), "points at the High Octane table");
}
{
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row(i, { kr: 3.0, iat: 135 }));   // heat-soaked
  const s = analyze(hpt(rows, NAMES, UNITS)).spark;
  const cell = s.sparkSuggestions[0];
  t(cell.iatSuspect === true, "knock at 135 °F is flagged as an IAT confound");
  t(/IAT spark-retard table/.test(cell.advice), "advises the IAT table before the main table");
  t(/blend/i.test(s.blendCaveat), "states that logged advance is a High/Low octane blend");
}
{
  // the threshold must follow the log's own unit, not assume Fahrenheit
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row(i, { kr: 3.0, iat: 25 }));    // 25 °C = 77 °F, cool
  const s = analyze(hpt(rows, NAMES, "s,rpm,psi,°,°,°C,lb/h,lb/min,λ,")).spark;
  t(s.sparkSuggestions[0].iatSuspect === false, "25 °C is cool — not flagged (threshold converted, not assumed)");
  t(Math.abs(s.krMap.hotIatThreshold - 37.8) < 0.2, `100 °F threshold converted to ${s.krMap.hotIatThreshold} °C`);
}

console.log("— VE: refuses closed-loop data —");
{
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(row(i, { cmd: 1.0, wb: 14.7 }));   // stoich = closed loop
  const v = analyze(hpt(rows, NAMES, UNITS)).ve;
  t(!v.present, "no VE numbers from a closed-loop log");
  t(v.closedLoopSkipped > 100, `${v.closedLoopSkipped} closed-loop rows skipped`);
  t(/trims/.test(v.why) && /MAF/.test(v.why), "explains that trims describe the MAF table, not VE");
}

console.log("— VE: direction of the correction —");
{
  // commanded lambda 0.85, measured 0.80 => richer than asked => VE too high => reduce
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(row(i, { cmd: 0.85, wb: 0.80 * 14.7 }));
  const v = analyze(hpt(rows, NAMES, UNITS)).ve;
  t(v.present, "computes from open-loop samples");
  const c = v.cells.find(c => c.enoughData);
  t(c.multiplier < 1, `richer than commanded -> multiplier below 1 (${c.multiplier})`);
  t(Math.abs(c.multiplier - 0.8 / 0.85) < 0.005, `multiplier is measured/commanded (${c.multiplier.toFixed(4)})`);
}
{
  // leaner than commanded => VE under-estimating air => raise
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(row(i, { cmd: 0.85, wb: 0.90 * 14.7 }));
  const v = analyze(hpt(rows, NAMES, UNITS)).ve;
  const c = v.cells.find(c => c.enoughData);
  t(c.multiplier > 1, `leaner than commanded -> multiplier above 1 (${c.multiplier})`);
  t(v.units.load === "kPa", "VE grid is on the table's own axes");
  t(/one region at a time/.test(v.note), "note keeps the one-change-at-a-time rule");
}

console.log("\nVE/spark tests done");
