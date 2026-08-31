// Create the labels the issue forms depend on. Safe to re-run.
//
//   node scripts/setup-labels.mjs            create or correct them
//   node scripts/setup-labels.mjs --check    report only, exit 1 if any are missing
//   node scripts/setup-labels.mjs --dry-run  say what it would do
//
// Why this exists: a GitHub issue form can only apply a label that already
// exists on the repository. If it does not, the form still works, the issue is
// still created — and it arrives with no label at all. The submission-alert
// workflow filters on `submission`, so an absent label means every submission
// goes unannounced, with no error anywhere to notice. That was the live state
// of this project until it was tested end to end.
//
// The label set is NOT hardcoded twice. The forms are the source of truth for
// which labels are needed; the table below only supplies colour and wording.
// A form referencing a label with no entry here is an error, so adding a form
// without describing its label cannot pass silently.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMS = path.join(REPO, ".github", "ISSUE_TEMPLATE");
const PROJECT = process.env.TUNING_PROJECT_REPO || "ktollison/tuning-garage";
const check = process.argv.includes("--check");
const dryRun = process.argv.includes("--dry-run");

const DESCRIBED = {
  submission:           { color: "0E8A16", description: "A contribution: log, channel name, math parameter or platform" },
  datalog:              { color: "1D76DB", description: "A submitted datalog" },
  "channel-dictionary": { color: "5319E7", description: "A VCM Scanner parameter ID and its name" },
  "user-math":          { color: "FBCA04", description: "A math parameter for the User Math repository" },
  platform:             { color: "D93F0B", description: "Support for a controller the app does not handle" },
};

// ---- what the forms actually ask for --------------------------------------
const wanted = new Set();
let forms = [];
try { forms = fs.readdirSync(FORMS).filter(f => f.endsWith(".yml") && f !== "config.yml"); }
catch { console.error(`No issue forms at ${FORMS}`); process.exit(1); }
for (const f of forms) {
  const text = fs.readFileSync(path.join(FORMS, f), "utf8");
  const m = text.match(/^labels:\s*\[([^\]]*)\]/m);
  if (!m) continue;
  for (const raw of m[1].split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "");
    if (name) wanted.add(name);
  }
}
console.log(`${forms.length} issue form(s) reference ${wanted.size} label(s)`);

// Drift guard, and it needs no network: a form asking for a label nobody has
// described means the two lists have diverged.
const undescribed = [...wanted].filter(n => !DESCRIBED[n]);
if (undescribed.length) {
  console.error(`\nThese labels are used by an issue form but not described in setup-labels.mjs:`);
  for (const n of undescribed) console.error(`  ${n}`);
  console.error("Add them to DESCRIBED, so the label is created with a colour and a description.");
  process.exit(1);
}

// ---- what the repo has ----------------------------------------------------
let existing;
try {
  execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
  existing = new Map(JSON.parse(
    execFileSync("gh", ["label", "list", "--repo", PROJECT, "--limit", "200",
                        "--json", "name,color,description"], { encoding: "utf8" }) || "[]"
  ).map(l => [l.name, l]));
} catch (e) {
  console.error(`\nCould not read labels from ${PROJECT}: ${(e.stderr || e.message).toString().trim().slice(0, 200)}`);
  console.error("Needs the GitHub CLI, signed in, with access to that repository.");
  process.exit(1);
}

const missing = [], wrong = [], fine = [];
for (const name of wanted) {
  const want = DESCRIBED[name], have = existing.get(name);
  if (!have) { missing.push(name); continue; }
  // Compare case-insensitively: the API echoes colours back lower-case.
  if (have.color.toLowerCase() !== want.color.toLowerCase() || (have.description || "") !== want.description)
    wrong.push(name);
  else fine.push(name);
}

for (const n of fine) console.log(`  ✓ ${n}`);
for (const n of wrong) console.log(`  ~ ${n} — exists, colour or description differs`);
for (const n of missing) console.log(`  ✗ ${n} — MISSING`);

if (check) {
  if (missing.length) {
    console.error(`\n${missing.length} label(s) missing. Issue forms cannot apply a label that does not exist,`);
    console.error("so submissions would arrive unlabelled and the alert workflow would never fire.");
    console.error("Fix with:  node scripts/setup-labels.mjs");
    process.exit(1);
  }
  console.log("\nAll labels present.");
  process.exit(0);
}
if (!missing.length && !wrong.length) { console.log("\nNothing to do."); process.exit(0); }
if (dryRun) { console.log(`\n--dry-run: would create ${missing.length}, update ${wrong.length}.`); process.exit(0); }

// ---- make it so -----------------------------------------------------------
let created = 0, updated = 0;
for (const name of [...missing, ...wrong]) {
  const { color, description } = DESCRIBED[name];
  const isNew = missing.includes(name);
  const args = ["label", "create", name, "--repo", PROJECT, "--color", color, "--description", description];
  // --force turns create into upsert, which is what makes this re-runnable.
  if (!isNew) args.push("--force");
  try {
    execFileSync("gh", args, { stdio: "pipe" });
    console.log(`  ${isNew ? "created" : "updated"} ${name}`);
    isNew ? created++ : updated++;
  } catch (e) {
    const msg = (e.stderr || e.message).toString();
    // A label created between our read and this write is not a failure.
    if (/already exists/i.test(msg)) { console.log(`  ${name} already existed — left alone`); continue; }
    console.error(`  FAILED ${name}: ${msg.trim().slice(0, 160)}`);
    process.exitCode = 1;
  }
}
console.log(`\n${created} created, ${updated} updated.`);
