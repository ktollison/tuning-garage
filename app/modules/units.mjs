// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Units — one place where a number gets its unit, and the only place a
// conversion happens. Pure functions, no deps.
//
// Two standing rules from the repo, enforced here:
//   1. Every value states its unit.
//   2. Nothing is silently converted — a converted value always carries the
//      unit it came from, and an unknown unit is reported as unknown rather
//      than assumed.

// Quantities we can convert. Anything not listed (%, Hz, RPM, °crank, ms, V,
// g, lb) is already unambiguous in this domain: label it, never convert it.
export const QUANTITIES = {
  temperature: { canonical: "°F", units: ["°F", "°C"] },
  pressure:    { canonical: "kPa", units: ["kPa", "psi", "inHg", "bar"] },
  airflow:     { canonical: "g/s", units: ["g/s", "lb/min"] },
  speed:       { canonical: "mph", units: ["mph", "km/h"] },
};

// Exact factors relative to each family's canonical unit.
const TO_CANONICAL = {
  "kPa": v => v,
  "psi": v => v * 6.894757293168361,
  "inHg": v => v * 3.386388640341,
  "bar": v => v * 100,
  "g/s": v => v,
  "lb/min": v => v * (453.59237 / 60),
  "mph": v => v,
  "km/h": v => v / 1.609344,
};
const FROM_CANONICAL = {
  "kPa": v => v,
  "psi": v => v / 6.894757293168361,
  "inHg": v => v / 3.386388640341,
  "bar": v => v / 100,
  "g/s": v => v,
  "lb/min": v => v / (453.59237 / 60),
  "mph": v => v,
  "km/h": v => v * 1.609344,
};

export function quantityOf(unit) {
  for (const [q, def] of Object.entries(QUANTITIES)) if (def.units.includes(unit)) return q;
  return null;
}

/** Convert an ABSOLUTE measurement. Temperature has an offset, so this is not
 *  the same as converting a difference — see convertDelta. */
export function convert(value, from, to) {
  if (value == null || !Number.isFinite(value)) return null;
  if (from === to || !from || !to) return value;
  const q = quantityOf(from);
  if (!q || q !== quantityOf(to)) throw new Error(`cannot convert ${from} to ${to}`);
  if (q === "temperature") {
    const c = from === "°F" ? (value - 32) * 5 / 9 : value;
    return to === "°F" ? c * 9 / 5 + 32 : c;
  }
  return FROM_CANONICAL[to](TO_CANONICAL[from](value));
}

/** Convert a DIFFERENCE between two measurements. A 10 °F change is a 5.56 °C
 *  change, not -12.2 °C — the offset must not be applied twice. */
export function convertDelta(value, from, to) {
  if (value == null || !Number.isFinite(value)) return null;
  if (from === to || !from || !to) return value;
  const q = quantityOf(from);
  if (!q || q !== quantityOf(to)) throw new Error(`cannot convert ${from} to ${to}`);
  if (q === "temperature") return from === "°F" ? value * 5 / 9 : value * 9 / 5;
  return FROM_CANONICAL[to](TO_CANONICAL[from](value));
}

// Unit spellings seen in VCM Scanner / PCM Logger / MegaLogViewer exports.
// Order matters: longer, more specific patterns first.
const UNIT_PATTERNS = [
  [/\b(deg\s*)?[°]?\s*F\b|fahrenheit/i, "°F"],
  [/\b(deg\s*)?[°]?\s*C\b|celsius|centigrade/i, "°C"],
  [/\bkpa\b|kilopascal/i, "kPa"],
  [/\bpsi(a|g)?\b/i, "psi"],
  [/\bin\.?\s*hg\b|inches\s*hg/i, "inHg"],
  [/\bbar\b/i, "bar"],
  [/\blb\s*\/?\s*min\b|lbs?\/min|pounds?\s*per\s*min/i, "lb/min"],
  [/\bg\s*\/\s*s\b|grams?\s*per\s*sec|\bgps\b/i, "g/s"],
  [/\bkm\s*\/?\s*h\b|kph|km\/hr/i, "km/h"],
  [/\bmph\b|miles\s*per\s*hour/i, "mph"],
];

// Units we recognise but never convert — knowing them still beats guessing.
const PASSTHROUGH = [
  [/\bhz\b|hertz/i, "Hz"], [/\brpm\b/i, "RPM"], [/%|percent/i, "%"],
  [/\bdeg(rees)?\b|[°](?!\s*[FC])/i, "°"], [/\bms\b|millisec/i, "ms"],
  [/\b(volts?|v)\b/i, "V"], [/\bkpa?\/s\b/i, "kPa/s"], [/\bafr\b/i, "AFR"],
  [/\blambda\b/i, "λ"], [/\bsec(onds?)?\b|\bs\b/i, "s"],
];

/**
 * Pull the unit out of a column header like "ECT (F)" or "MAF Frequency (Hz)".
 * Only looks inside brackets — a bare word in a channel name is a name, not a
 * unit ("Bank" must never be read as "bar").
 * Returns {unit, quantity, convertible} or null when the header states none.
 */
export function detectUnit(header) {
  const inBrackets = String(header).match(/[([]([^)\]]{1,12})[)\]]\s*$/);
  if (!inBrackets) return null;
  const text = inBrackets[1].trim();
  for (const [re, unit] of UNIT_PATTERNS) {
    if (re.test(text)) return { unit, quantity: quantityOf(unit), convertible: true };
  }
  for (const [re, unit] of PASSTHROUGH) {
    if (re.test(text)) return { unit, quantity: null, convertible: false };
  }
  return { unit: text, quantity: null, convertible: false };  // unknown but stated
}

/** The single place a number becomes a string with its unit attached. */
export function format(value, unit, decimals = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Number(value).toFixed(decimals).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

export const DEFAULT_PREFERENCES = {
  units: { temperature: "°F", pressure: "kPa", airflow: "g/s", speed: "mph" },
};

/** Preferred display unit for a quantity, falling back to the canonical one. */
export function preferredUnit(quantity, prefs = DEFAULT_PREFERENCES) {
  if (!quantity) return null;
  return prefs?.units?.[quantity] || QUANTITIES[quantity]?.canonical || null;
}
