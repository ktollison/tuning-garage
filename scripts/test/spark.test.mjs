import { analyze } from "../../app/modules/loganalysis.mjs";
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const H = "Time (s),Engine Speed (RPM),MAP (kPa),LTFT (%),STFT (%),ECT (F),IAT (F),TPS (%),Spark Advance (deg),Knock Retard (deg),Closed Loop,Power Enrichment";
const r = [];
let t0 = 0;
const push = (rpm, map, tps, adv, kr, iat = 95) =>
  r.push(`${(t0 += 0.1).toFixed(1)},${rpm},${map},2,1,195,${iat},${tps},${adv},${kr},1,0`);

// clean cruise — no knock
for (let i = 0; i < 40; i++) push(1800, 40, 15, 28, 0);
// a real knock event under load: 3 samples, peak 4.5°, hot intake
for (let i = 0; i < 20; i++) push(4500, 95, 92, 22, 0, 140);
push(4500, 95, 92, 20, 2.0, 142); push(4500, 95, 92, 18, 4.5, 143); push(4500, 95, 92, 19, 3.0, 143);
for (let i = 0; i < 10; i++) push(4500, 95, 92, 22, 0, 140);
// a suspicious low-load blip — likely false knock (rough road)
push(1500, 30, 8, 30, 1.5);
// second real event, smaller
for (let i = 0; i < 5; i++) push(5200, 98, 95, 20, 0, 145);
push(5200, 98, 95, 18, 2.5, 146);

const a = analyze([H, ...r].join("\n"));
const s = a.spark;

t(s.present, "spark analysis present");
t(s.hasKnockChannel && s.hasSparkChannel, `channels found: ${s.krChannel} / ${s.sparkChannel}`);
t(s.yRole === "map" && s.yUnit === "kPa", `load axis = ${s.yRole} in ${s.yUnit}`);

console.log("\n— knock events (worst first) —");
for (const e of s.events)
  console.log(`  peak ${e.peakKr}° @ ${e.rpm} RPM, ${e.load} kPa, IAT ${e.iat}°F, spark ${e.sparkAtPeak}°, ${e.samples} samples${e.suspectFalse ? "   [suspect false knock — light load]" : ""}`);

t(s.eventCount === 3, `3 discrete knock events detected (got ${s.eventCount})`);
t(s.krSamples === 5, `5 knocking samples total (got ${s.krSamples})`);
t(s.worst.kr === 4.5 && s.worst.rpm === 4500, `worst event: ${s.worst.kr}° at ${s.worst.rpm} RPM`);
t(s.events[0].peakKr === 4.5 && s.events[0].samples === 3, "worst event groups its 3 contiguous samples");
t(s.events[0].iat === 143, "IAT at the peak captured (143 °F — heat is knock context)");
t(s.events.some(e => e.suspectFalse), "the light-load blip is flagged as suspect false knock");
t(!s.events[0].suspectFalse, "the real high-load event is NOT flagged false");

console.log("\n— KR map uses MAX per cell, not average —");
const cell = s.krMap.cells.find(c => c.x === 4500 && c.y === 90);
console.log(`  cell 4500 RPM / 90 kPa: n=${cell.n}, max=${cell.max}°, hits=${cell.hits}`);
t(cell.max === 4.5, "cell reports the 4.5° peak");
t(cell.n > cell.hits, `averaging would have hidden it: ${cell.hits} knocking samples among ${cell.n}`);
const avgWouldBe = (2.0 + 4.5 + 3.0) / cell.n;
t(avgWouldBe < 1, `(the average across that cell would read only ${avgWouldBe.toFixed(2)}°)`);

console.log("\n— spark advance map —");
const sc = s.sparkMap.cells.find(c => c.x === 1500);   // 1800 RPM floors into the 1500 bin
console.log(`  ${sc.x} RPM bin / ${sc.y} kPa: avg ${sc.avg}°, max ${sc.max}°, n=${sc.n}`);
t(sc.avg === 28, "cruise advance averaged correctly");
t(s.sparkMap.xs.includes(4500) && s.sparkMap.ys.length > 1, "spark map has both axes populated");

console.log("\n— knock data survives the fuel filters —");
t(a.keptCount < s.runningSamples, `fuel analysis kept ${a.keptCount} rows but spark saw ${s.runningSamples} — WOT rows are not discarded here`);

console.log("\n— no knock channel —");
const none = analyze(["Time (s),Engine Speed (RPM),LTFT (%),STFT (%),ECT (F),TPS (%),Closed Loop,Power Enrichment",
  "0.1,1800,2,1,195,15,1,0"].join("\n"));
t(none.spark.present === false, "absence reported: " + none.spark.reason);
console.log("\nspark tests done");
