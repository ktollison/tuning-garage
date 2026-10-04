// Direction truth table: every way a mixture, trim or knock figure can reach
// the app, fed data whose answer is known, checked for the right DIRECTION.
//
// A lean engine reported as rich is the most expensive mistake this app can
// make. The first run of this table failed 16 of 26 cases — none of them in
// the owner's own logs, all of them one export setting away — so it stays.

import { analyze, detectScale } from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const hpt = (names, units, rows) =>
  `HP Tuners CSV Log File\n\n[Channel Information]\n${names.map((_, i) => i).join(",")}\n${names.join(",")}\n${units.join(",")}\n\n[Channel Data]\n${rows.join("\n")}\n`;

// cruise at stoich, then a pull: commanded λ `cmd`, measured λ `meas`
function pull({ wb, cmd: c, meas, cmdLambda = 0.85, extra = [] }) {
  const names = ["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", ...c.map(x => x[0]), wb[0], ...extra.map(x => x[0])];
  const units = ["s", "rpm", "%", ...c.map(x => x[1]), wb[1], ...extra.map(x => x[1])];
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push([(i * 0.1).toFixed(1), 2000 + i, 20, ...c.map(x => x[2](1).toFixed(5)), wb[2](1).toFixed(5), ...extra.map(x => x[2](1, i))].join(","));
  for (let i = 0; i < 60; i++) rows.push([(6 + i * 0.1).toFixed(1), 4500 + i, 95, ...c.map(x => x[2](cmdLambda).toFixed(5)), wb[2](meas).toFixed(5), ...extra.map(x => x[2](meas, i))].join(","));
  return analyze(hpt(names, units, rows));
}

const WB = {
  "λ [λ]":        ["Wideband Lambda", "λ", l => l],
  "AFR [AFR]":    ["Wideband AFR", "AFR", l => l * 14.7],
  "EQ [EQ]":      ["Wideband EQ", "EQ", l => 1 / l],
  "AFR, no unit": ["MPVI2.1 -> AEM", "", l => l * 14.7],
};
const CMD = {
  "λ [λ]":            [["Equivalence Ratio Commanded", "λ", l => l]],
  "EQ [EQ]":          [["EQ Ratio Commanded", "EQ", l => 1 / l]],
  "AFR [AFR] + λ":    [["Air-Fuel Ratio Commanded", "AFR", l => l * 14.124], ["Equivalence Ratio Commanded", "λ", l => l]],
};

console.log("— lean and rich, every scale combination —");
for (const [wn, wb] of Object.entries(WB)) for (const [cn, cmd] of Object.entries(CMD))
  for (const [meas, lean] of [[0.95, true], [0.80, false]]) {
    const r = pull({ wb, cmd, meas });
    const b = r.wideband.wot?.find(x => x.from === 4500);
    const exp = +((meas / 0.85 - 1) * 100).toFixed(1);
    t(b && Math.abs(b.errorPct - exp) < 0.3 && b.lean === lean,
      `wideband ${wn} × commanded ${cn}: λ ${meas} vs 0.85 → ${b?.errorPct}% ${b?.lean ? "LEAN" : "not lean"}`);
  }

