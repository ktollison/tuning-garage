import { convert, convertDelta, detectUnit, format, preferredUnit } from "../../app/modules/units.mjs";
import { analyze } from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

console.log("— conversions —");
t(near(convert(160, "°F", "°C"), 71.11111111111111), "160 °F = 71.111 °C");
t(near(convert(100, "°C", "°F"), 212), "100 °C = 212 °F");
t(near(convert(0, "°C", "°F"), 32), "0 °C = 32 °F");
t(near(convert(1, "psi", "kPa"), 6.894757293168361), "1 psi = 6.894757293168361 kPa");
t(near(convert(101.325, "kPa", "psi"), 14.695948775513449, 1e-9), "101.325 kPa = 14.6959 psi");
t(near(convert(1, "lb/min", "g/s"), 7.559872833333333), "1 lb/min = 7.5599 g/s");
t(near(convert(60, "mph", "km/h"), 96.56064), "60 mph = 96.56064 km/h");
t(near(convert(1, "bar", "kPa"), 100), "1 bar = 100 kPa");

console.log("— round trips —");
for (const [q, a, b] of [["temp","°F","°C"],["press","psi","kPa"],["press2","inHg","kPa"],["flow","lb/min","g/s"],["speed","mph","km/h"]]) {
  t(near(convert(convert(123.456, a, b), b, a), 123.456, 1e-9), `${q}: ${a}→${b}→${a} round-trips`);
}

console.log("— absolute vs delta (the classic trap) —");
t(near(convertDelta(10, "°F", "°C"), 5.555555555555555), "a 10 °F *change* is a 5.556 °C change");
t(near(convert(10, "°F", "°C"), -12.222222222222221), "…while 10 °F *absolute* is -12.22 °C");
t(convertDelta(10, "°F", "°C") !== convert(10, "°F", "°C"), "delta and absolute give different answers");
t(near(convertDelta(10, "psi", "kPa"), convert(10, "psi", "kPa")), "non-offset units: delta == absolute");

console.log("— header detection —");
t(detectUnit("ECT (F)").unit === "°F", "ECT (F)");
t(detectUnit("IAT (°C)").unit === "°C", "IAT (°C)");
t(detectUnit("MAP (kPa)").unit === "kPa", "MAP (kPa)");
t(detectUnit("MAF (g/s)").unit === "g/s", "MAF (g/s)");
t(detectUnit("Airflow (lb/min)").unit === "lb/min", "Airflow (lb/min)");
t(detectUnit("VSS (km/h)").unit === "km/h", "VSS (km/h)");
t(detectUnit("MAF Frequency (Hz)").unit === "Hz" && !detectUnit("MAF Frequency (Hz)").convertible, "Hz recognised, not convertible");
t(detectUnit("LTFT Bank 1 (%)").unit === "%", "percent recognised");
t(detectUnit("Closed Loop") === null, "no brackets -> no unit claimed");
t(detectUnit("LTFT Bank 1") === null, "'Bank' is NOT read as 'bar'");
t(format(71.1111, "°C", 1) === "71.1 °C", "format attaches the unit");
t(format(null, "°C") === "—", "null formats as em dash, not 0");
t(preferredUnit("temperature", { units: { temperature: "°C" } }) === "°C", "preference honoured");

console.log("— THE BUG: a Celsius log —");
const mk = (unit, val) => ["Time (s),Engine Speed (RPM),MAF Frequency (Hz),LTFT (%),STFT (%),ECT (" + unit + "),TPS (%),Closed Loop,Power Enrichment",
  ...Array.from({ length: 50 }, (_, i) => `${(i * 0.1).toFixed(1)},1800,2200,6,2,${val},15,1,0`)].join("\n");

const c = analyze(mk("C", 95));
t(c.keptCount === 50, `Celsius log keeps all 50 rows (got ${c.keptCount})`);
t(c.ectThreshold.unit === "°C" && near(c.ectThreshold.value, 71.1, 0.05), `threshold converted to ${c.ectThreshold.value} °C from ${c.ectThreshold?.from}`);
t(c.ectThreshold.converted === true, "conversion is flagged, not silent");

const f = analyze(mk("F", 203));   // 95 °C == 203 °F, same physical state
t(f.keptCount === 50, `Fahrenheit log keeps all 50 rows (got ${f.keptCount})`);
t(f.ectThreshold.value === 160 && f.ectThreshold.converted === false, "no conversion when units already match");
t(c.keptCount === f.keptCount, "same engine state, two unit systems, identical result");

const cold = analyze(mk("C", 40));  // 40 °C = 104 °F — genuinely cold
t(cold.keptCount === 0 && cold.rejected.cold === 50, "a genuinely cold Celsius log is still rejected");

console.log("— unknown unit: disable, don't guess —");
const u = analyze(mk("", 95).replace("ECT ()", "ECT"));
t(u.keptCount === 50, `unit-less ECT keeps rows rather than binning them (got ${u.keptCount})`);
t(u.ectThreshold === null, "no threshold applied");
t(u.warnings.some(w => /no unit/i.test(w)), "and it says why: " + JSON.stringify(u.warnings[0]?.slice(0, 70)));

console.log("— units reported on outputs —");
t(c.channelUnits.ect.unit === "°C" && c.channelUnits.rpm.unit === "RPM", "per-channel units reported");
t(c.mafBins.axisUnit === "Hz" && c.mafBins.valueUnit === "%", "bin axis/value units stated");
t(c.mafBins.multiplierUnit === "dimensionless ratio", "multiplier explicitly dimensionless");
console.log("\nunits tests done");
