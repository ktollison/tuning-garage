// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Reports as Markdown: readable on GitHub, diffable in git, printable to PDF
// through the app's print view. Pure functions — no file or network access.
//
// Every figure states its unit, every report ends with the draft-reading
// disclaimer, and no report ever contains a VIN.

// The same wording the app shows for each filter.
export const REJECT_LABELS = {
  pcmSilent: "PCM not reporting (key off / logger kept recording)", noData: "No data in row (between sessions)",
  cold: "Not warmed up", openLoop: "Open loop", loopUnknown: "Loop state unknown (no status reading)",
  powerEnrich: "Power enrichment", transient: "Transient (throttle/RPM moving)", notRunning: "Engine not running",
  incompleteTrim: "Only one trim channel live", noTrimData: "No trim data in row",
};

export const DISCLAIMER = "*Draft readings, not advice. Every figure is arithmetic on data you supplied; nothing here writes to a tune. Apply any change by hand, after you agree with it, and log again.*";

// The last thing every report passes through: anything VIN-shaped, anywhere,
// becomes <VIN>. A profile note or a channel name must not carry one out.
const VIN_ANY = /(?<![A-Z0-9])(?=[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9]))(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}/g;
export const noVin = md => md.replace(VIN_ANY, "<VIN>");

const cell = v => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
const table = (head, rows) => rows.length
  ? [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.map(cell).join(" | ")} |`)].join("\n")
  : "_None._";
const signed = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${+Number(v).toFixed(d)}`);
const header = (title, meta, lines) => [`# ${title}`, "", ...lines.filter(Boolean).map(l => `- ${l}`),
  `- Generated ${meta.generated || new Date().toISOString().slice(0, 10)} by Tuning Garage${meta.version ? ` v${meta.version}` : ""}`, ""].join("\n");

