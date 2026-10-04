// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Update your copy of Tuning Garage to the newest release.
//
//   node scripts/update.mjs            show what would change, then ask
//   node scripts/update.mjs --check    only say whether an update exists
//   node scripts/update.mjs --yes      apply without asking
//   node scripts/update.mjs --to 0.44.0   a specific release instead of the newest
//
// Why this exists: "Use this template" gives you a repository with NO shared
// history with the project, so `git pull` can never bring you a new release.
// This script does it instead, file by file:
//
//   - a project file you never changed is replaced with the new version
//   - a project file you DID change is merged with the new version; if the
//     two edits collide, yours is kept and the new one is saved beside it as
//     <file>.new for you to compare
//   - your data is never touched: vehicles/, PROGRESSION.md, your formulas,
//     preferences, scanner configs and definitions
//
// Then it runs the tests and commits. If the tests fail, every change is
// rolled back and nothing is committed. It needs git and Node 18+, nothing else,
// and it talks to GitHub only when you run it.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "https://github.com/ktollison/tuning-garage.git";
const NS = "refs/tuning-garage/tags";        // fetched here, so your own tags and remotes are untouched

// Yours. An update never writes, merges or deletes anything under these.
export const USER_OWNED = [
  /^vehicles\//,
  /^PROGRESSION\.md$/,
  /^data\/user-math\.json$/,
  /^data\/preferences\.json$/,
  /^vcm-scanner\/(channels|charts|graphs|layouts|math)\//,
  /^vcm-scanner\/(index|channel-dictionary|unit-codes)\.json$/,
  /^definitions\/(?!README\.md$)/,
  /^logs\//,
  /^submissions\//,
];
export const isUserOwned = p => USER_OWNED.some(re => re.test(p));

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const REPO = path.resolve(opt("--repo") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const FROM = opt("--from") || process.env.TUNING_GARAGE_UPSTREAM || UPSTREAM;

const git = (a, o = {}) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...o });
const gitBuf = a => execFileSync("git", ["-C", REPO, ...a], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
const die = (msg, code = 1) => { console.error(`\n✗ ${msg}`); process.exit(code); };

const semver = v => v.replace(/^v/, "").split(".").map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// ---- preconditions -----------------------------------------------------------
try { git(["rev-parse", "--is-inside-work-tree"]); }
catch { die(`${REPO} is not a git repository. Run this from your Tuning folder.`); }

if (fs.existsSync(path.join(REPO, "app", "export-template.mjs")))
  die("This is the project's source repository, which releases are built FROM — there is nothing to update it to.");

const server = path.join(REPO, "app", "server.mjs");
const current = fs.existsSync(server) && fs.readFileSync(server, "utf8").match(/APP_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/)?.[1];
if (!current) die("Could not read APP_VERSION from app/server.mjs — is this a Tuning Garage repository?");

// ---- what is available --------------------------------------------------------
console.log(`Tuning Garage ${current} — checking ${FROM.replace(/\.git$/, "")} for releases…`);
try {
  git(["fetch", "--quiet", "--no-tags", "--force", FROM, `+refs/tags/v*:${NS}/v*`]);
} catch (e) {
  die(`Could not reach the project to check for releases.\n  ${String(e.stderr || e.message).trim().split("\n").pop()}\n  Check your internet connection, then run this again.`);
}
const tags = git(["for-each-ref", "--format=%(refname:strip=3)", NS]).split("\n")
  .filter(t => /^v\d+\.\d+\.\d+$/.test(t)).sort(cmp);
if (!tags.length) die("No releases found upstream.");

const wanted = opt("--to");
const target = wanted ? `v${wanted.replace(/^v/, "")}` : tags[tags.length - 1];
if (!tags.includes(target)) die(`Release ${target} does not exist. Available: ${tags.slice(-5).join(", ")}`);
if (cmp(target, current) <= 0) {
  console.log(`✓ Up to date — ${current} is the newest release${wanted ? " you asked for" : ""}.`);
  process.exit(0);
}
const T = `${NS}/${target}`;
const base = tags.includes(`v${current}`) ? `${NS}/v${current}` : null;

// ---- release notes -----------------------------------------------------------
function notesBetween() {
  let text;
  try { text = git(["show", `${T}:CHANGELOG.md`]); } catch { return null; }
  const out = [];
  let keep = false;
  for (const line of text.split("\n")) {
    const h = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (h) keep = cmp(h[1], current) > 0 && cmp(h[1], target) <= 0;
    else if (/^\[.+\]:\s*http/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.join("\n").trim() || null;
}

console.log(`\nUpdate available: ${current} → ${target.slice(1)}\n`);
const notes = notesBetween();
if (notes) console.log(notes.split("\n").map(l => "  " + l).join("\n") + "\n");
else console.log("  (no release notes found — see the project's CHANGELOG.md)\n");
if (flag("--check")) process.exit(0);

// ---- plan --------------------------------------------------------------------
// The one exception: scripts/update.mjs itself, freshly downloaded by someone
// whose release predates it — the update then commits it like any other file.
const SELF = "scripts/update.mjs";
const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).filter(l => l !== `?? ${SELF}`);
if (dirty.length)
  die("You have uncommitted changes. Commit & push them first (the app's Commit & push button), then run this again — an update must start from a clean slate so it can be undone cleanly.");

const show = (ref, p) => { try { return gitBuf(["show", `${ref}:${p}`]); } catch { return null; } };
const modeOf = (ref, p) => (git(["ls-tree", ref, "--", p]).split(/\s+/)[0] || "");
const local = p => { const f = path.join(REPO, p); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
// line endings must not make an untouched file look edited (Windows autocrlf)
const norm = b => (b === null ? null : b.toString("utf8").replace(/\r\n/g, "\n"));
const same = (a, b) => a !== null && b !== null && (Buffer.compare(a, b) === 0 || norm(a) === norm(b));
const isText = b => b === null || !b.subarray(0, 8000).includes(0);

const changed = base
  ? git(["diff", "--name-status", "--no-renames", base, T]).split("\n").filter(Boolean).map(l => {
      const [s, ...rest] = l.split("\t"); return { status: s[0], path: rest.join("\t") }; })
  : git(["ls-tree", "-r", "--name-only", T]).split("\n").filter(Boolean).map(p => ({ status: "A", path: p }));

const plan = { replace: [], add: [], remove: [], merge: [], conflict: [], kept: [], yours: [] };
for (const { status, path: p } of changed) {
  if (isUserOwned(p)) { plan.yours.push(p); continue; }
  const L = local(p), B = base ? show(base, p) : null, N = status === "D" ? null : show(T, p);
  if (status === "D") {
    if (L === null) continue;
    if (B && same(L, B)) plan.remove.push(p); else plan.kept.push({ p, why: "removed from the project, but you changed it — left in place" });
    continue;
  }
  if (L === null) {
    if (status === "A" || !base) plan.add.push({ p, N });
    else plan.kept.push({ p, why: "you deleted it — not restored" });
    continue;
  }
  if (same(L, N)) continue;                                   // already identical
  if (B && same(L, B)) { plan.replace.push({ p, N }); continue; }
  // you changed it (or there is no base to tell): try a three-way merge
  if (B && isText(L) && isText(B) && isText(N)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-merge-"));
    const [fl, fb, fn] = ["local", "base", "new"].map(n => path.join(dir, n));
    fs.writeFileSync(fl, norm(L)); fs.writeFileSync(fb, norm(B)); fs.writeFileSync(fn, norm(N));
    const r = spawnSync("git", ["merge-file", "-p", fl, fb, fn], { maxBuffer: 1 << 28 });
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.status === 0) { plan.merge.push({ p, N: r.stdout }); continue; }
  }
  plan.conflict.push({ p, N });
}

const list = (title, items, fmt = x => x.p ?? x) => {
  if (!items.length) return;
  console.log(`${title} (${items.length}):`);
  for (const x of items.slice(0, 40)) console.log("  " + fmt(x));
  if (items.length > 40) console.log(`  … and ${items.length - 40} more`);
};
list("Updated", plan.replace);
list("Added", plan.add);
list("Removed (no longer part of the project)", plan.remove);
list("Merged with your own edits", plan.merge);
list("Your edits collide with the update — yours kept, new version saved as <file>.new", plan.conflict);
list("Left alone", plan.kept, x => `${x.p} — ${x.why}`);
if (plan.yours.length) console.log(`Your data: ${plan.yours.length} upstream change(s) under your own folders were ignored, as always.`);
if (!base) console.log(`\nNote: ${current} is not a published release, so files that differ could not be told apart from your own edits — they are treated as yours.`);

const total = plan.replace.length + plan.add.length + plan.remove.length + plan.merge.length + plan.conflict.length;
if (!total) { console.log("\nNothing to change — your files already match."); process.exit(0); }

async function confirm() {
  if (flag("--yes")) return true;
  if (!process.stdin.isTTY) die("Not running in a terminal, so I cannot ask. Re-run with --yes to apply.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`\nApply the update to ${target.slice(1)}? [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}
if (!(await confirm())) { console.log("Nothing changed."); process.exit(0); }

// ---- apply -------------------------------------------------------------------
const written = [];
const write = (p, buf) => { const f = path.join(REPO, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); written.push(p); };
for (const { p, N } of [...plan.replace, ...plan.add, ...plan.merge]) write(p, N);
for (const p of plan.remove) { fs.rmSync(path.join(REPO, p), { force: true }); written.push(p); }
const sidecars = [];
for (const { p, N } of plan.conflict) { const f = path.join(REPO, p + ".new"); fs.writeFileSync(f, N); sidecars.push(p + ".new"); }

const rollback = why => {
  git(["reset", "--hard", "--quiet", "HEAD"]);
  for (const p of [...plan.add.map(x => x.p), ...sidecars]) fs.rmSync(path.join(REPO, p), { force: true });
  die(`${why}\n  Every change has been rolled back; your repository is exactly as it was.`);
};

if (!written.includes(SELF) && git(["status", "--porcelain", "--", SELF]).startsWith("??") && show(T, SELF)) written.push(SELF);
try {
  git(["add", "-A", "--", ...written]);
  for (const p of written) {
    if (!fs.existsSync(path.join(REPO, p))) continue;
    const m = modeOf(T, p);
    if (m === "100755") { git(["update-index", "--chmod=+x", "--", p]); try { fs.chmodSync(path.join(REPO, p), 0o755); } catch {} }
  }
} catch (e) { rollback(`Could not stage the update: ${String(e.stderr || e.message).trim()}`); }

console.log("\nRunning the tests on the updated code…");
const tests = path.join(REPO, "scripts", "test.mjs");
if (fs.existsSync(tests)) {
  const r = spawnSync(process.execPath, [tests], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) {
    console.error((r.stdout || "").split("\n").filter(l => /✗|FAILED|Error/.test(l)).slice(0, 15).join("\n"));
    rollback("The tests failed on the updated code, so the update was not applied. Please report this on the project's Discussions page.");
  }
  console.log("  " + ((r.stdout || "").trim().split("\n").pop() || "passed"));
}

try {
  git(["commit", "--quiet", "-m", `Update Tuning Garage to ${target.slice(1)}`, "-m", `From ${current}. Applied by scripts/update.mjs.`]);
} catch (e) {
  const msg = String(e.stderr || e.message);
  rollback(/identity|user\.email|user\.name/i.test(msg)
    ? "git does not know who you are, so it cannot commit. Set user.name and user.email (see the setup guide, step 3), then run this again."
    : `The commit failed: ${msg.trim()}`);
}

console.log(`\n✓ Updated to ${target.slice(1)} and committed.`);
if (sidecars.length) {
  console.log(`\n${sidecars.length} file(s) need you to look at them — your version is in place, the new one is beside it:`);
  for (const s of sidecars) console.log(`  ${s}`);
  console.log("Compare each pair, keep what you want, delete the .new file, then Commit & push.");
}
console.log(`
Next:
  1. Push it — the app's Commit & push button, or: git push
  2. Restart the app — the launcher (start-tuning) does this by itself when the version changes
  3. Your other machines get the update the normal way: the launcher pulls it, or press Sync`);
