// scripts/update.mjs against a real upstream: a throwaway repository with
// tagged releases, and a user repository created from one of them with NO
// shared history — exactly what "Use this template" produces.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const UPDATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "update.mjs");
const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
              GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", TUNING_GARAGE_UPSTREAM: "" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-update-"));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (dir, files) => { for (const [p, c] of Object.entries(files)) {
  const f = path.join(dir, p);
  if (c === null) { fs.rmSync(f, { force: true }); continue; }
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c);
} };
const read = (dir, p) => { try { return fs.readFileSync(path.join(dir, p), "utf8"); } catch { return null; } };
const run = (dir, ...a) => spawnSync(process.execPath, [UPDATE, "--repo", dir, "--from", U, ...a], { encoding: "utf8", env });

const PASS = 'console.log("1 suites · 1 assertions passed");\n';
const server = v => `const APP_VERSION = "${v}"; // keep in step with CHANGELOG.md\n`;
const notes = vs => "# Changelog\n\n" + vs.map(([v, n]) => `## [${v}] - 2026-10-0${v.at(-3)}\n\n- ${n}\n`).join("\n");

// ---- upstream with three releases -------------------------------------------
const U = path.join(tmp, "upstream");
fs.mkdirSync(U); git(U, "init", "-q", "-b", "main");
const release = (v, files) => { put(U, files); git(U, "add", "-A"); git(U, "commit", "-q", "-m", `Release v${v}`); git(U, "tag", `v${v}`); };
release("0.1.0", {
  "app/server.mjs": server("0.1.0"), "scripts/test.mjs": PASS,
  "README.md": "readme\nline2\nline3\n", "templates/session-log.md": "a\nb\nc\nd\ne\n",
  "docs/old.md": "old\n", "conflict.md": "one\ntwo\n", "PROGRESSION.md": "prog v1\n",
  "vehicles/example-vehicle/vehicle.md": "example v1\n", "data/user-math.json": "{}\n",
  "start-tuning.sh": "echo 1\n", "CHANGELOG.md": notes([["0.1.0", "First"]]),
});
fs.chmodSync(path.join(U, "start-tuning.sh"), 0o755); git(U, "add", "-A"); git(U, "commit", "-q", "--amend", "--no-edit"); git(U, "tag", "-f", "v0.1.0");
release("0.2.0", {
  "app/server.mjs": server("0.2.0"),
  "README.md": "readme\nline2\nline3 upstream\n", "templates/session-log.md": "a\nb\nc\nd\ne changed\n",
  "docs/old.md": null, "docs/new.md": "new\n", "conflict.md": "one upstream\ntwo\n",
  "PROGRESSION.md": "prog v2\n", "vehicles/example-vehicle/vehicle.md": "example v2\n", "data/user-math.json": "{\"v\":2}\n",
  "start-tuning.sh": "echo 2\n", "CHANGELOG.md": notes([["0.2.0", "Added the widget"], ["0.1.0", "First"]]),
});

// ---- a user repository made from v0.1.0, with no shared history ---------------
const fromTemplate = (name, tag) => {
  const W = path.join(tmp, name);
  fs.mkdirSync(W); git(W, "init", "-q", "-b", "main");
  // copy the release's files out with git alone — no sh or tar, so this runs on Windows too
  const entries = git(U, "ls-tree", "-r", tag).split("\n").filter(Boolean).map(l => { const [meta, p] = l.split("\t"); return { mode: meta.split(" ")[0], p }; });
  for (const { p } of entries) put(W, { [p]: execFileSync("git", ["-C", U, "show", `${tag}:${p}`], { env }) });
  git(W, "add", "-A");
  for (const { mode, p } of entries) if (mode === "100755") {
    try { fs.chmodSync(path.join(W, p), 0o755); } catch { /* Windows has no mode bits */ }
    git(W, "update-index", "--chmod=+x", "--", p);
  }
  git(W, "commit", "-q", "-m", "Initial commit");
  return W;
};

console.log("— a normal update —");
{
  const W = fromTemplate("user", "v0.1.0");
  put(W, { "README.md": "my readme\nline2\nline3\n", "conflict.md": "one mine\ntwo\n", "PROGRESSION.md": "my progress\n",
           "data/user-math.json": "{\"mine\":1}\n", "vehicles/my-car/vehicle.md": "my car\n" });
  git(W, "add", "-A"); git(W, "commit", "-q", "-m", "my work");
  const head0 = git(W, "rev-parse", "HEAD");

  const chk = run(W, "--check");
  t(chk.status === 0 && /0\.1\.0 → 0\.2\.0/.test(chk.stdout), "--check reports the update");
  t(/Added the widget/.test(chk.stdout) && !/First/.test(chk.stdout), "and shows only the notes newer than this copy");
  t(git(W, "rev-parse", "HEAD") === head0 && !git(W, "status", "--porcelain"), "--check changes nothing");

  const r = run(W, "--yes");
  t(r.status === 0, `update applied (exit ${r.status})${r.status ? "\n" + r.stderr : ""}`);
  t(/APP_VERSION = "0\.2\.0"/.test(read(W, "app/server.mjs")), "untouched project file replaced");
  t(read(W, "templates/session-log.md") === "a\nb\nc\nd\ne changed\n", "untouched template replaced");
  t(read(W, "README.md") === "my readme\nline2\nline3 upstream\n", "your edit and the upstream edit merged");
  t(read(W, "conflict.md") === "one mine\ntwo\n" && read(W, "conflict.md.new") === "one upstream\ntwo\n",
    "colliding edit: yours kept, the new version saved as .new");
  t(read(W, "docs/old.md") === null && read(W, "docs/new.md") === "new\n", "removed and added files follow the release");
  t(read(W, "PROGRESSION.md") === "my progress\n", "PROGRESSION.md untouched");
  t(read(W, "data/user-math.json") === "{\"mine\":1}\n", "your formulas untouched");
  t(read(W, "vehicles/example-vehicle/vehicle.md") === "example v1\n" && read(W, "vehicles/my-car/vehicle.md") === "my car\n",
    "vehicles/ untouched");
  t(/^100755/.test(git(W, "ls-files", "-s", "start-tuning.sh")), "launcher stays executable");
  t(git(W, "log", "-1", "--format=%s") === "Update Tuning Garage to 0.2.0", "committed with a clear message");
  t(git(W, "status", "--porcelain") === "?? conflict.md.new", "only the .new file is left for you to look at");
  t(!git(W, "tag"), "your own tags untouched");
  t(!git(W, "remote"), "no remote added to your repository");
  fs.rmSync(path.join(W, "conflict.md.new"));
  const again = run(W);
  t(again.status === 0 && /Up to date/.test(again.stdout), "a second run says up to date");
}

