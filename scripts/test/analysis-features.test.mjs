// Before/after compare, the event timeline and math channels — on synthetic
// logs whose answers are known.

import { analyze, compareAnalyses } from "../../app/modules/loganalysis.mjs";
import { compile } from "../../app/modules/expr.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const hpt = (names, units, rows, ids) => `HP Tuners CSV Log File\n\n[Channel Information]\n${(ids || names.map((_, i) => i)).join(",")}\n${names.join(",")}\n${units.join(",")}\n\n[Channel Data]\n${rows.join("\n")}\n`;

// steady closed-loop cruise at one MAF frequency, with a chosen total trim
const cruise = (hz, trim, n = 60, t0 = 0) => Array.from({ length: n }, (_, i) =>
  `${(t0 + i * 0.1).toFixed(1)},2000,20,190,${hz},${trim},0,CL - Normal`);
const NAMES = ["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Engine Coolant Temp (SAE)", "Mass Airflow Sensor",
               "Long Term Fuel Trim Bank 1 (SAE)", "Short Term Fuel Trim Bank 1 (SAE)", "Fuel System #1 Status (SAE)"];
const UNITS = ["s", "rpm", "%", "°F", "Hz", "%", "%", ""];

console.log("— before / after —");
{
  const before = analyze(hpt(NAMES, UNITS, [...cruise(3200, 10), ...cruise(4200, 5, 60, 6.0)]));
  const after = analyze(hpt(NAMES, UNITS, [...cruise(3200, 2), ...cruise(5200, 1, 60, 6.0)]));
  const d = compareAnalyses(before, after, { fileA: "2026-01-01_v001_cruise.csv", fileB: "2026-01-08_v002_cruise.csv" });
  const b3 = d.maf.find(m => m.from === 3000);
  t(b3 && b3.trimA === 10 && b3.trimB === 2 && b3.delta === -8, `3000–3500 Hz: +10 % → +2 %, change −8 (${b3?.delta})`);
  t(b3.better === true, "and it is reported as closer to zero");
  const only = d.maf.filter(m => m.delta === null).map(m => m.from);
  t(only.includes(4000) && only.includes(5000), `bins in only one log are shown, not compared (${only.join(", ")})`);
  t(d.warnings.some(w => /only one of the two logs/.test(w)), "and the difference in coverage is warned about");
  t(d.a.rev === "v001" && d.b.rev === "v002", "revisions read from the file names");
}

console.log("— event timeline —");
{
  // knock at exactly t = 2.0 s
  const rows = Array.from({ length: 50 }, (_, i) => `${(i * 0.1).toFixed(1)},4000,95,90,${i === 20 ? 4 : 0},28`);
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Throttle Position (SAE)", "Intake Manifold Absolute Pressure (SAE)", "Knock Retard", "Timing Advance (SAE)"],
                        ["s", "rpm", "%", "kPa", "°", "°"], rows));
  const k = r.timeline.events.find(e => e.type === "knock");
  t(k && k.t === 2, `knock marker at 2.0 s (${k?.t})`);
  t(k.snapshot.some(c => /Engine RPM/.test(c.channel) && c.value === 4000), "its snapshot holds every channel, RPM 4000 included");
  t(r.timeline.durationSec === 4.9, `duration 4.9 s (${r.timeline.durationSec})`);
}
{
  // module voltage collapses for 3 s mid-log: one PCM-silent stretch
  const row = (t, v) => `${t.toFixed(1)},${850 + (Math.round(t * 10) % 7)},${v},186,3140,-15,48`;
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(row(i * 0.1, 13.3));
  for (let i = 50; i < 80; i++) rows.push(row(i * 0.1, 0));
  for (let i = 80; i < 120; i++) rows.push(row(i * 0.1, 13.3));
  const r = analyze(hpt(["Offset", "Engine RPM (SAE)", "Control Module Voltage", "Engine Coolant Temp (SAE)", "Mass Airflow Sensor", "Short Term Fuel Trim Bank 1 (SAE)", "Manifold Absolute Pressure (SAE)"],
                        ["s", "rpm", "V", "°F", "Hz", "%", "kPa"], rows));
  const silent = r.timeline.events.filter(e => e.type === "silent");
  t(silent.length === 1 && silent[0].t === 5 && silent[0].tEnd === 7.9, `one PCM-silent stretch, 5.0–7.9 s (${silent.map(e => `${e.t}–${e.tEnd}`).join(", ")})`);
}

console.log("— math channels —");
{
  const names = ["Offset", "Engine RPM (SAE)", "Long Term Fuel Trim Bank 1 (SAE)", "Short Term Fuel Trim Bank 1 (SAE)", "Equivalence Ratio Commanded", "Wideband AFR"];
  const rows = Array.from({ length: 30 }, (_, i) => `${(i * 0.1).toFixed(1)},2000,4,2,1.000,${(1.02 * 14.7).toFixed(4)}`);
  const text = hpt(names, ["s", "rpm", "%", "%", "λ", "AFR"], rows, [0, 12, 40, 41, 2700, 9999]);
  const formulas = [
    { id: "by-id", name: "Doubled RPM", expression: "[12]*2", units: "rpm" },
    { id: "trim", name: "Total fuel trim", expression: "LTFT + STFT", units: "%" },
    { id: "afr-err", name: "AFR error", expression: "(WB_AFR - Commanded_AFR) / Commanded_AFR * 100", units: "%" },
    { id: "fn", name: "Uses a function", expression: "ABS([12])" },
    { id: "gen5", name: "Gen 5 only", expression: "[12]", platform: "gm-gen5" },
    { id: "missing", name: "Needs boost", expression: "[50030] * 2" },
  ];
  const m = analyze(text, { formulas }).math;
  const by = id => m.computed.find(c => c.id === id), skip = id => m.skipped.find(c => c.id === id);
  t(by("by-id")?.avg === 4000, `[12]*2 resolved through the parameter-ID row (${by("by-id")?.avg})`);
  t(by("trim")?.avg === 6, `LTFT + STFT = 6 % (${by("trim")?.avg})`);
  // commanded is λ, the wideband AFR: the error must be +2 %, not thousands
  t(Math.abs(by("afr-err")?.avg - 2) < 0.01, `AFR error across a λ channel and an AFR channel is +2 % (${by("afr-err")?.avg})`);
  t(/not supported/.test(skip("fn")?.reason || ""), "a function is refused with the reason");
  t(/gm-gen5/.test(skip("gen5")?.reason || ""), "a formula for another platform is skipped with the reason");
  t(/does not have/.test(skip("missing")?.reason || ""), "a missing input is reported, never computed as zero");
}
{
  const c = compile("[12] * 2");
  t(Number.isNaN(c.eval({ "[12]": null })), "a missing input evaluates to NaN, not 0");
  t(compile("X*-2").eval({ X: 3 }) === -6 && compile("2^3^2").eval({}) === 512, "the shared compiler keeps the unary-minus and power fixes");
  t(!compile("(1+2").ok && !compile("1+2)").ok, "unbalanced parentheses are refused");
}
