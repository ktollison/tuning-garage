// Reports (Markdown, printable) and sharing a log with the project.
// The gh CLI is stubbed on PATH, so nothing here ever reaches GitHub.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyze, compareAnalyses } from "../../app/modules/loganalysis.mjs";
import { logReport, logCompareReport, vehicleReport, binCompareReport, DISCLAIMER } from "../../app/modules/report.mjs";
import { scrubText, vinInName } from "../../app/modules/scrub.mjs";
import { vehicleFields, buildIssue, prefillUrl, ghReady, postWithGh } from "../../app/modules/submission.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const VIN = "1ZZTEST99Z1234567";
const log = `HP Tuners CSV Log File

[Channel Information]
0,12,40001
Offset,Engine RPM (SAE),Knock Retard
s,rpm,°

[Channel Data]
${Array.from({ length: 40 }, (_, i) => `${(i * 0.1).toFixed(1)},4000,${i === 20 ? 3 : 0}`).join("\n")}
`;
const tableOk = md => md.split("\n").filter(l => l.startsWith("|")).every(l => (l.match(/(?<!\\)\|/g) || []).length >= 3);

console.log("— reports —");
{
  const r = analyze(log);
  const md = logReport(r, { file: "2026-01-01_v001_pull.csv", rev: "v001", version: "9.9.9", generated: "2026-01-02" });
  t(md.startsWith("# Log analysis — 2026-01-01_v001_pull.csv"), "titled with the log");
  t(md.trimEnd().endsWith(DISCLAIMER), "ends with the draft-reading disclaimer");
  t(/Peak retard \(°\)/.test(md) && /Units read from the log/.test(md), "units are stated in the tables");
  t(tableOk(md), "every table row is well formed");
  t(/## Events/.test(md) && /Knock retard/.test(md), "the event timeline is included");
  const d = compareAnalyses(r, r, { fileA: "a_v001_x.csv", fileB: "b_v002_x.csv" });
  const cmp = logCompareReport(d, { generated: "2026-01-02" });
  t(/v001 against v002/.test(cmp) && cmp.trimEnd().endsWith(DISCLAIMER), "the compare report names both revisions and ends with the disclaimer");
}
{
  const v = { id: "test-car", profile: `| Field | Value |\n|---|---|\n| VIN | ${VIN} — from the read |\n| Engine | 5.7L |\n| Notes | spare key code ${VIN} |\n`,
              stock: [{ name: "stock.bin", size: 524288, sha256: "ab".repeat(32) }], tunes: [], datalogs: [], sessions: [],
              changelog: "# Tune Changelog\n\nFormat:\n\n```\n## vNNN template\n```\n\n---\n\n## v001 — 2026-01-01 — Base\n", flashLog: "" };
  const md = vehicleReport(v, { insights: { revisionsNeverFlashed: ["v001"] } }, { generated: "2026-01-02" });
  t(!md.includes(VIN), "no VIN anywhere in the vehicle report — not even inside another field");
  t(/\| VIN \| on file \(not shown\) \|/.test(md), "the VIN row says it is on file, without showing it");
  t(!/vNNN template/.test(md) && /## v001/.test(md), "the changelog's template block is left out, its entries kept");
  t(/Never flashed: v001/.test(md), "gaps are listed");
  const bin = binCompareReport({ a: { file: "a.bin", size: 1, osId: 1, sha256: "a".repeat(64) }, b: { file: "b.bin", size: 1, osId: 1, sha256: "b".repeat(64) },
                                 identical: false, totalBytesChanged: 3, sizeMismatch: false, regions: [{ name: "EngineCal", bytesChanged: 3, calIdA: 1, calIdB: 2 }] }, {});
  t(/\| EngineCal \| 3 \| 1 \| 2 \|/.test(bin) && /Byte-level only/.test(bin), "bin compare report lists regions and says when it has no XDF");
}

console.log("— sharing a log —");
{
  const withVin = log.replace("Offset,Engine RPM (SAE)", `Offset,Engine RPM (SAE) ${VIN}`);
  const { text, findings } = scrubText(withVin);
  t(!text.includes(VIN) && findings.some(f => /VIN/.test(f)), "a VIN in the contents is redacted and listed");
  t(vinInName(`${VIN}.csv`) && !vinInName("2026-01-01_v001_cruise.csv"), "a VIN in the file name is recognised; an ordinary name is not");
  const f = vehicleFields(`| PCM | P01 ("0411") — donor module, my notes |\n| OS ID | 12212156 (verify) |\n| Year / Model | 2002 Camaro |\n| Engine | 5.7L LS1 |\n| VIN | ${VIN} |\n`);
  t(f.platform === "P01, OS 12212156" && f.vehicle === "2002 Camaro, 5.7L LS1", `profile fields without private notes (${f.platform} · ${f.vehicle})`);
  const issue = buildIssue(analyze(text), { file: "x.csv", ...f });
  const url = prefillUrl("owner/repo", { title: issue.title, ...f, wideband: "AEM", what: "cruise" });
  t(url.startsWith("https://github.com/owner/repo/issues/new?template=log-submission.yml") && /platform=P01/.test(url) && /what=cruise/.test(url), "the form is pre-filled by field id");
  t(!url.includes(VIN) && !issue.body.includes(VIN), "and nothing pre-filled or posted carries the VIN");
}
{
  // stub gh: answers version/auth, prints a gist URL, then an issue URL
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tg-gh-"));
  const calls = path.join(dir, "calls.log");
  const gh = path.join(dir, "gh");
  await fsp.writeFile(gh, `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  --version) echo "gh version 9" ;;
  auth) exit 0 ;;
  gist) echo "https://gist.github.com/someone/abc123" ;;
  issue) echo "https://github.com/owner/repo/issues/42" ;;
esac
`, { mode: 0o755 });
  const csv = path.join(dir, "log.csv"); await fsp.writeFile(csv, "a,b\n1,2\n");
  if (process.platform !== "win32") {
    t(ghReady(gh).ready === true, "a signed-in gh is detected");
    const r = postWithGh({ csvPath: csv, title: "[log] x", body: "body text", project: "owner/repo", gh });
    t(r.ok && r.gistUrl === "https://gist.github.com/someone/abc123" && r.issueUrl.endsWith("/issues/42"), "the log goes up as a gist and the issue links to it");
    const log_ = fs.readFileSync(calls, "utf8");
    t(/^gist create/m.test(log_) && !/--public/.test(log_), "the gist is created secret (no --public)");
    t(/issue create --repo owner\/repo/.test(log_) && /--label submission/.test(log_) && /gist\.github\.com\/someone\/abc123/.test(log_), "the issue carries the labels and the gist link");
    t(ghReady(path.join(dir, "no-such-gh")).ready === false, "a missing gh is reported as not ready");
  } else console.log("✓ gh stub tests skipped on Windows (shell-script stub)");
  await fsp.rm(dir, { recursive: true, force: true });
}
