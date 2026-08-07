// Redact identifying information from a datalog before sharing it.
//
//   node scripts/scrub-log.mjs mylog.csv                 write mylog.scrubbed.csv
//   node scripts/scrub-log.mjs mylog.csv -o clean.csv    choose the output name
//   node scripts/scrub-log.mjs --check mylog.csv         exit 1 if anything would
//                                                        be redacted (CI mode)
//
// Anything attached to a public issue or pull request is public the moment it
// is posted, and cannot be truly unpublished. Run this first.
//
// This is a TEXT transform, not a parse-and-rewrite: the file must stay
// byte-identical apart from the redactions, or it stops being evidence of what
// the logging tool actually produced. The parser is used only to locate
// columns, never to regenerate the file.
//
// What it does NOT do: read your mind about free-text you typed into a channel
// name, a filename, or the issue body. Look at the output before you post it.

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../app/modules/loganalysis.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter(a => !a.startsWith("-") && args[args.indexOf(a) - 1] !== "-o");
const outFlag = args.indexOf("-o") >= 0 ? args[args.indexOf("-o") + 1] : null;

if (!files.length) {
  console.error("usage: node scripts/scrub-log.mjs [--check] [-o out.csv] <log.csv> [more.csv ...]");
  process.exit(2);
}

// A VIN is 17 characters from a restricted alphabet — I, O and Q are excluded
// precisely so they cannot be confused with 1 and 0. Requiring at least one
// digit and one letter keeps it off 17-character words and hex runs.
const VIN = /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[^\s]*\d)(?=[^\s]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g;

// Channels that place the vehicle rather than describe it.
const LOCATING = /\b(gps|latitude|longitude|\blat\b|\blon\b|\blng\b|altitude|geo)\b/i;

let anyFindings = false;

for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  let text = original;
  const findings = [];

  // 1. VINs, anywhere in the file (preamble, notes, a channel name, the data)
  const vins = new Set(original.match(VIN) || []);
  if (vins.size) {
    findings.push(`${vins.size} VIN-shaped value(s): ${[...vins].map(v => v.slice(0, 5) + "…").join(", ")}`);
    text = text.replace(VIN, "<VIN>");
  }

  // 2. The Notes field is free text. Whatever is in it, it was not written for
  //    strangers — blank the value and keep the line so the format is intact.
  text = text.replace(/^(\s*Notes:)[ \t]*(.+)$/gm, (m, k, v) => {
    if (!v.trim()) return m;
    findings.push(`Notes field cleared (${v.trim().length} chars)`);
    return k;
  });

  // 3. Locating channels — drop the whole column, header and data
  const parsed = parseCsv(original);
  const drop = parsed.headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => LOCATING.test(h))
    .map(({ i }) => i);

  if (drop.length) {
    findings.push(`${drop.length} locating channel(s): ${drop.map(i => parsed.headers[i]).join(", ")}`);
    const kill = new Set(drop);
    const cut = line => line.split(",").filter((_, i) => !kill.has(i)).join(",");
    // Only touch rows that have the full column count — the channel-info rows
    // and the data rows. Prose lines in the preamble are left alone.
    const width = parsed.headers.length;
    text = text.split("\n")
      .map(l => (l.split(",").length === width ? cut(l) : l))
      .join("\n");
  }

  const rel = path.basename(file);
  if (!findings.length) {
    console.log(`✓ ${rel} — nothing to redact`);
    continue;
  }

  anyFindings = true;
  console.log(`${check ? "✗" : "•"} ${rel}`);
  for (const f of findings) console.log(`    ${f}`);

  if (check) continue;

  const out = outFlag || file.replace(/(\.[^.]+)$/, ".scrubbed$1");
  fs.writeFileSync(out, text);
  console.log(`    → ${out}`);
}

if (check && anyFindings) {
  console.error("\nThis log still contains identifying data. Run without --check to redact it.");
  process.exit(1);
}
if (check) console.log("\nAll clear.");
