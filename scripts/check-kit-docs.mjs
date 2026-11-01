// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Fails when the docs have drifted from the code.
//
//   node scripts/check-kit-docs.mjs          run every check; exit 1 on findings
//   node scripts/check-kit-docs.mjs --list   say what is checked, exit 0
//
// Ported from the check_docs / check-docs gates in the author's other projects
// (travel-log, proposal-tracker, adjoiners). Deliberately mechanical: it checks
// only things with an objectively right answer, so it can be a hard CI gate
// without ever needing a judgement call. It does NOT check that prose is
// accurate — no script can. It catches the drift that is mechanically
// detectable and leaves the rest to review.
//
// It runs against the starter kit as shipped (the private CI runs it on the
// export, so a doc that points at a file the kit does not contain fails before
// release; the public repository's CI runs it too). Every check fails with
// what is wrong and where to fix it. scripts/test/check-kit-docs.test.mjs
// proves each check fails when it should.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Files the app or a user creates; docs may name them though a fresh kit has none.
export const RUNTIME = [
  "data/preferences.json", "vcm-scanner/unit-codes.json", "vcm-scanner/channel-dictionary.json",
  "vcm-scanner/index.json", "donor-files/", "logs/", "submissions/", "vehicles/",
];
// Docs whose every mention of a file name counts as "documented".
const REFERENCE_DOCS = ["README.md", "USER-GUIDE.md", "MAINTAINING.md", "CONTRIBUTING.md", "SECURITY.md",
  "SETUP-MAC.md", "SETUP-WINDOWS.md", "reference/api.md"];
const KAC = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
const ROOTS = "app|scripts|reference|templates|data|definitions|vcm-scanner|vehicles|guide|\\.github|donor-files|logs|submissions";

const semver = v => String(v).split(".").map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const slugOf = h => h.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");

function load(root) {
  const read = p => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
  const exists = p => fs.existsSync(path.join(root, p));
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      e.isDirectory() ? walk(rel, out) : out.push(rel);
    }
    return out;
  };
  const files = walk("");
  // user-owned or templated markdown is not documentation of the kit itself
  const docs = files.filter(f => f.endsWith(".md") && !/^(vehicles|templates|definitions)\//.test(f) && f !== "PROGRESSION.md");
  return { root, read, exists, files, docs };
}

const problemsOf = fn => ctx => { const out = []; fn(ctx, m => out.push(m)); return out; };