console.log("— first update from a release that predates the script —");
{
  release("0.2.1", { "app/server.mjs": server("0.2.1"), "scripts/update.mjs": "// the updater\n",
                     "CHANGELOG.md": notes([["0.2.1", "Adds the updater"], ["0.2.0", "Added the widget"], ["0.1.0", "First"]]) });
  const W = fromTemplate("bootstrap", "v0.2.0");
  put(W, { "scripts/update.mjs": "// the updater\n" });           // downloaded by hand, untracked
  const r = run(W, "--yes", "--to", "0.2.1");
  t(r.status === 0, `a hand-downloaded updater does not block the update${r.status ? "\n" + r.stderr : ""}`);
  t(/^100644|^100755/.test(git(W, "ls-files", "-s", "scripts/update.mjs")) && !git(W, "status", "--porcelain"),
    "and is committed with it");
}

console.log("— it refuses to start from a dirty tree —");
{
  const W = fromTemplate("dirty", "v0.1.0");
  put(W, { "vehicles/x.md": "unsaved\n" });
  const r = run(W, "--yes");
  t(r.status !== 0 && /uncommitted changes/.test(r.stderr), "uncommitted work: refused with the reason");
  t(/APP_VERSION = "0\.1\.0"/.test(read(W, "app/server.mjs")), "and nothing was changed");
}

console.log("— Windows line endings are not mistaken for your edits —");
{
  const W = fromTemplate("crlf", "v0.1.0");
  put(W, { "templates/session-log.md": "a\r\nb\r\nc\r\nd\r\ne\r\n" });
  git(W, "add", "-A"); git(W, "commit", "-q", "-m", "crlf checkout");
  const r = run(W, "--yes");
  t(r.status === 0 && !fs.existsSync(path.join(W, "templates/session-log.md.new")), "CRLF copy of an unchanged file is simply replaced");
}

console.log("— a release whose tests fail is rolled back —");
{
  release("0.3.0", { "app/server.mjs": server("0.3.0"), "scripts/test.mjs": "console.log('✗ broken'); process.exit(1);\n",
                     "docs/brand-new.md": "x\n", "CHANGELOG.md": notes([["0.3.0", "Broken"], ["0.2.0", "Added the widget"]]) });
  const W = fromTemplate("rollback", "v0.2.0");
  const head0 = git(W, "rev-parse", "HEAD");
  const r = run(W, "--yes");
  t(r.status !== 0 && /rolled back/.test(r.stderr), "failing tests: refused and rolled back");
  t(git(W, "rev-parse", "HEAD") === head0 && !git(W, "status", "--porcelain"), "repository exactly as it was");
  t(!fs.existsSync(path.join(W, "docs/brand-new.md")), "files the update added are gone too");
  const pinned = run(W, "--yes", "--to", "0.2.0");
  t(pinned.status === 0 && /Up to date/.test(pinned.stdout), "--to pins a release");
}

console.log("— a copy that is not a published release —");
{
  const W = fromTemplate("unpublished", "v0.1.0");
  put(W, { "app/server.mjs": server("0.1.5") });
  git(W, "add", "-A"); git(W, "commit", "-q", "-m", "hand-edited version");
  const r = spawnSync(process.execPath, [UPDATE, "--repo", W, "--from", U, "--yes", "--to", "0.2.0"], { encoding: "utf8", env });
  t(r.status === 0 && /not a published release/.test(r.stdout), "warned that differing files are treated as yours");
  t(read(W, "README.md") === "readme\nline2\nline3\n" && read(W, "README.md.new") === "readme\nline2\nline3 upstream\n",
    "differing files kept, new versions beside them");
}

console.log("— the project's own source repository is refused —");
{
  const W = fromTemplate("source", "v0.1.0");
  put(W, { "app/export-template.mjs": "// builds releases\n" });
  git(W, "add", "-A"); git(W, "commit", "-q", "-m", "source");
  const r = run(W, "--check");
  t(r.status !== 0 && /source repository/.test(r.stderr), "refuses to update the repository releases are built from");
}

fs.rmSync(tmp, { recursive: true, force: true });
