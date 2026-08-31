// Package a datalog for submission to the project, and open the issue.
//
//   node scripts/submit-log.mjs <log.csv>              scrub, analyse, submit
//   node scripts/submit-log.mjs <log.csv> --dry-run    build it, send nothing
//
// The steps a contributor would otherwise do by hand, in the order that keeps
// them safe: scrub first and REFUSE if anything identifying survives, then
// analyse, then package, then offer to post it.
//
// Borrowed from the deed-parse project's submissions module: everything written
// here goes OUTSIDE the git repository. That project keeps submissions out of
// its checkout "so there's no chance of a submission ending up on GitHub", and
// the same hazard applies in reverse here — a bundle sitting in the working
// tree is one `git add -A` away from being committed to a private tuning repo
// it was never meant to enter.
//
// Also borrowed: announce when a store directory is created. A path that is
// silently created on demand makes a misconfigured location look like "no
// submissions" rather than "wrong directory", which cost that project real time.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../app/modules/loganalysis.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = process.env.TUNING_PROJECT_REPO || "ktollison/tuning-garage";
const STORE = process.env.TUNING_SUBMISSIONS_DIR
  || path.join(os.homedir(), ".local", "share", "tuning-garage", "submissions");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find(a => !a.startsWith("-"));
if (!file) {
  console.error("usage: node scripts/submit-log.mjs <log.csv> [--dry-run]");
  process.exit(2);
}
if (!fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(2); }

const step = m => console.log(`\n── ${m}`);
const has = (cmd) => spawnSync("command", ["-v", cmd], { shell: true }).status === 0;

// ---- 1. scrub, and refuse rather than warn ---------------------------------
step("Checking for identifying data");
const scrub = spawnSync(process.execPath,
  [path.join(REPO, "scripts/scrub-log.mjs"), "--check", file],
  { encoding: "utf8" });
process.stdout.write(scrub.stdout || "");
if (scrub.status !== 0) {
  console.error("\nThis log still contains identifying data. Nothing has been sent.");
  console.error(`Redact it first:  node scripts/scrub-log.mjs ${file}`);
  console.error("Then submit the .scrubbed.csv file instead.");
  process.exit(1);
}

// ---- 2. analyse ------------------------------------------------------------
step("Reading the log");
const text = await fsp.readFile(file, "utf8");
const r = analyze(text);
if (r.error) { console.error(`The analyser could not read this file: ${r.error}`); process.exit(1); }

const channels = Object.keys(r.channels || {});
console.log(`  format ${r.format} · ${r.rowCount} rows · ${channels.length} channels detected`);
if (r.resampled) console.log(`  ${r.resampled.sessions} session(s), ${r.resampled.durationSec}s`);
if (r.silentChannels?.length) console.log(`  ${r.silentChannels.length} channel(s) logged but empty`);

// ---- 3. package ------------------------------------------------------------
step("Packaging");
if (!fs.existsSync(STORE)) {
  // Say so. A silently created directory turns a wrong path into "no data".
  console.log(`  creating submission store: ${STORE}`);
  await fsp.mkdir(STORE, { recursive: true });
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(STORE, `${stamp}_${path.basename(file, path.extname(file))}`);
await fsp.mkdir(dir, { recursive: true });
await fsp.copyFile(file, path.join(dir, path.basename(file)));

const meta = {
  submittedAt: new Date().toISOString(),
  file: path.basename(file),
  bytes: (await fsp.stat(file)).size,
  format: r.format,
  rows: r.rowCount,
  usableRows: r.keptCount,
  sessions: r.resampled?.sessions ?? 1,
  channelsDetected: channels,
  channelsMissing: r.missingChannels || [],
  channelsSilent: (r.silentChannels || []).map(s => s.column),
  units: Object.fromEntries(Object.entries(r.channelUnits || {})
    .filter(([, u]) => u.column).map(([role, u]) => [role, u.unit])),
  wideband: r.wideband?.present ? { channel: r.wideband.channel, scale: r.wideband.scale.scale } : null,
  warnings: r.warnings || [],
};
await fsp.writeFile(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");

const body = [
  "### What is in this log",
  "",
  "<!-- what you were doing, and what looks wrong -->",
  "",
  "### What the analyser made of it",
  "",
  "| | |",
  "|---|---|",
  `| Format | \`${r.format}\` |`,
  `| Rows | ${r.rowCount}${r.keptCount != null ? ` (${r.keptCount} usable)` : ""} |`,
  r.resampled ? `| Sessions | ${r.resampled.sessions} over ${r.resampled.durationSec}s |` : "",
  `| Channels detected | ${channels.length} |`,
  r.wideband?.present ? `| Wideband | \`${r.wideband.channel}\` read as ${r.wideband.scale.scale} |` : "| Wideband | none found |",
  "",
  `**Channels:** ${channels.map(c => `\`${c}\``).join(", ") || "_none_"}`,
  "",
  r.missingChannels?.length ? `**Not found:** ${r.missingChannels.map(c => `\`${c}\``).join(", ")}\n` : "",
  (r.silentChannels || []).length
    ? "**Logged but empty:**\n" + r.silentChannels.map(s => `- \`${s.column}\``).join("\n") + "\n" : "",
  (r.warnings || []).length
    ? "<details><summary>Warnings</summary>\n\n" + r.warnings.map(w => `- ${w}`).join("\n") + "\n\n</details>\n" : "",
  "---",
  "_Prepared by `scripts/submit-log.mjs`. The attached log passed `scrub-log.mjs --check`._",
].filter(Boolean).join("\n");
await fsp.writeFile(path.join(dir, "issue-body.md"), body + "\n");
console.log(`  bundle: ${dir}`);

// ---- 4. submit -------------------------------------------------------------
step("Submitting");
if (dryRun) {
  console.log("  --dry-run: nothing sent.");
  console.log(`  Body ready at ${path.join(dir, "issue-body.md")}`);
  process.exit(0);
}
if (!has("gh")) {
  console.log("  The GitHub CLI (`gh`) is not installed, so nothing was posted.");
  console.log(`  Open an issue at https://github.com/${PROJECT}/issues/new/choose`);
  console.log(`  Paste:  ${path.join(dir, "issue-body.md")}`);
  console.log(`  Attach: ${path.join(dir, path.basename(file))}`);
  process.exit(0);
}
try {
  execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
} catch {
  console.log("  `gh` is installed but not signed in — run `gh auth login`, or post by hand:");
  console.log(`  https://github.com/${PROJECT}/issues/new/choose`);
  console.log(`  Body: ${path.join(dir, "issue-body.md")}`);
  process.exit(0);
}

const title = `[log] ${path.basename(file)} — ${r.format}, ${channels.length} channels`;
let url;
try {
  url = execFileSync("gh", ["issue", "create", "--repo", PROJECT, "--title", title,
    "--label", "submission", "--label", "datalog",
    "--body-file", path.join(dir, "issue-body.md")], { encoding: "utf8" }).trim();
} catch (e) {
  console.error("  Could not create the issue:", (e.stderr || e.message).toString().slice(0, 300));
  console.error(`  The bundle is still at ${dir} — post it by hand.`);
  process.exit(1);
}
console.log(`  ${url}`);
console.log("\n  GitHub issues cannot take a file attachment from the CLI —");
console.log(`  open the issue and drag in:  ${path.join(dir, path.basename(file))}`);
await fsp.writeFile(path.join(dir, "issue-url.txt"), url + "\n");
