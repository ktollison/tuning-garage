// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Sharing a datalog with the project — the parts the app and the CLI share.
//
// Two ways to post, because a GitHub issue cannot take a file attachment from
// the API or the CLI:
//   - with the GitHub CLI signed in: the scrubbed log goes up as a SECRET gist
//     (unlisted — anyone with the link can read it, nobody can find it) and the
//     issue links to it. Nothing left for the contributor to do.
//   - without it: GitHub's own issue form opens with every text field filled
//     in, and the contributor drags the scrubbed file into the upload box.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const PROJECT = process.env.TUNING_PROJECT_REPO || "ktollison/tuning-garage";
export const STORE = process.env.TUNING_SUBMISSIONS_DIR
  || path.join(os.homedir(), ".local", "share", "tuning-garage", "submissions");

/** The profile fields a stranger may see. Never the VIN. */
export function vehicleFields(profileText = "") {
  const row = label => (String(profileText).match(new RegExp(`^\\| ${label} \\| (.*?) \\|$`, "m"))?.[1] || "").trim();
  // Only the first clause of a field: a profile cell can carry private notes
  // after a dash ("P01 — donor module, re-serialized…"), which must not travel.
  const clean = v => {
    if (!v || /fill in|optional|^—$|^-$/i.test(v)) return "";
    return v.replace(/\*\*/g, "").split(/\s+[—–]\s+|\s+-\s+/)[0].replace(/\s*\([^)]*\)\s*$/, "").trim();
  };
  const pcm = clean(row("PCM")) || clean(row("PCM / ECU"));
  const os_ = clean(row("OS ID"));
  return {
    platform: [pcm, os_ && `OS ${os_.replace(/[^\d].*$/, "")}`].filter(Boolean).join(", "),
    vehicle: [clean(row("Year / Model")), clean(row("Engine")), clean(row("Transmission"))].filter(Boolean).join(", "),
  };
}

export function buildIssue(r, { file, platform = "", vehicle = "", what = "" } = {}) {
  const channels = Object.keys(r.channels || {});
  const title = `[log] ${file} — ${r.format}, ${channels.length} channels`;
  const body = [
    "### What is in this log",
    "",
    what || "<!-- what you were doing, and what looks wrong -->",
    "",
    "### What the analyser made of it",
    "",
    "| | |",
    "|---|---|",
    platform ? `| Platform | ${platform} |` : "",
    vehicle ? `| Vehicle | ${vehicle} |` : "",
    `| Format | \`${r.format}\` |`,
    `| Rows | ${r.rowCount}${r.keptCount != null ? ` (${r.keptCount} usable)` : ""} |`,
    r.resampled ? `| Sessions | ${r.resampled.sessions} over ${r.resampled.durationSec} s |` : "",
    `| Channels detected | ${channels.length} |`,
    r.wideband?.present ? `| Wideband | \`${r.wideband.channel}\` read as ${r.wideband.scale.scale} |` : "| Wideband | none found |",
    "",
    `**Channels:** ${channels.map(c => `\`${c}\``).join(", ") || "_none_"}`,
    "",
    r.missingChannels?.length ? `**Not found:** ${r.missingChannels.map(c => `\`${c}\``).join(", ")}\n` : "",
    (r.silentChannels || []).length ? "**Logged but empty:**\n" + r.silentChannels.map(s => `- \`${s.column}\``).join("\n") + "\n" : "",
    (r.warnings || []).length ? "<details><summary>Warnings</summary>\n\n" + r.warnings.map(w => `- ${w}`).join("\n") + "\n\n</details>\n" : "",
    "---",
    "_Prepared by Tuning Garage. The log was scrubbed before it left the contributor's machine._",
  ].filter(Boolean).join("\n");
  return { title, body };
}

/** GitHub's issue form, pre-filled. The upload field cannot be pre-filled. */
export function prefillUrl(project, { title, platform, vehicle, wideband, what }) {
  const q = new URLSearchParams({ template: "log-submission.yml", title: title || "[log] " });
  for (const [k, v] of Object.entries({ platform, vehicle, wideband, what })) if (v) q.set(k, String(v).slice(0, 1500));
  return `https://github.com/${project}/issues/new?${q}`;
}

/** Is the GitHub CLI installed AND signed in? */
export function ghReady(gh = "gh") {
  if (spawnSync(gh, ["--version"], { stdio: "ignore" }).status !== 0)
    return { ready: false, why: "the GitHub CLI (gh) was not found — install it, or if it is installed and the app runs as the macOS agent, re-run: sh scripts/autostart-macos.sh install" };
  if (spawnSync(gh, ["auth", "status"], { stdio: "ignore" }).status !== 0) return { ready: false, why: "gh is installed but not signed in — run gh auth login" };
  return { ready: true };
}

/** Secret gist with the scrubbed log, then the issue linking to it. */
export function postWithGh({ csvPath, title, body, project = PROJECT, gh = "gh" }) {
  const run = args => spawnSync(gh, args, { encoding: "utf8" });
  const gist = run(["gist", "create", "--desc", `Tuning Garage datalog — ${path.basename(csvPath)}`, csvPath]);
  const gistUrl = (gist.stdout || "").trim().split(/\s+/).find(s => /^https:\/\/gist\.github\.com\//.test(s));
  if (gist.status !== 0 || !gistUrl) return { ok: false, error: `could not create the gist: ${(gist.stderr || gist.stdout || "").trim().split("\n").pop()}` };
  const fullBody = `**The scrubbed log:** ${gistUrl}\n\n${body}`;
  const issue = run(["issue", "create", "--repo", project, "--title", title,
    "--label", "submission", "--label", "datalog", "--body", fullBody]);
  const issueUrl = (issue.stdout || "").trim().split(/\s+/).find(s => /^https:\/\/github\.com\/.+\/issues\/\d+/.test(s));
  if (issue.status !== 0 || !issueUrl)
    return { ok: false, gistUrl, error: `the gist was created (${gistUrl}) but the issue was not: ${(issue.stderr || issue.stdout || "").trim().split("\n").pop()}` };
  return { ok: true, gistUrl, issueUrl };
}
