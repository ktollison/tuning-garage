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
import { scrubText } from "../app/modules/scrub.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter(a => !a.startsWith("-") && args[args.indexOf(a) - 1] !== "-o");
const outFlag = args.indexOf("-o") >= 0 ? args[args.indexOf("-o") + 1] : null;

if (!files.length) {
  console.error("usage: node scripts/scrub-log.mjs [--check] [-o out.csv] <log.csv> [more.csv ...]");
  process.exit(2);
}

let anyFindings = false;

for (const file of files) {
  const { text, findings } = scrubText(fs.readFileSync(file, "utf8"));

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
