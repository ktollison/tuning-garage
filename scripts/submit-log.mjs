// Package a datalog for submission to the project, and open the issue.
//
//   node scripts/submit-log.mjs <log.csv>              scrub, analyse, submit
//   node scripts/submit-log.mjs <log.csv> --dry-run    build it, send nothing
//   node scripts/submit-log.mjs <log.csv> --yes        post without asking
//
// The same steps as the app's "share" link (app/modules/submission.mjs). With
// the GitHub CLI signed in, the scrubbed log goes up as a secret gist and the
// issue links to it; without it, you get GitHub's form pre-filled.
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

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { analyze } from "../app/modules/loganalysis.mjs";
import { scrubText, vinInName } from "../app/modules/scrub.mjs";
import { PROJECT, STORE, vehicleFields, buildIssue, prefillUrl, ghReady, postWithGh } from "../app/modules/submission.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run"), yes = args.includes("--yes");
const file = args.find(a => !a.startsWith("-"));
if (!file) { console.error("usage: node scripts/submit-log.mjs <log.csv> [--dry-run] [--yes]"); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(2); }
const step = m => console.log(`\n── ${m}`);
const name = path.basename(file);

// ---- 1. scrub ----------------------------------------------------------------
step("Checking for identifying data");
// The scrubber reads the file's CONTENTS. Its NAME goes into the public issue,
// so a VIN in the file name would be published.
if (vinInName(name)) {
  console.error(`\nThe file NAME looks like it contains a VIN: ${name}`);
  console.error("It would appear in the public issue title. Rename the file, then run this again.");
  process.exit(1);
}
const { text, findings } = scrubText(await fsp.readFile(file, "utf8"));
console.log(findings.length ? findings.map(f => `  redacted: ${f}`).join("\n") : "  nothing identifying found");

// ---- 2. analyse ----------------------------------------------------------------
step("Reading the log");
const r = analyze(text);
if (r.error) { console.error(`The analyser could not read this file: ${r.error}`); process.exit(1); }
console.log(`  format ${r.format} · ${r.rowCount} rows · ${Object.keys(r.channels || {}).length} channels detected`);

// a log inside a vehicle folder borrows that vehicle's platform — never its VIN
const parts = path.resolve(file).split(path.sep), vi = parts.lastIndexOf("vehicles");
const profile = vi >= 0 ? path.join(parts.slice(0, vi + 2).join(path.sep), "vehicle.md") : null;
const fields = profile && fs.existsSync(profile) ? vehicleFields(fs.readFileSync(profile, "utf8")) : { platform: "", vehicle: "" };
const issue = buildIssue(r, { file: name, ...fields });

// ---- 3. package, outside the repository ----------------------------------------
step("Packaging");
if (!fs.existsSync(STORE)) { console.log(`  creating submission store: ${STORE}`); await fsp.mkdir(STORE, { recursive: true }); }
const dir = path.join(STORE, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-")}`);
await fsp.mkdir(dir, { recursive: true });
const csvPath = path.join(dir, name);
await fsp.writeFile(csvPath, text);
await fsp.writeFile(path.join(dir, "issue-body.md"), issue.body + "\n");
console.log(`  bundle: ${dir}`);

// ---- 4. submit -----------------------------------------------------------------
step("Submitting");
if (dryRun) { console.log("  --dry-run: nothing sent."); process.exit(0); }
const gh = ghReady();
if (!gh.ready) {
  console.log(`  ${gh.why}, so nothing was posted. Open GitHub's form, pre-filled:`);
  console.log(`  ${prefillUrl(PROJECT, { title: issue.title, ...fields, wideband: r.wideband?.present ? r.wideband.channel : "" })}`);
  console.log(`  …and drag in: ${csvPath}`);
  process.exit(0);
}
if (!yes) {
  if (!process.stdin.isTTY) { console.log("  Not running in a terminal, so I cannot ask. Re-run with --yes to post."); process.exit(0); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`  Post this as a PUBLIC issue on github.com/${PROJECT}, with the log as a secret gist? [y/N] `, res));
  rl.close();
  if (!/^y(es)?$/i.test(a.trim())) { console.log(`  Not posted. The bundle is at ${dir}`); process.exit(0); }
}
const posted = postWithGh({ csvPath, title: issue.title, body: issue.body, project: PROJECT });
if (!posted.ok) { console.error(`  ${posted.error}`); process.exit(1); }
console.log(`  issue: ${posted.issueUrl}\n  log:   ${posted.gistUrl}`);
await fsp.writeFile(path.join(dir, "posted.json"), JSON.stringify(posted, null, 2) + "\n");