// ---------- one log ----------
export function logReport(r, meta = {}) {
  const out = [header(`Log analysis — ${meta.file || "datalog"}`, meta, [
    meta.vehicle && `Vehicle: ${meta.vehicle}`,
    meta.rev && `Recorded against revision: ${meta.rev}`,
    `Format: ${r.format}; ${r.rowCount?.toLocaleString?.() ?? r.rowCount} rows${r.resampled ? `, ${r.resampled.sessions} session(s) over ${r.resampled.durationSec} s` : ""}`,
    `Usable for trims: ${r.keptCount} rows`,
  ])];

  out.push("## Data quality", "",
    table(["Filtered out", "Rows"], Object.entries(r.rejected || {}).filter(([, n]) => n).map(([k, n]) => [REJECT_LABELS[k] || k, n])), "");
  if (r.loopCheck?.rows) out.push(`Loop state from **${r.loopCheck.channel}**, consistent with commanded mixture on ${r.loopCheck.consistentPct}% of ${r.loopCheck.rows} rows.`, "");
  if (r.warnings?.length) out.push("### Warnings", "", ...r.warnings.map(w => `- ${w}`), "");
  out.push("### Units read from the log", "",
    table(["Role", "Channel", "Unit"], Object.entries(r.channelUnits || {}).filter(([, u]) => u.column).map(([role, u]) => [role, u.column, u.unit || "not stated"])), "");

  const bins = (r.mafBins?.bins || []).filter(b => b.n > 0);
  out.push(`## Fuel trim by MAF frequency (${r.mafBins?.axisUnit || "Hz"})`, "",
    table([`MAF (${r.mafBins?.axisUnit || "Hz"})`, "Samples", "LTFT (%)", "STFT (%)", "Total (%)", "Suggested MAF change (%)", "Multiplier (ratio)"],
      bins.map(b => [`${b.from}–${b.to}`, b.n, signed(b.avgLtft), signed(b.avgStft), signed(b.avgTotal),
        b.enoughData ? signed(b.suggestedPct, 1) : `too few samples (need ${r.mafBins.minSamples})`, b.enoughData ? b.multiplier : "—"])),
    "", "Positive trim means the PCM is adding fuel: the MAF reads low there and its value should go up by that percentage.", "");

  const w = r.wideband;
  if (w?.present) {
    out.push(`## Wideband — ${w.channel}`, "",
      `Scale: ${w.scale.scale} (${w.scale.basis}). Wideband read at ${w.stoichs?.wb?.value} AFR = λ 1.00; PCM stoich ${w.stoichs?.pcm?.value ?? "not needed"}.`, "",
      w.leanWotSamples
        ? `**⚠ ${w.leanWotSamples} of ${w.wotSamples} power-enrichment or WOT samples ran more than ${w.wotDefinition.leanMarginPct}% leaner than commanded, or leaner than λ ${w.wotDefinition.leanLimitLambda}.** Leanest: λ ${w.worstWot.lambda} at ${Math.round(w.worstWot.rpm)} RPM${w.worstWot.commanded ? ` against λ ${w.worstWot.commanded} commanded` : ""}.`
        : `No enrichment sample ran lean of commanded (${w.wotSamples} checked).`, "",
      table(["RPM", "Samples", "Measured (λ)", "Commanded (λ)", "Error (% lean +)", "Leanest (λ)"],
        (w.wot || []).map(b => [`${b.from}–${b.to}`, b.n, b.avgLambda, b.commandedLambda, signed(b.errorPct, 1), b.leanestLambda])), "");
    if (w.closedLoopCheck) out.push(`Closed-loop check: measured λ ${w.closedLoopCheck.avgMeasuredLambda} against λ ${w.closedLoopCheck.avgCommandedLambda} commanded over ${w.closedLoopCheck.samples} samples (${signed(w.closedLoopCheck.errorPct, 1)} %).`, "");
  }

  const s = r.spark;
  if (s?.present) {
    out.push(`## Spark and knock${s.krChannel ? ` — ${s.krChannel}` : ""}`, "",
      s.krSamples ? `**⚠ Knock retard on ${s.krSamples} sample(s) across ${s.eventCount} event(s).** Worst ${s.worst.kr}° at ${s.worst.rpm} RPM.` : `No knock retard across ${s.runningSamples} running samples.`, "");
    if (s.events?.length) out.push(table(["Time (s)", "Peak retard (°)", "RPM", `Load (${s.yUnit || "unit not stated"})`, `IAT (${s.iatUnit || "unit not stated"})`, "Samples"],
      s.events.map(e => [e.t, e.peakKr, e.rpmRange, e.load, e.iat, e.samples])), "");
    if (s.sparkSuggestions?.length) out.push("### Suggested spark change", "",
      table(["RPM", `Load (${s.yUnit || "?"})`, "Max KR (°)", "Subtract (°)", "Note"],
        s.sparkSuggestions.map(c => [`${c.rpm}–${c.rpm + s.rpmBin}`, c.load, c.maxKr, c.iatSuspect ? "—" : c.delta, c.iatSuspect ? "heat, not timing — check the IAT retard table" : "High Octane table"])), "");
  }

  if (r.airModels?.present) out.push("## MAF vs speed-density", "", `Overall ${signed(r.airModels.overallDiffPct, 1)} % (dynamic airflow against MAF).`, "",
    table(["RPM", "Load (kPa)", "Samples", "Dyn air (g/s)", "MAF (g/s)", "Difference (%)"],
      r.airModels.cells.filter(c => c.enoughData).map(c => [`${c.x}–${c.x + r.airModels.rpmBin}`, c.y, c.n, c.dynAirGs, c.mafGs, signed(c.diffPct, 1)])), "");
  if (r.ve) out.push("## VE correction (open loop only)", "", r.ve.present
    ? table(["RPM", "Load (kPa)", "Samples", "Measured (λ)", "Commanded (λ)", "Multiply VE by (ratio)", "Change (%)"],
        r.ve.cells.filter(c => c.enoughData).map(c => [`${c.x}–${c.x + r.ve.rpmBin}`, c.y, c.n, c.avgMeasuredLambda, c.avgCommandedLambda, c.multiplier, signed(c.changePct, 1)]))
    : `Not computed — ${r.ve.reason}.`, "");

  if (r.math?.computed?.length || r.math?.skipped?.length) {
    out.push("## Math channels", "", table(["Formula", "Min", "Avg", "Max", "Unit", "Samples", "Status"],
      r.math.computed.map(m => [m.name, m.min, m.avg, m.max, m.unit || "not stated", m.samples, m.status])), "");
    if (r.math.skipped.length) out.push("Not computed:", "", ...r.math.skipped.map(m => `- ${m.name} — ${m.reason}`), "");
  }
  if (r.timeline?.events?.length) out.push("## Events", "", table(["Time (s)", "Until (s)", "Event", "Detail"],
    r.timeline.events.map(e => [e.t, e.tEnd, e.label, e.detail])), "");

  out.push("---", "", DISCLAIMER, "");
  return noVin(out.join("\n"));
}

// ---------- two logs ----------
export function logCompareReport(d, meta = {}) {
  const out = [header(`Before / after — ${d.a.rev || "A"} against ${d.b.rev || "B"}`, meta, [
    meta.vehicle && `Vehicle: ${meta.vehicle}`,
    `A: ${d.a.file} (${d.a.usable} usable rows)`,
    `B: ${d.b.file} (${d.b.usable} usable rows)`,
  ])];
  if (d.warnings.length) out.push(...d.warnings.map(w => `- ⚠ ${w}`), "");
  out.push("## Fuel trim by MAF frequency", "",
    table(["MAF (Hz)", "Samples A", "Samples B", "Trim A (%)", "Trim B (%)", "Change (%)", "Closer to zero?"],
      d.maf.map(m => [`${m.from}–${m.to}`, m.nA, m.nB, signed(m.trimA), signed(m.trimB), m.delta === null ? "not compared" : signed(m.delta), m.better === null ? "—" : m.better ? "yes" : "no"])), "");
  if (d.wot.length) out.push("## Enrichment: error against commanded by RPM", "",
    table(["RPM", "Samples A", "Samples B", "Error A (% lean +)", "Error B (% lean +)", "Change (%)"],
      d.wot.map(w => [`${w.from}–${w.to}`, w.nA, w.nB, signed(w.errorA, 1), signed(w.errorB, 1), w.delta === null ? "not compared" : signed(w.delta, 1)])), "");
  out.push("## Knock", "", table(["", "A", "B"], [
    ["Samples with retard", d.knock.a.samples, d.knock.b.samples],
    ["Events", d.knock.a.events, d.knock.b.events],
    ["Worst retard (°)", d.knock.a.worst, d.knock.b.worst],
  ]), "");
  if (d.closedLoop.a || d.closedLoop.b) out.push(`Closed-loop wideband check: A ${signed(d.closedLoop.a?.errorPct, 1)} %, B ${signed(d.closedLoop.b?.errorPct, 1)} %.`, "");
  out.push("---", "", DISCLAIMER, "");
  return noVin(out.join("\n"));
}

