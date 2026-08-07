// Summarise a submitted datalog as markdown, for a PR comment.
//
//   node scripts/analyse-submission.mjs submissions/logs/*.csv
//
// The point is not to tune anyone's car from CI. It is to show, on the pull
// request, what the parser actually made of the file — because the failure
// mode worth catching is the analyser reading a log confidently and wrongly.
// A log it mishandles should be obvious in the diff, not discovered months on.

import fs from "node:fs";
import path from "node:path";
import { analyze } from "../app/modules/loganalysis.mjs";

const files = process.argv.slice(2).filter(f => f.trim());
if (!files.length) { console.log("no-logs"); process.exit(0); }

const out = [];
out.push("## Datalog analysis\n");
out.push("What the parser made of the file(s) in this PR. Draft readings — review before merging.\n");

for (const file of files) {
  const name = path.basename(file);
  out.push(`### \`${name}\`\n`);
  let r;
  try {
    r = analyze(fs.readFileSync(file, "utf8"));
  } catch (e) {
    out.push(`**The analyser threw on this file** — which is itself worth fixing.\n`);
    out.push("```\n" + String(e.message || e).slice(0, 500) + "\n```\n");
    continue;
  }
  if (r.error) { out.push(`**Not readable:** ${r.error}\n`); continue; }

  const rs = r.resampled;
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Format | \`${r.format}\` |`);
  if (rs) {
    out.push(`| Resampled | ${rs.fromRows} → ${rs.toRows} rows @ ${rs.intervalMs} ms |`);
    out.push(`| Duration | ${rs.durationSec} s |`);
    if (rs.sessions > 1) out.push(`| Sessions | ${rs.sessions} |`);
    if (rs.corruptTimestamps) out.push(`| Corrupt timestamps dropped | ${rs.corruptTimestamps} |`);
  }
  out.push(`| Rows usable | ${r.keptCount} of ${r.rowCount} |`);
  out.push("");

  const found = Object.keys(r.channels).sort();
  out.push(`**Channels detected (${found.length}):** ${found.map(c => `\`${c}\``).join(", ") || "_none_"}\n`);
  if (r.missingChannels?.length)
    out.push(`**Not found:** ${r.missingChannels.map(c => `\`${c}\``).join(", ")}\n`);
  if (r.silentChannels?.length) {
    out.push("**Logged but empty:**\n");
    for (const s of r.silentChannels)
      out.push(`- \`${s.column}\`${s.superseded ? ` — \`${s.superseded}\` used instead` : ""}`);
    out.push("");
  }

  const w = r.wideband;
  if (w?.present) {
    out.push(`**Wideband:** \`${w.channel}\` — scale \`${w.scale.scale}\` (${w.scale.basis})\n`);
    if (w.closedLoopCheck) {
      const c = w.closedLoopCheck;
      out.push(`Closed loop: measured λ ${c.avgMeasuredLambda} vs commanded λ ${c.avgCommandedLambda} over ${c.samples} samples — **${c.errorPct > 0 ? "+" : ""}${c.errorPct}%**\n`);
    }
  }

  const bins = (r.mafBins?.bins || []).filter(b => b.enoughData);
  if (bins.length) {
    out.push(`**MAF bins with enough samples:** ${bins.length}\n`);
  }

  if (r.warnings?.length) {
    out.push("<details><summary>Warnings</summary>\n");
    for (const warn of r.warnings) out.push(`- ${warn}`);
    out.push("\n</details>\n");
  }
}

out.push("---");
out.push("_Posted automatically. Nothing here writes to a tune._");
console.log(out.join("\n"));