export const CHECKS = [
  { id: "version", title: "APP_VERSION is the newest CHANGELOG release, with [Unreleased] above it",
    run: problemsOf(({ read }, fail) => {
      const v = read("app/server.mjs").match(/APP_VERSION\s*=\s*"([\d.]+)"/)?.[1];
      const cl = read("CHANGELOG.md");
      const newest = cl.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
      if (!v) return fail("app/server.mjs has no APP_VERSION");
      if (v !== newest) fail(`APP_VERSION is ${v}, the newest CHANGELOG release is ${newest}`);
      const u = cl.search(/^## \[Unreleased\]/m), r = cl.search(/^## \[\d/m);
      if (u < 0) fail("CHANGELOG.md has no \"## [Unreleased]\" section");
      else if (u > r) fail("CHANGELOG.md's [Unreleased] section must come before the releases");
    }) },

  { id: "changelog", title: "CHANGELOG follows Keep a Changelog: descending releases, standard sections in order, none twice, links",
    run: problemsOf(({ read }, fail) => {
      const cl = read("CHANGELOG.md");
      const secs = cl.split(/^(?=## \[)/m).slice(1).filter(s => /^## \[\d/.test(s));
      let prev = null;
      for (const s of secs) {
        const [, v, date] = s.match(/^## \[([\d.]+)\](?: - (\S+))?/);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`release ${v} has no "- YYYY-MM-DD" date`);
        if (prev && cmp(v, prev) >= 0) fail(`release ${v} is listed after ${prev}; releases must descend`);
        prev = v;
        const heads = [...s.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
        const seen = new Set();
        for (const h of heads) {
          if (!KAC.includes(h)) fail(`release ${v} has the section "### ${h}"; use only ${KAC.join(", ")}`);
          if (seen.has(h)) fail(`release ${v} has "### ${h}" twice; merge them`);
          seen.add(h);
        }
        const order = heads.filter(h => KAC.includes(h)).map(h => KAC.indexOf(h));
        if (order.some((x, i) => i && x < order[i - 1])) fail(`release ${v}'s sections are out of order (${heads.join(", ")}); the order is ${KAC.join(", ")}`);
        const firstSection = s.search(/^### /m);
        const intro = firstSection < 0 ? s : s.slice(0, firstSection);
        if (/^- /m.test(intro)) fail(`release ${v} has bullet entries outside any section`);
      }
      if (!/^\[Unreleased\]:\s*https?:/m.test(cl)) fail("CHANGELOG.md has no [Unreleased] compare link at the bottom");
      for (const s of secs) {
        const v = s.match(/^## \[([\d.]+)\]/)[1];
        if (!new RegExp(`^\\[${v.replace(/\./g, "\\.")}\\]:\\s*https?:`, "m").test(cl)) fail(`release ${v} has no [${v}] link at the bottom`);
      }
    }) },

  { id: "guide-stamp", title: "USER-GUIDE.md says which version it was last checked against, and it is this one",
    run: problemsOf(({ read }, fail) => {
      const v = read("app/server.mjs").match(/APP_VERSION\s*=\s*"([\d.]+)"/)?.[1];
      if (!read("USER-GUIDE.md").includes(`Last checked against **v${v}**`))
        fail(`USER-GUIDE.md does not say "Last checked against **v${v}**" — read the guide against this release, then update the stamp`);
    }) },

  { id: "paths", title: "every repository path a doc names in backticks exists (runtime-created files excepted)",
    run: problemsOf(({ read, exists, docs }, fail) => {
      const RE = new RegExp("`((?:" + ROOTS + ")/[^`\\s]*|[A-Z][A-Z-]+\\.md|SETUP-WINDOWS\\.html|start-tuning\\.(?:sh|cmd))`", "g");
      for (const d of docs.filter(f => f !== "CHANGELOG.md")) for (const [, p0] of read(d).matchAll(RE)) {
        const p = p0.replace(/[.,:;]+$/, "");
        if (/[<>*{}…]/.test(p) || /\.\.\./.test(p)) continue;
        if (RUNTIME.some(r => p === r || p.startsWith(r))) continue;
        if (!exists(p) && !exists(p.replace(/\/$/, ""))) fail(`${d} names \`${p}\`, which is not in the kit`);
      }
    }) },

  { id: "commands", title: "every node/sh/bash command a doc shows runs a script that exists",
    run: problemsOf(({ read, exists, docs }, fail) => {
      for (const d of docs.filter(f => f !== "CHANGELOG.md"))
        for (const [, s] of read(d).matchAll(/(?:node|sh|bash) (?:\.\/)?((?:scripts|app)\/[\w./-]+\.(?:mjs|sh))/g))
          if (!exists(s)) fail(`${d} shows a command that runs ${s}, which is not in the kit`);
    }) },

  { id: "links", title: "relative links and #anchors between docs resolve, and none leaves the repository",
    run: problemsOf(({ read, exists, docs }, fail) => {
      for (const d of docs) {
        const dir = path.posix.dirname(d);
        for (const [, t] of read(d).matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^(https?:|mailto:)/.test(t)) continue;
          const [file, anchor] = t.split("#");
          const target = file ? path.posix.normalize(path.posix.join(dir, file)) : d;
          if (target.startsWith("..")) { fail(`${d} links to ${t}, which leaves the repository — use an absolute URL (in a template copy it would point at the user's own repo)`); continue; }
          if (!exists(target)) { fail(`${d} links to ${t}, which is not in the kit`); continue; }
          if (anchor && target.endsWith(".md") && !read(target).split("\n").some(l => /^#{1,6} /.test(l) && slugOf(l.replace(/^#+ /, "")) === anchor))
            fail(`${d} links to ${t}, but ${target} has no "#${anchor}" heading`);
        }
      }
    }) },

  { id: "documented-files", title: "every script, module and launcher is named in a reference doc",
    run: problemsOf(({ read, files }, fail) => {
      const text = REFERENCE_DOCS.map(d => { try { return read(d); } catch { return ""; } }).join("\n");
      for (const f of files.filter(f => /^(scripts\/[^/]+\.(mjs|sh|cmd)|app\/modules\/[^/]+\.mjs|start-tuning\.(sh|cmd))$/.test(f)))
        if (!text.includes(path.posix.basename(f))) fail(`${f} is not named in any of ${REFERENCE_DOCS.slice(0, 5).join(", ")}…`);
    }) },

  { id: "tabs", title: "the README's table of tabs matches the app's tabs, both ways",
    run: problemsOf(({ read }, fail) => {
      const html = read("app/public/index.html");
      const tabs = [...html.matchAll(/\["(\w+)", "([A-Z][^"]*)"\]/g)].map(m => m[2]);
      const readme = read("README.md");
      const sec = readme.split(/^#{2,3} (?:The tabs|The app)\b.*$/m)[1]?.split(/^#{1,3} /m)[0] ?? "";
      const listed = [...sec.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map(m => m[1]);
      if (!tabs.length) return fail("app/public/index.html has no TABS list the checker can read");
      for (const t of tabs) if (!listed.includes(t)) fail(`the app has a "${t}" tab that README.md's tab table does not list`);
      for (const t of listed) if (!tabs.includes(t)) fail(`README.md lists a "${t}" tab that the app does not have`);
    }) },

  { id: "api", title: "reference/api.md documents every endpoint the server answers, and none it does not",
    run: problemsOf(({ read, exists }, fail) => {
      const served = [...new Set([...read("app/server.mjs").matchAll(/pathname === "(\/api\/[\w/-]+)"/g)].map(m => m[1]))];
      if (!exists("reference/api.md")) return fail("reference/api.md does not exist");
      const doc = read("reference/api.md");
      const named = new Set([...doc.matchAll(/`(\/api\/[\w/-]+)`/g)].map(m => m[1]));
      for (const e of served) if (!named.has(e)) fail(`reference/api.md does not document ${e}`);
      for (const e of named) if (!served.includes(e)) fail(`reference/api.md documents ${e}, which the server does not answer`);
      if (!/X-Tuning-Garage/.test(doc)) fail("reference/api.md does not mention the X-Tuning-Garage header that every write needs");
    }) },

  { id: "node", title: "the minimum Node version agrees across the server, launchers, docs and CI",
    run: problemsOf(({ read, exists, docs, files }, fail) => {
      const min = Number(read("app/server.mjs").match(/const MIN_NODE = (\d+)/)?.[1]);
      if (!min) return fail("app/server.mjs has no \"const MIN_NODE = N\"");
      for (const l of ["start-tuning.sh", "start-tuning.cmd"]) {
        if (!exists(l)) continue;
        const n = Number(read(l).match(/versions\.node\.split\('\.'\)\[0\] >= (\d+)/)?.[1]);
        if (n !== min) fail(`${l} requires Node ${n || "(unreadable)"}, but MIN_NODE is ${min}`);
        const said = read(l).match(/Node\.js (\d+) or newer/)?.[1];
        if (said && Number(said) !== min) fail(`${l} tells the user Node ${said} is needed, but MIN_NODE is ${min}`);
      }
      for (const d of docs.filter(f => f !== "CHANGELOG.md"))
        read(d).split("\n").forEach((line, i) => {
          if (!/\bnode\b/i.test(line)) return;
          for (const m of line.matchAll(/\b(\d{2})(?:\+| or newer)/g))
            if (Number(m[1]) !== min) fail(`${d}:${i + 1} promises Node ${m[1]}+, but MIN_NODE is ${min}`);
        });
      for (const w of files.filter(f => /^\.github\/workflows\/ci\.ya?ml$/.test(f))) {
        const versions = [...read(w).matchAll(/node-version:\s*\[([^\]]+)\]/g)].flatMap(m => m[1].split(",").map(x => Number(x.replace(/["'\s]/g, ""))));
        if (!versions.length) fail(`${w} does not set a node-version matrix`);
        else if (Math.min(...versions) !== min) fail(`${w} tests Node ${Math.min(...versions)} at the lowest, but MIN_NODE is ${min}`);
      }
    }) },

  { id: "workflows", title: "every script a workflow runs exists",
    run: problemsOf(({ read, exists, files }, fail) => {
      for (const w of files.filter(f => /^\.github\/workflows\//.test(f)))
        for (const [, s] of read(w).matchAll(/node (scripts\/[\w./-]+\.mjs|app\/[\w./-]+\.mjs)/g))
          if (!exists(s)) fail(`${w} runs ${s}, which is not in the kit`);
    }) },
];

/** Run every check against the kit at `root`. Returns { problems: [{id, message}], checked }. */
export function checkKitDocs({ root = defaultRoot } = {}) {
  const problems = [];
  let ctx;
  // an unreadable folder must FAIL, never pass because nothing could be checked
  try { ctx = load(root); } catch (e) { return { problems: [{ id: "kit", message: `the check could not run: cannot read ${root} (${e.code || e.message})` }], checked: 0 }; }
  for (const c of CHECKS) {
    let found;
    try { found = c.run(ctx); } catch (e) { found = [`the check could not run: ${e.message}`]; }
    for (const message of found) problems.push({ id: c.id, message });
  }
  return { problems, checked: CHECKS.length };
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--list")) {
    console.log("Checks (each fails with what is wrong and where to fix it):\n");
    CHECKS.forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. ${c.title}`));
    process.exit(0);
  }
  const { problems, checked } = checkKitDocs();
  if (problems.length) {
    console.error(`✗ the docs have drifted from the code (${problems.length} finding${problems.length === 1 ? "" : "s"}):\n`);
    for (const p of problems) console.error(`  [${p.id}] ${p.message}`);
    console.error("\nFix each, or if a check is wrong, fix the check. Run with --list to see what is checked.");
    process.exit(1);
  }
  console.log(`✓ docs match the code (${checked} checks)`);
}
