// The failsafe: a wrong unit must never reach a calculation quietly.
//
// convert() used to open with `if (from === to || !from || !to) return value`.
// So convert(14.069, null, "kPa") returned 14.069 — a psi reading handed back
// labelled kPa, out by 6.9x, with nothing anywhere saying so. Four call sites
// guarded against it by hand, which is a convention, not a guarantee.

import { convert, convertDelta, requireUnit } from "../../app/modules/units.mjs";
import { analyze } from "../../app/modules/loganalysis.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log("— an unknown unit is refused, not silently skipped —");
{
  t(throws(() => convert(14.069, null, "kPa")), "convert(v, null, target) throws");
  t(throws(() => convert(212, "°F", null)), "convert(v, source, null) throws");
  t(throws(() => convert(1, "", "kPa")), "empty string counts as unknown");
  t(throws(() => convert(1, undefined, "kPa")), "undefined counts as unknown");
  t(throws(() => convertDelta(10, null, "°C")), "convertDelta refuses too");
  t(throws(() => convertDelta(10, "°F", null)), "convertDelta refuses either side");
  // the message has to name the hazard, not just fail
  try { convert(1, null, "kPa"); } catch (e) {
    t(/unknown unit/.test(e.message), "the error names the cause");
    t(/as if it were already/.test(e.message), "the error says what would have gone wrong");
  }
}

console.log("— the honest no-ops still work —");
{
  t(convert(5, null, null) === 5, "both sides unknown: nothing claimed, value passes through");
  t(convert(5, "psi", "psi") === 5, "same unit is a no-op");
  t(convertDelta(5, null, null) === 5, "same for convertDelta");
  t(Math.abs(convert(1, "psi", "kPa") - 6.894757293168361) < 1e-12, "real conversions unaffected");
  t(convert(null, "psi", "kPa") === null, "null value still returns null, not a throw");
}

console.log("— requireUnit: one contract instead of four hand-rolled guards —");
{
  const cu = {
    map: { column: "MAP [psi]", unit: "psi", quantity: "pressure" },
    ect: { column: "ECT", unit: null, quantity: null },
    rpm: { column: "RPM [rpm]", unit: "RPM", quantity: null },
  };
  const ok = requireUnit(cu, "map", "pressure", "kPa");
  t(ok.ok && ok.converted, "a convertible channel returns a converter");
  t(Math.abs(ok.convert(14.069) - 97.0) < 0.05, `converts (14.069 psi -> ${ok.convert(14.069).toFixed(2)} kPa)`);
  t(requireUnit(cu, "ect", "temperature", "°F").ok === false, "no stated unit -> refused");
  t(/without guessing/.test(requireUnit(cu, "ect", "temperature", "°F").reason), "and says why");
  t(requireUnit(cu, "iat", "temperature", "°F").ok === false, "absent channel -> refused");
  t(requireUnit(cu, "rpm", "pressure", "kPa").ok === false, "wrong quantity -> refused");
  t(requireUnit({ map: { column: "MAP [kPa]", unit: "kPa", quantity: "pressure" } }, "map", "pressure", "kPa").converted === false,
    "already in the target unit -> no conversion claimed");
}

console.log("— every analysis refuses rather than guessing —");
// Strip the unit from one header at a time and assert the analysis that depends
// on it declines with a reason instead of emitting numbers in an unknown unit.
{
  const NAMES = "Offset,Engine RPM (SAE),Intake Manifold Absolute Pressure (SAE),Timing Advance (SAE),Knock Retard,Intake Air Temp (SAE),Engine Coolant Temp (SAE),Dynamic Airflow,Mass Airflow (SAE),Short Term Fuel Trim Bank 1 (SAE),Long Term Fuel Trim Bank 1 (SAE),Equivalence Ratio Commanded,MPVI2.1 -> AEM";
  const FULL  = "s,rpm,psi,°,°,°F,°F,lb/h,lb/min,%,%,λ,";
  const mk = (units) => {
    const rows = [];
    for (let i = 0; i < 200; i++)
      rows.push(`${(i * 0.1).toFixed(1)},2000,${7 + (i % 5) * 0.5},25,${i % 40 === 0 ? 2 : 0},135,190,133.6,2.234,-5,0,0.85,11.76`);
    return `HP Tuners CSV Log File\n\n[Channel Information]\n${NAMES.split(",").map((_, i) => i).join(",")}\n${NAMES}\n${units}\n\n[Channel Data]\n${rows.join("\n")}\n`;
  };
  const strip = (idx) => FULL.split(",").map((u, i) => (i === idx ? "" : u)).join(",");

  const base = analyze(mk(FULL));
  t(base.spark.yUnit === "kPa", "baseline: load axis in kPa");
  t(base.airModels.present, "baseline: air models compare");
  t(base.ve.present, "baseline: VE grid computes");

  const noMap = analyze(mk(strip(2)));                       // MAP unit removed
  t(!noMap.airModels.present, "no MAP unit -> air-model comparison refused");
  t(!noMap.ve.present, "no MAP unit -> VE grid refused");
  t(/unit/.test(noMap.ve.reason), "VE refusal names the unit problem");
  t(noMap.spark.yUnit !== "kPa", "spark load axis does not claim kPa it could not produce");

  const noAir = analyze(mk(strip(7)));                       // dynamic airflow unit removed
  t(!noAir.airModels.present, "no airflow unit -> comparison refused");
  t(/unit/.test(noAir.airModels.reason), "and says why");

  const noEct = analyze(mk(strip(6)));                       // coolant unit removed
  t(noEct.ectThreshold === null, "no coolant unit -> warmed-up filter disabled");
  t(noEct.warnings.some(w => /disabled rather than guessed/.test(w)), "and warns rather than guessing");

  const noIat = analyze(mk(strip(5)));                       // IAT unit removed
  const sug = noIat.spark.sparkSuggestions || [];
  t(sug.length === 0 || sug.every(c => c.iatSuspect === false),
    "no IAT unit -> the high-IAT flag is not asserted on unknown data");
  t(noIat.spark.krMap?.hotIatThreshold === null, "and no threshold is claimed");
}

console.log("\nunit-safety tests done");
