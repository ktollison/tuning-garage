// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Redact identifying information from a datalog's text. Shared by
// scripts/scrub-log.mjs and the app's "Share with the project" flow.
//
// A TEXT transform, not a parse-and-rewrite: the result stays byte-identical
// apart from the redactions, or it stops being evidence of what the logging
// tool produced. The parser is used only to locate columns.
//
// It cannot read your mind about free text typed into a channel name or an
// issue body. Look at the output before posting it anywhere.

import { parseCsv, rejoinNames } from "./loganalysis.mjs";

// A VIN is 17 characters from a restricted alphabet — I, O and Q are excluded
// so they cannot be confused with 1 and 0. Requiring a digit and a letter keeps
// it off 17-character words and hex runs.
export const VIN = /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[^\s]*\d)(?=[^\s]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g;

// The same shape inside a file NAME, which has no word boundaries to lean on.
const VIN_IN_NAME = /(?<![A-Z0-9])(?=[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9]))(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}/i;
export const vinInName = name => VIN_IN_NAME.test(String(name || ""));

// Channels that place the vehicle rather than describe it.
export const LOCATING = /\b(gps|latitude|longitude|\blat\b|\blon\b|\blng\b|altitude|geo)\b/i;

export function scrubText(original) {
  let text = original;
  const findings = [];

  // 1. VINs, anywhere in the file (preamble, notes, a channel name, the data)
  const vins = new Set(original.match(VIN) || []);
  if (vins.size) {
    findings.push(`${vins.size} VIN-shaped value(s): ${[...vins].map(v => v.slice(0, 5) + "…").join(", ")}`);
    text = text.replace(VIN, "<VIN>");
  }

  // 2. The Notes field is free text written for yourself, not strangers —
  //    blank the value and keep the line so the format is intact.
  text = text.replace(/^(\s*Notes:)[ \t]*(.+)$/gm, (m, k, v) => {
    if (!v.trim()) return m;
    findings.push(`Notes field cleared (${v.trim().length} chars)`);
    return k;
  });

  // 3. Locating channels — drop the whole column, header and data
  const parsed = parseCsv(original);
  const drop = parsed.headers.map((h, i) => ({ h, i })).filter(({ h }) => LOCATING.test(h)).map(({ i }) => i);
  if (drop.length) {
    findings.push(`${drop.length} locating channel(s): ${drop.map(i => parsed.headers[i]).join(", ")}`);
    const kill = new Set(drop);
    const width = parsed.headers.length;
    // Rows with the full column count are cut field by field. The channel-name
    // row can have MORE fields — "MPVI2.1 -> AEM 30-(03x0,2340,5130)" holds
    // commas — so regroup it exactly as the parser does, then cut by column.
    // Prose in the preamble matches neither and is left alone.
    const cut = line => {
      const f = line.split(",");
      const cols = f.length === width ? f : f.length > width ? rejoinNames(f, width) : null;
      return cols && cols.length === width ? cols.filter((_, i) => !kill.has(i)).join(",") : line;
    };
    text = text.split("\n").map(cut).join("\n");
  }
  return { text, findings };
}
