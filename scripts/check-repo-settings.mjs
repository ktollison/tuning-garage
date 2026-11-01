// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Do the GitHub repository's SETTINGS match what the docs promise?
//
//   node scripts/check-repo-settings.mjs            check; exit 1 if a promise is broken
//   node scripts/check-repo-settings.mjs --offline  skip (exit 0) if gh cannot be used
//   node scripts/check-repo-settings.mjs --skip-labels  leave the issue-form labels to setup-labels.mjs
//
// For maintainers of a public copy (see MAINTAINING.md). The docs make promises
// that only a repository setting can keep, and a setting can be switched off
// without anyone touching a file. SECURITY.md sent people to "private
// vulnerability reporting" for weeks while it was disabled, and nothing
// noticed. Settings need an administrator's token, so this runs on your machine
// (inside scripts/publish-public.mjs), not in CI.
//
// It only reads. Each finding prints the command that fixes it.

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const PROJECT = process.env.TUNING_PROJECT_REPO || "ktollison/tuning-garage";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure: `s` is what GitHub says. Returns one entry per promise.
 *   must   — a doc states this as fact; if the setting is off, the doc is wrong
 *   should — worth having, but nothing in the docs depends on it
 */
export function evaluate(s, project = PROJECT) {
  const r = s.repo || {}, p = s.protection;
  const out = [];
  const check = (level, ok, what, promised, fix) => out.push({ level, ok: !!ok, what, promised, fix });

  check("must", r.private === false, "the repository is public", "the README tells people to use this template", `gh repo edit ${project} --visibility public --accept-visibility-change-consequences`);
  check("must", r.is_template === true, "it is a template repository", "“Use this template” is how people get a copy", `gh repo edit ${project} --template`);
  check("must", r.has_discussions === true, "Discussions are enabled", "CONTRIBUTING.md and the issue forms send questions to Discussions", `gh repo edit ${project} --enable-discussions`);
  check("must", s.vulnerabilityReporting === true, "private vulnerability reporting is enabled", "SECURITY.md and CODE_OF_CONDUCT.md send reports to it", `gh api -X PUT repos/${project}/private-vulnerability-reporting`);
  check("must", r.web_commit_signoff_required === true, "web commits must be signed off", "CONTRIBUTING.md says the web editor enforces sign-off", `gh api -X PATCH repos/${project} -F web_commit_signoff_required=true`);
  if (!p) {
    check("must", false, "main is a protected branch", "CONTRIBUTING.md: no force pushes, no deletion, conversations resolved", `GitHub → Settings → Branches → add a rule for main (see CONTRIBUTING.md, “Repository rules”)`);
  } else {
    check("must", p.enforce_admins?.enabled === true, "branch protection applies to administrators", "CONTRIBUTING.md says it is enforced for the maintainer too", `gh api -X POST repos/${project}/branches/main/protection/enforce_admins`);
    check("must", p.allow_force_pushes?.enabled === false, "force pushes to main are blocked", "CONTRIBUTING.md: history cannot be rewritten", "GitHub → Settings → Branches → main → untick “Allow force pushes”");
    check("must", p.allow_deletions?.enabled === false, "main cannot be deleted", "CONTRIBUTING.md: no branch deletion", "GitHub → Settings → Branches → main → untick “Allow deletions”");
    check("must", p.required_conversation_resolution?.enabled === true, "conversations must be resolved before a merge", "CONTRIBUTING.md says so", "GitHub → Settings → Branches → main → tick “Require conversation resolution”");
  }
  check("should", (r.topics || []).length > 0, "the repository has topics", "people find it by them", `gh repo edit ${project} --add-topic tuning --add-topic gm --add-topic datalogging`);
  return out;
}

function gh(args) {
  const r = spawnSync(process.env.GH || "gh", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}

/** Read the settings from GitHub. Returns { settings } or { unusable: reason }. */
export function fetchSettings(project = PROJECT) {
  const v = gh(["--version"]);
  if (!v.ok) return { unusable: "the GitHub CLI (gh) is not installed" };
  if (!gh(["auth", "status"]).ok) return { unusable: "gh is not signed in — run gh auth login" };
  const repo = gh(["api", `repos/${project}`]);
  if (!repo.ok) return { unusable: `cannot read ${project}: ${repo.err.trim().split("\n").pop()}` };
  const json = x => { try { return JSON.parse(x); } catch { return null; } };
  const vuln = gh(["api", `repos/${project}/private-vulnerability-reporting`]);
  const prot = gh(["api", `repos/${project}/branches/main/protection`]);
  return { settings: {
    repo: json(repo.out) || {},
    vulnerabilityReporting: vuln.ok ? json(vuln.out)?.enabled === true : false,
    protection: prot.ok ? json(prot.out) : null,
  } };
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const got = fetchSettings();
  if (got.unusable) {
    if (process.argv.includes("--offline")) { console.log(`· repository settings not checked: ${got.unusable}`); process.exit(0); }
    console.error(`✗ cannot check the settings: ${got.unusable}`); process.exit(1);
  }
  const results = evaluate(got.settings);
  let broken = 0;
  for (const c of results) {
    if (c.ok) { console.log(`✓ ${c.what}`); continue; }
    console.error(`${c.level === "must" ? "✗" : "·"} ${c.what} — ${c.promised}\n    fix: ${c.fix}`);
    if (c.level === "must") broken++;
  }
  // labels the issue forms apply must exist too; setup-labels already knows how to check
  if (!process.argv.includes("--skip-labels")) {
    const labels = spawnSync(process.execPath, [path.join(REPO, "scripts", "setup-labels.mjs"), "--check"], { encoding: "utf8" });
    if (labels.status === 0) console.log("✓ the labels the issue forms apply exist");
    else { console.error(`✗ labels the issue forms apply are missing — run: node scripts/setup-labels.mjs`); broken++; }
  }
  if (broken) { console.error(`\n${broken} promise(s) in the docs are not kept by the repository's settings.`); process.exit(1); }
  console.log("\nSettings match the docs.");
}
