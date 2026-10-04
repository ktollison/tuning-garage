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
  t(r.loopCheck.decelAtStoich === 30, `DFCO at stoich is an explained disagreement (${r.loopCheck.decelAtStoich})`);
  t(r.loopCheck.suspect === false, `explained disagreements do not fire the warning (${r.loopCheck.disagreePct}%)`);
}

console.log("— a wrong loop channel still trips the cross-check —");
{
  // A 0/1 "Closed Loop" flag stuck at 0 while the PCM commands stoich and
  // trims: the status says open loop with no reason that would explain it.
  clock = 0;
  const NAMES2 = NAMES.replace("Fuel System #1 Status (SAE)", "Closed Loop");
  const rows = seg(80, () => cruise().replace("CL - Normal", "0"));
  const text = `HP Tuners CSV Log File\n\n[Channel Information]\n${NAMES2.split(",").map((_, i) => i).join(",")}\n${NAMES2}\n${UNITS}\n\n[Channel Data]\n${rows.join("\n")}\n`;
  const r = analyze(text);
  t(r.loopCheck.statusOpenInferredClosed === 80, "unexplained disagreement counted");
  t(r.loopCheck.suspect === true, `${r.loopCheck.disagreePct}% is over the ${r.loopCheck.limitPct}% limit`);
  t(r.warnings.some(w => /disagree about closed loop/.test(w)), "and is a warning");
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

// ---------------------------------------------------------------------------
// The three defects found by a real idle log: a hot restart, a wideband that
// was off and then heating, and an hour of rows written with the key off.
const N3 = "Offset,Engine RPM (SAE),Engine Coolant Temp (SAE),Mass Airflow Sensor,Short Term Fuel Trim Bank 1 (SAE),Manifold Absolute Pressure (SAE),Equivalence Ratio Commanded,Wideband AFR,Fuel System #1 Status (SAE),Control Module Voltage";
const U3 = "s,rpm,°F,Hz,%,kPa,λ,AFR,,V";
const csv3 = rows => `HP Tuners CSV Log File\n\n[Channel Information]\n${N3.split(",").map((_, i) => i).join(",")}\n${N3}\n${U3}\n\n[Channel Data]\n${rows.join("\n")}\n`;
const jitter = i => (i % 7) * 0.25;           // real idle never repeats exactly
//                         rpm            ect  maf   stft map cmd  wb             status           volts
const idle    = i => `${850 + jitter(i)},186,3140,-15, 48, 1.00,${14.6 + jitter(i) / 100},CL - Normal,13.3`;
const keyOff  = () => `0,185,0,0,48,1.00,7.3125,OL - Not Ready,0`;
const keyOn   = () => `0,185,0,0,100,1.00,7.3125,OL - Not Ready,11.8`;
const heating = i => `${880 + jitter(i)},185,3140,0,48,1.00,${7.65 + jitter(i) / 100},OL - Not Ready,13.2`;   // AEM heating, O2s not ready
const hotOL   = i => `${880 + jitter(i)},185,3140,0,48,1.00,${15.4 + jitter(i) / 100},OL - Not Ready,13.2`;  // O2s not ready, wideband live
const frozen  = () => `834.75,185,0,0,48,1.00,7.3125,OL - Not Ready,0`;
const run = (n, f) => { const out = []; for (let i = 0; i < n; i++) { out.push(`${clock.toFixed(3)},${f(i)}`); clock += 0.1; } return out; };

console.log("— rows written after the PCM stopped reporting —");
{
  clock = 0;
  const r = analyze(csv3([...run(300, idle), ...run(20, keyOff), ...run(400, frozen)]));
  t(r.pcmSilence && r.pcmSilence.voltageRows === 420, `key-off rows found by module voltage (${r.pcmSilence?.voltageRows})`);
  t(r.rejected.pcmSilent === 420, "and shown in the filtered-out table");
  t(r.keptCount + Object.values(r.rejected).reduce((a, b) => a + b, 0) === r.rowCount, "every row is accounted for");
  t(!r.ve.present || r.ve.cells.every(c => c.multiplier > 0.8), "no ×0.5 VE “correction” from dead rows");
  t(r.warnings.some(w => /PCM stopped reporting/.test(w)), "warned, with the reason");
}
{
  // no voltage channel: identical rows for 30 s or more are caught instead
  clock = 0;
  const strip = rows => rows.map(l => l.split(",").slice(0, -1).join(","));
  const text = csv3(strip([...run(300, idle), ...run(400, () => frozen().replace(",0", ",9"))]))
    .replace(",Control Module Voltage", "").replace(",V\n", "\n");
  const r = analyze(text);
  t(r.pcmSilence && r.pcmSilence.frozenRows === 399, `frozen run found without a voltage channel (${r.pcmSilence?.frozenRows})`);
  t(r.pcmSilence.frozenRuns.length === 1, "reported as one run with its times");
}
{
  // steady but alive: short identical stretches are normal in test-sized logs
  clock = 0;
  const r = analyze(csv3(run(200, () => idle(0))));
  t(r.pcmSilence === null, "20 s of identical rows is not called frozen (limit 30 s)");
}

console.log("— wideband off or heating is not a mixture —");
{
  clock = 0;
  const r = analyze(csv3([...run(300, idle), ...run(270, heating), ...run(300, idle)]));
  const v = r.wideband.sensorInvalid;
  t(v.implausible === 270, `λ ≈ 0.52 samples rejected as the controller, not the engine (${v.implausible})`);
  t(v.settling >= 19 && v.settling <= 20, `and the 2 s after it comes alive (${v.settling} rows at 0.1 s)`);
  t(r.wideband.wotSamples === 0, `no false power-enrichment samples (${r.wideband.wotSamples})`);
  t(Math.abs(r.wideband.closedLoopCheck.avgMeasuredLambda - 0.997) < 0.01, `closed-loop check uses live readings only (λ ${r.wideband.closedLoopCheck.avgMeasuredLambda})`);
  t(r.warnings.some(w => /controller was off or still heating/.test(w)), "warned");
}
{
  // pegged LEAN stays visible — that may be the engine
  clock = 0;
  const lean = i => `${4000 + jitter(i)},195,7000,0,95,0.87,22.0,OL - Accel/Decel,13.8`;
  const r = analyze(csv3([...run(300, idle), ...run(40, lean)]));
  t(r.wideband.leanWotSamples === 40, `a lean-pegged wideband at WOT is still flagged (${r.wideband.leanWotSamples})`);
}

console.log("— a hot restart is warm-up, not closed loop switched off —");
{
  clock = 0;
  const r = analyze(csv3([...run(300, idle), ...run(60, keyOn), ...run(160, hotOL), ...run(300, idle)]));
  t(r.ve.warmupSkipped === 160 || r.ve.reason, `post-restart “not ready” rows skipped as warm-up (${r.ve.warmupSkipped ?? r.ve.reason})`);
  t(!r.ve.present, "so no VE correction is computed from a hot restart");
  t(r.loopCheck.notReadyAtStoich === 220 && r.loopCheck.suspect === false,   // 60 key-on + 160 running
    `not-ready at stoich is explained, not a bad channel (${r.loopCheck.disagreePct}%)`);
}
{
  // warm, not ready, and NOT just after a start: closed loop disabled on purpose
  clock = 0;
  const r = analyze(csv3([...run(300, hotOL)]));
  t(r.ve.present && r.ve.openLoopSamples === 300, `warm “not ready” with no restart is open loop for VE (${r.ve.openLoopSamples})`);
}
{
  // ... but after a start, it becomes deliberate open loop once 120 s pass
  clock = 0;
  const keyOnLiveWb = () => keyOn().replace("7.3125", "15.4");   // isolate from the wideband settle
  const r = analyze(csv3([...run(60, keyOnLiveWb), ...run(1500, hotOL)]));
  t(Math.abs(r.ve.warmupSkipped - 1200) <= 1 && r.ve.warmupSkipped + r.ve.openLoopSamples === 1500,
    `first 120 s after start skipped, the rest kept (${r.ve.warmupSkipped} / ${r.ve.openLoopSamples})`);
}