console.log("— a commanded channel is never the measurement —");
{
  const r = pull({ wb: WB["AFR [AFR]"], cmd: CMD["AFR [AFR] + λ"], meas: 0.95 });
  t(r.channels.widebandAfr === "Wideband AFR [AFR]", `wideband is the wideband (${r.channels.widebandAfr})`);
  t(r.channels.commandedAfr === "Equivalence Ratio Commanded [λ]", "λ commanded preferred over AFR commanded (no stoich needed)");
  // commanded only: there is no wideband, and the app must not invent one
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},4500,95,${(0.85 * 14.124).toFixed(3)}`);
  const r2 = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Air-Fuel Ratio Commanded"], ["s", "rpm", "%", "AFR"], rows));
  t(r2.wideband.present === false, "a log with only commanded AFR has no wideband");
}

console.log("— unitless ratios are decided from the data —");
{
  const noUnit = l => l;
  // commanded "Equivalence Ratio" with no unit, paired with commanded AFR
  const lamPair = [["Equivalence Ratio Commanded", "", l => l], ["Air-Fuel Ratio Commanded", "", l => l * 14.124]];
  const r = pull({ wb: WB["AFR [AFR]"], cmd: lamPair, meas: 0.95 });
  t(r.scales.cmd.scale === "lambda" && r.scales.cmd.resolved, `λ values: resolved as λ from the AFR pairing`);
  t(r.wideband.wot.find(b => b.from === 4500).lean === true, "and lean is reported lean");
  const eqPair = [["Equivalence Ratio Commanded", "", l => 1 / l], ["Air-Fuel Ratio Commanded", "", l => l * 14.124]];
  const r2 = pull({ wb: WB["AFR [AFR]"], cmd: eqPair, meas: 0.95 });
  t(r2.scales.cmd.scale === "eq", `EQ values under the same name: resolved as EQ (${r2.scales.cmd.scale})`);
  t(r2.wideband.wot.find(b => b.from === 4500).lean === true, "and lean is still reported lean");
  // no pairing: wide-open throttle direction decides
  const r3 = pull({ wb: WB["AFR [AFR]"], cmd: [["Commanded EQ Ratio", "", l => 1 / l]], meas: 0.95 });
  t(r3.scales.cmd.scale === "eq" && /wide-open/.test(r3.scales.cmd.basis), "EQ resolved from WOT direction");
  t(r3.wideband.wot.find(b => b.from === 4500).lean === true, "lean reported lean");
  // wideband ratio with no unit: resolved against commanded
  const r4 = pull({ wb: ["Wideband", "", l => 1 / l], cmd: CMD["λ [λ]"], meas: 0.95 });
  t(r4.scales.wb.scale === "eq", `unitless wideband EQ resolved from commanded (${r4.scales.wb.scale})`);
  t(r4.wideband.wot.find(b => b.from === 4500).lean === true, "lean reported lean");
  // wideband ratio resolved by narrowband O2 (rich ↔ high voltage)
  const o2 = [["O2 Voltage B1S1 (SAE)", "V", (l, i) => (i % 2 ? (l < 1 ? 0.8 : 0.1) : 0.45).toFixed(2)]];
  const rows = [];
  for (let i = 0; i < 200; i++) { const l = i % 2 ? 0.97 : 1.03; rows.push(`${(i * 0.1).toFixed(1)},2000,20,${(1 / l).toFixed(4)},${l < 1 ? 0.8 : 0.1}`); }
  const r5 = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Wideband", "O2 Voltage B1S1 (SAE)"], ["s", "rpm", "%", "", "V"], rows));
  t(r5.scales.wb.scale === "eq" && /O2 sensors/.test(r5.scales.wb.basis), `wideband EQ resolved from the narrowband O2 (${r5.scales.wb.scale})`);
  // no evidence at all: λ assumed, loudly
  const rows6 = []; for (let i = 0; i < 60; i++) rows6.push(`${(i * 0.1).toFixed(1)},2000,20,${(1 + (i % 3) / 100).toFixed(3)}`);
  const r6 = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Wideband"], ["s", "rpm", "%", ""], rows6));
  t(r6.scales.wb.assumedLambda === true, "no evidence: assumed λ");
  t(r6.warnings.some(w => /INVERTED/.test(w)), "and warned that every figure inverts if it is EQ");
  void noUnit;
}

console.log("— trims, VE and knock run the right way —");
{
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,20,190,4000,8,2,CL - Normal`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Engine Coolant Temp (SAE)", "Mass Airflow Sensor", "Long Term Fuel Trim Bank 1 (SAE)", "Short Term Fuel Trim Bank 1 (SAE)", "Fuel System #1 Status (SAE)"],
                        ["s", "rpm", "%", "°F", "Hz", "%", "%", ""], rows));
  const b = r.mafBins.bins.find(x => x.from === 4000);
  t(b.multiplier === 1.1, `PCM adding 10% → MAF ×${b.multiplier} (more airflow, more fuel)`);
}
{
  // open loop, measured leaner than commanded → VE up (more fuel)
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},3000,60,195,60,0.85,${(0.9 * 14.7).toFixed(3)},OL - Accel/Decel`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Engine Coolant Temp (SAE)", "Intake Manifold Absolute Pressure (SAE)", "Equivalence Ratio Commanded", "Wideband AFR", "Fuel System #1 Status (SAE)"],
                        ["s", "rpm", "%", "°F", "kPa", "λ", "AFR", ""], rows));
  const c = r.ve.cells?.[0];
  t(c && c.multiplier > 1.05 && c.multiplier < 1.07, `measured λ 0.90 vs commanded 0.85 → VE ×${c?.multiplier} (raise, more fuel)`);
}
const knockLog = (kr, tpsCols) => {
  const names = ["Offset", "Engine RPM (SAE)", ...tpsCols.map(x => x[0]), "Intake Manifold Absolute Pressure (SAE)", "Knock Retard", "Timing Advance (SAE)"];
  const units = ["s", "rpm", ...tpsCols.map(x => x[1]), "kPa", "°", "°"];
  const rows = []; for (let i = 0; i < 60; i++) rows.push([(i * 0.1).toFixed(1), 4000, ...tpsCols.map(x => x[2]), 95, i === 30 ? kr : 0, 28].join(","));
  return analyze(hpt(names, units, rows));
};
{
  const r = knockLog(4, [["Throttle Position (SAE)", "%", 95]]);
  t(r.spark.sparkSuggestions[0]?.delta === -4, "4° retard → remove 4°");
  const n = knockLog(-4, [["Throttle Position (SAE)", "%", 95]]);
  t(n.spark.sparkSuggestions[0]?.delta === -4, `retard logged as −4° is still knock → remove 4° (${n.spark.sparkSuggestions[0]?.delta})`);
  t(n.warnings.some(w => /negative numbers/.test(w)), "and the sign convention is flagged");
}

console.log("— a channel in the wrong unit is refused, not misread —");
{
  // volts first, percent second: the percent channel must be throttle
  const r = knockLog(4, [["Throttle Position Sensor", "V", 4.2], ["Throttle Position (SAE)", "%", 95]]);
  t(r.channels.tps === "Throttle Position (SAE) [%]", `throttle read in % (${r.channels.tps})`);
  t(r.spark.events[0]?.suspectFalse === false, "WOT knock is not dismissed as light-throttle false knock");
  // volts only: no throttle, said so — never read as percent
  const v = knockLog(4, [["Throttle Position Sensor", "V", 4.2]]);
  t(v.channels.tps === undefined && v.warnings.some(w => /No usable tps/.test(w)), "volts-only throttle refused and explained");
  t(v.spark.events[0]?.suspectFalse === false, "and knock is not called false without a throttle reading");
}
{
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},3000,-5,4,2`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Intake Manifold Absolute Pressure", "Knock Retard", "Timing Advance (SAE)"], ["s", "rpm", "psig", "°", "°"], rows));
  t(r.spark.yUnit !== "kPa", `gauge pressure is not binned as absolute kPa (load unit: ${r.spark.yUnit})`);
  t(/gauge/.test(r.airModels.reason || "") || r.channelUnits.map?.unit === "psig", "psig recognised as gauge");
}
{
  const rows = []; for (let i = 0; i < 60; i++) rows.push(`${(i * 0.1).toFixed(1)},2000,20,190,4000,${(1.04 + (i % 3) / 100).toFixed(3)},1.0,CL - Normal`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Engine Coolant Temp (SAE)", "Mass Airflow Sensor", "Long Term Fuel Trim Bank 1", "Short Term Fuel Trim Bank 1", "Fuel System #1 Status (SAE)"],
                        ["s", "rpm", "%", "°F", "Hz", "", "", ""], rows));
  t(r.channels.ltft === undefined && r.warnings.some(w => /multiplier/.test(w)), "unitless trims near 1.0 refused as multipliers, not summed as +1%");
}

console.log("— the PCM's stoich ignores engine-off rows —");
{
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(`${(i * 0.1).toFixed(1)},0,0,1.000,5.4`);            // key on, engine off: priming AFR
  for (let i = 0; i < 60; i++) rows.push(`${(10 + i * 0.1).toFixed(1)},850,6,1.000,14.124`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Equivalence Ratio Commanded", "Air-Fuel Ratio Commanded"], ["s", "rpm", "%", "λ", "AFR"], rows));
  t(r.pcmStoich?.value === 14.124, `stoich 14.124 despite 100 priming rows at 5.4 (${r.pcmStoich?.value})`);
}
void detectScale;
