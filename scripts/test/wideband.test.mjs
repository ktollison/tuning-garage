import { analyze, toLambda, detectScale, FUELS } from "../../app/modules/loganalysis.mjs";
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;

console.log("— scale conversion —");
t(near(toLambda(14.7, "afr", 14.7), 1.0), "14.7 AFR on gasoline = λ 1.00");
t(near(toLambda(12.5, "afr", 14.7), 0.85), "12.5 AFR = λ 0.850 (rich)");
t(near(toLambda(9.765, "afr", 9.765), 1.0), "9.765 AFR on E85 = λ 1.00 — fuel-dependent, not hard-coded");
t(near(toLambda(1.176, "eq", 14.7), 0.85), "EQ 1.176 = λ 0.850 — EQ is the reciprocal, ABOVE 1 is rich");
t(toLambda(0.85, "lambda", 14.7) === 0.85, "lambda passes through");

console.log("— scale detection —");
t(detectScale("AFR (wideband)", [14.5, 12.9]).scale === "afr", "AFR named in header");
t(detectScale("Lambda", [0.98, 1.01]).scale === "lambda", "lambda named in header");
t(detectScale("EQ Act", [1.02, 0.99]).scale === "eq", "EQ named in header");
t(detectScale("WB O2", [14.2, 13.8]).scale === "afr", "AFR inferred from magnitude");
const amb = detectScale("WB O2", [0.98, 1.02]);
t(amb.scale === "ratio-ambiguous" && amb.assumedLambda, "values near 1.0 flagged ambiguous, not silently called EQ");

console.log("— a WOT pull that goes lean (the case that matters) —");
const H = "Time (s),Engine Speed (RPM),MAF Frequency (Hz),LTFT (%),STFT (%),ECT (F),TPS (%),AFR (wideband),Commanded AFR,Closed Loop,Power Enrichment";
const rows = [];
// cruise, closed loop, on target
for (let i = 0; i < 40; i++) rows.push(`${i*0.1},1800,2200,2,1,195,15,14.7,14.7,1,0`);
// WOT pull: correct at low rpm, dangerously lean up top
for (let i = 0; i < 20; i++) rows.push(`${4+i*0.1},3000,7000,0,0,195,95,12.5,12.5,0,1`);
for (let i = 0; i < 20; i++) rows.push(`${6+i*0.1},5500,9000,0,0,195,98,15.4,12.5,0,1`);
const r = analyze([H, ...rows].join("\n"));
const wb = r.wideband;

t(wb.present, "wideband detected: " + wb.channel);
t(wb.scale.scale === "afr", "scale resolved to AFR (" + wb.scale.basis + ")");
t(wb.commandedChannel === "Commanded AFR", "commanded channel found");
t(wb.fuel.stoich === 14.7, "gasoline stoich used");
console.log("  WOT bins:");
for (const b of wb.wot) console.log(`    ${b.from}-${b.to} RPM  n=${b.n}  measured λ${b.avgLambda} (${b.avgAfr} AFR)  commanded λ${b.commandedLambda} (${b.commandedAfr} AFR)  error ${b.errorPct}%  ${b.lean ? "*** LEAN ***" : ""}`);
t(wb.wot.length === 2, "two WOT rpm bins");
t(near(wb.wot[0].avgAfr, 12.5, 0.05) && wb.wot[0].errorPct === 0, "3000 RPM bin on target, 0% error");
t(near(wb.wot[1].avgAfr, 15.4, 0.05), "5500 RPM bin measured 15.4 AFR");
t(wb.wot[1].errorPct > 20, `5500 RPM bin flagged ${wb.wot[1].errorPct}% leaner than commanded`);
t(wb.wot[1].lean === true, "5500 RPM bin marked lean (λ over 1.0 at WOT)");
t(wb.leanWotSamples === 20, `20 lean WOT samples counted (got ${wb.leanWotSamples})`);
t(wb.worstWot.lambda > 1.0 && wb.worstWot.rpm === 5500, "worst point reported: λ" + wb.worstWot.lambda + " @ " + wb.worstWot.rpm + " RPM");

console.log("— closed-loop cross-check —");
t(wb.closedLoopCheck.samples === 40, "40 closed-loop paired samples");
t(near(wb.closedLoopCheck.errorPct, 0, 0.5), "closed loop on target: " + wb.closedLoopCheck.errorPct + "%");

console.log("— trims still work alongside —");
// All 40 cruise rows survive: the first WOT row is rejected as power
// enrichment before the transient check ever sees its RPM jump, so no
// boundary row is lost from the cruise block.
t(r.keptCount === 40, `trim analysis unaffected (${r.keptCount} cruise rows kept; PE/open-loop rows excluded as before)`);

console.log("— E85 changes the AFR math, not the lambda —");
const e85 = analyze([H, ...rows].join("\n"), { fuel: "e85" });
t(e85.wideband.fuel.stoich === 9.765, "E85 stoich applied");
t(near(e85.wideband.wot[1].avgLambda, 15.4 / 9.765, 0.01), "same AFR reading is a very different lambda on E85");

console.log("— no wideband: reports absence, doesn't crash —");
const noWb = analyze(["Time (s),Engine Speed (RPM),LTFT (%),STFT (%),ECT (F),TPS (%),Closed Loop,Power Enrichment",
  "0.1,1800,2,1,195,15,1,0"].join("\n"));
t(noWb.wideband.present === false, "absence reported: " + noWb.wideband.reason);
console.log("\nwideband tests done");
