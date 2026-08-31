// Poll the public repo for new submissions and push a Pushover alert.
//
//   node scripts/watch-submissions.mjs          check once, alert on anything new
//   node scripts/watch-submissions.mjs --dry-run
//
// Why a local poller when there is also a GitHub Actions alert: Actions cannot
// see pull requests from forks — secrets are withheld from them, by design —
// and a fork PR is exactly how a git-literate contributor submits. This catches
// those, and keeps working if the workflow is ever disabled.
//
// The token stays on this machine (see scripts/notify-pushover.sh); nothing
// here needs a secret in GitHub.
//
// DEBOUNCE, borrowed from deed-parse's submission_alert.sh: alert only on items
// newer than the highest number already announced, recorded in a state file.
// Without it, every poll re-announces the same open submissions — and an alert
// that cries wolf gets muted, which is the same as having no alert.
//
// The state file lives OUTSIDE the repo, like the submission store: state that
// changes every few minutes has no business dirtying a git working tree.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = process.env.TUNING_PROJECT_REPO || "ktollison/tuning-garage";
const STATE_DIR = process.env.TUNING_STATE_DIR
  || path.join(os.homedir(), ".local", "state", "tuning-garage");
const STATE_FILE = path.join(STATE_DIR, "last-announced.json");
const dryRun = process.argv.includes("--dry-run");

const notify = (title, message, url) => {
  if (dryRun) { console.log(`  [dry-run] would alert: ${title}`); return; }
  try {
    execFileSync("sh", [path.join(REPO, "scripts/notify-pushover.sh"),
      "--title", title, "--message", message, "--url", url, "--url-title", "Open on GitHub"],
      { stdio: "inherit" });
  } catch { console.error("  alert failed — see the output above"); }
};

let gh;
try { gh = (a) => execFileSync("gh", a, { encoding: "utf8" }); execFileSync("gh", ["auth", "status"], { stdio: "pipe" }); }
catch { console.error("watch-submissions: `gh` is missing or not signed in — cannot poll."); process.exit(1); }

// Issues and PRs are separate lists in the GitHub CLI, and a fork PR only ever
// appears in the second. Polling issues alone silently misses them.
const query = (kind) => JSON.parse(gh([kind, "list", "--repo", PROJECT, "--state", "open",
  "--limit", "50", "--json", "number,title,url,author,createdAt,labels"]) || "[]")
  .map(x => ({ ...x, kind }));

let items;
try { items = [...query("issue"), ...query("pr")]; }
catch (e) { console.error("watch-submissions: query failed:", (e.stderr || e.message).toString().slice(0, 200)); process.exit(1); }

// A submission is anything labelled, plus any PR touching submissions/ — a
// contributor cannot add labels to a repo they do not own, so requiring one
// would drop precisely the fork PRs this exists to catch.
const isSubmission = (x) =>
  (x.labels || []).some(l => /submission|datalog|channel-dictionary|user-math|platform/.test(l.name))
  || x.kind === "pr";

let state = { issue: 0, pr: 0 };
if (fs.existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch { console.error(`watch-submissions: ${STATE_FILE} unreadable — treating everything as seen to avoid a flood`); 
          state = items.reduce((s, x) => ({ ...s, [x.kind]: Math.max(s[x.kind] || 0, x.number) }), state); }
} else if (!fs.existsSync(STATE_DIR)) {
  console.log(`watch-submissions: creating state directory ${STATE_DIR}`);
}

const fresh = items.filter(isSubmission).filter(x => x.number > (state[x.kind] || 0));
if (!fresh.length) { console.log(`watch-submissions: nothing new (last seen issue #${state.issue}, pr #${state.pr})`); process.exit(0); }

for (const x of fresh.sort((a, b) => a.number - b.number)) {
  const who = x.author?.login || "someone";
  console.log(`  new ${x.kind} #${x.number} by ${who}: ${x.title}`);
  notify(`Tuning Garage: new ${x.kind === "pr" ? "pull request" : "submission"} #${x.number}`,
         `${x.title}\nfrom ${who}`, x.url);
}

// Advance the marks only after alerting, so a crash mid-run re-announces rather
// than silently swallowing a submission.
for (const x of fresh) state[x.kind] = Math.max(state[x.kind] || 0, x.number);
if (!dryRun) {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}
console.log(`watch-submissions: ${fresh.length} announced; marks now issue #${state.issue}, pr #${state.pr}`);
