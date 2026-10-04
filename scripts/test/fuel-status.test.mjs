// Fuel System Status (SAE PID 03) as the loop-state source.
//
// HP Tuners logs it as TEXT. The app counted only numbers as data, called a
// live channel with 4,057 samples empty, and guessed closed loop and power
// enrichment from commanded λ instead — counting cold warm-up as PE.

import { analyze, makeLoopReader } from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const NAMES = "Offset,Engine RPM (SAE),Throttle Position (SAE),Engine Coolant Temp (SAE),Mass Airflow Sensor,Short Term Fuel Trim Bank 1 (SAE),Manifold Absolute Pressure (SAE),Equivalence Ratio Commanded,Wideband AFR,Fuel System #1 Status (SAE)";
const UNITS = "s,rpm,%,°F,Hz,%,kPa,λ,AFR,";
const csv = rows => `HP Tuners CSV Log File\n\n[Channel Information]\n${NAMES.split(",").map((_, i) => i).join(",")}\n${NAMES}\n${UNITS}\n\n[Channel Data]\n${rows.join("\n")}\n`;
let clock = 0;
const seg = (n, f) => Array.from({ length: n }, () => { const r = f(); clock += 0.1; return `${clock.toFixed(1)},${r}`; });
//                  rpm   tps ect  maf  stft map cmd   wb(AFR)        status
const cold   = () => `1200,5,  90, 2500,0,  40, 0.85, ${0.85 * 14.7},OL - Not Ready`;
const cruise = () => `2000,15, 195,3500,-8, 45, 1.00, 14.7,CL - Normal`;
const pull   = () => `4000,95, 195,7000,0,  95, 0.87, ${0.93 * 14.7},OL - Accel/Decel`;
const dfco   = () => `2500,0,  195,1800,0,  20, 1.00, 22.0,OL - Accel/Decel`;
const ol0    = () => `2500,30, 195,4000,0,  60, 1.00, ${1.06 * 14.7},OL - Not Ready`;   // closed loop disabled, warm

console.log("— text status is data, not an empty channel —");
{
  clock = 0;
  const r = analyze(csv([...seg(60, cold), ...seg(80, cruise), ...seg(40, pull), ...seg(30, dfco)]));
  t(r.channels.closedLoop === "Fuel System #1 Status (SAE)", "Fuel System Status detected as the loop channel");
  t(!r.silentChannels.some(s => s.role === "closedLoop"), "not reported as “logged but contains no samples”");
  t(!r.emptyChannels.includes("Fuel System #1 Status (SAE)"), "not listed as an empty channel");
  t(!r.missingChannels.includes("closedLoop"), "closed loop no longer listed as missing");
  t(r.keptCount > 0, `cruise rows kept for trims (${r.keptCount}) — “CL - Normal” is closed loop, not false`);
  t(r.rejected.openLoop > 0 && r.rejected.powerEnrich === 0, "open loop rejected by status, no commanded-λ PE guess");

  console.log("— warm-up is not power enrichment —");
  t(r.wideband.wot.every(b => b.from >= 2000), `no WOT bin at warm-up RPM (${r.wideband.wot.map(b => b.from).join(", ")})`);
  t(r.wideband.wotDefinition.warmupExcluded === 60, `60 cold rich rows excluded (${r.wideband.wotDefinition.warmupExcluded})`);
  t(r.wideband.leanWotSamples === 40, `only the pull is judged — 40 lean samples (${r.wideband.leanWotSamples})`);

  console.log("— VE vetoes decel fuel cut and warm-up —");
  t(r.ve.decelSkipped === 30, `DFCO at λ 1.00 skipped (${r.ve.decelSkipped}) — the wideband reads air there`);
  t(r.ve.warmupSkipped === 60, `cold “not ready” skipped (${r.ve.warmupSkipped})`);
  t(r.ve.cells.every(c => c.multiplier < 1.2), "no 50% VE “correction” from free air");

  console.log("— the inference is kept as a cross-check —");
  t(r.loopCheck && r.loopCheck.notReadyRich === 60, `cross-check counts what the guess would have called PE (${r.loopCheck?.notReadyRich})`);
  t(r.loopCheck.statusOpenInferredClosed === 30, "DFCO rows are where status and inference disagree");
  t(r.loopCheck.suspect === true, `${r.loopCheck.disagreePct}% disagreement is over the ${r.loopCheck.limitPct}% limit`);
  t(r.warnings.some(w => /disagree about closed loop/.test(w)), "disagreement over the limit is a warning");
}

console.log("— closed loop disabled for VE work —");
{
  clock = 0;
  const r = analyze(csv([...seg(80, cruise), ...seg(60, ol0)]));
  t(r.ve.openLoopSamples === 60, `warm “not ready” at λ 1.00 counts as open loop (${r.ve.openLoopSamples})`);
  t(r.ve.warmupSkipped === 0, "not mistaken for warm-up when the engine is hot");
}

console.log("— decoding —");
{
  const p = { headers: ["Fuel System Status"], rows: [[2], [4], [1], [16]] };
  const read = makeLoopReader(p, { closedLoop: 0 });
  t(read([2]).closed && read([2]).reason === "normal", "SAE 2 = closed loop");
  t(!read([4]).closed && read([4]).reason === "accelDecel", "SAE 4 = OL accel/decel");
  t(!read([1]).closed && read([1]).reason === "notReady", "SAE 1 = OL not ready");
  t(read([16]).closed && read([16]).reason === "fault", "SAE 16 = CL fault");
  const flag = makeLoopReader({ headers: ["Closed Loop"], rows: [[0], [1]] }, { closedLoop: 0 });
  t(flag([1]).closed === true, "a plain 0/1 “Closed Loop” flag: 1 is closed, not “not ready”");
  const fss01 = makeLoopReader({ headers: ["Fuel System Status"], rows: [[0], [1]] }, { closedLoop: 0 });
  t(fss01([1]).closed === true, "0/1 only: read as a flag even under a Fuel System name");
  t(read(["OL - Fault"]).reason === "fault" && read(["CL - Normal"]).closed, "text states decoded");
  t(read(["banana"]) === null, "an unrecognised value is unknown, not open loop");
}

console.log("— unknown status is its own reject reason —");
{
  clock = 0;
  const r = analyze(csv([...seg(80, cruise), ...seg(20, () => cruise().replace("CL - Normal", "Mystery"))]));
  t(r.rejected.loopUnknown === 20, `unrecognised status rows counted as unknown (${r.rejected.loopUnknown}), not open loop`);
  t(r.warnings.some(w => /not a recognised fuel system state/.test(w)), "and warned about with the value shown");
}