// ---------- the vehicle ----------
export function vehicleReport(v, timeline, meta = {}) {
  const rows = [...String(v.profile || "").matchAll(/^\| (.+?) \| (.*?) \|$/gm)]
    .filter(m => !/^-+$/.test(m[1]) && m[1] !== "Field")
    .map(m => (/^VIN$/i.test(m[1].trim()) ? [m[1], /[A-HJ-NPR-Z0-9]{17}/i.test(m[2]) ? "on file (not shown)" : "not recorded"] : [m[1], m[2]]));
  const ins = timeline?.insights || {};
  const out = [header(`Vehicle history — ${v.id}`, meta, [
    `Currently flashed: ${v.currentRevision || "none recorded"}`,
    `Last flashed: ${v.lastFlashed || "—"}`,
  ])];
  out.push("## Profile", "", table(["Field", "Value"], rows), "",
    "## Baseline (stock read)", "", table(["File", "Size (bytes)", "SHA-256 (first 16)"],
      (v.stock || []).map(f => [f.name, f.size, (f.sha256 || "").slice(0, 16)])), "",
    "## Revisions", "", table(["File", "Size (bytes)", "SHA-256 (first 16)"],
      (v.tunes || []).map(f => [f.name, f.size, (f.sha256 || "").slice(0, 16)])), "");
  // the changelog's own heading and its "Format:" template are not history
  if (v.changelog) out.push("## Tune changelog", "", String(v.changelog).replace(/^#\s.*\n/, "")
    .replace(/Format:\s*```[\s\S]*?```/, "").replace(/^\s*---\s*$/m, "").trim(), "");
  if (v.flashLog) out.push("## Flash log", "", String(v.flashLog).split("\n").filter(l => l.startsWith("|")).join("\n"), "");
  out.push("## Datalogs and sessions", "", `${(v.datalogs || []).length} datalog(s), ${(v.sessions || []).length} session log(s).`, "");
  const gaps = [
    ins.revisionsNeverFlashed?.length && `Never flashed: ${ins.revisionsNeverFlashed.join(", ")}`,
    ins.revisionsWithoutLogs?.length && `No datalog: ${ins.revisionsWithoutLogs.join(", ")}`,
    ins.orphanLogRevs?.length && `Logs naming a revision that is not checked in: ${ins.orphanLogRevs.join(", ")}`,
  ].filter(Boolean);
  out.push("## Gaps worth noticing", "", gaps.length ? gaps.map(g => `- ${g}`).join("\n") : "None: every revision flashed and logged.", "",
    "---", "", DISCLAIMER, "");
  return noVin(out.join("\n"));
}

// ---------- two bins ----------
export function binCompareReport(c, meta = {}) {
  const out = [header(`Bin compare — ${c.a.file.split("/").pop()} → ${c.b.file.split("/").pop()}`, meta, [
    `A: ${c.a.file} (${c.a.size} bytes, OS ${c.a.osId ?? "?"}, SHA-256 ${c.a.sha256.slice(0, 16)}…)`,
    `B: ${c.b.file} (${c.b.size} bytes, OS ${c.b.osId ?? "?"}, SHA-256 ${c.b.sha256.slice(0, 16)}…)`,
    c.identical ? "**Byte-identical.**" : `${c.totalBytesChanged} byte(s) differ${c.sizeMismatch ? " — different sizes" : ""}`,
  ])];
  if (c.regions) out.push("## Regions", "", table(["Region", "Bytes changed", "Cal ID A", "Cal ID B"],
    c.regions.map(g => [g.name, g.bytesChanged, g.calIdA, g.calIdB])), "");
  const td = c.tableDiff;
  if (td?.changed?.length) out.push(`## Tables changed (read through ${td.xdf})`, "",
    table(["Table", "Cells changed", "Avg change", "Max change", "Unit"],
      td.changed.map(t => [t.title, `${t.changedCells} / ${t.totalCells}`, signed(t.avgDelta, 4), signed(t.maxDelta, 4), t.units || "not stated"])), "");
  else if (td && !td.error) out.push(`No table defined in ${td.xdf} differs.`, "");
  else out.push("Byte-level only: add an XDF for this OS to name the tables that changed.", "");
  out.push("---", "", DISCLAIMER, "");
  return noVin(out.join("\n"));
}
