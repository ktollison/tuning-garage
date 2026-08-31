// The labels the issue forms depend on.
//
// A GitHub issue form can only apply a label that already exists. If it does
// not, the form still works and the issue is still created — with no label at
// all. The alert workflow filters on `submission`, so a missing label means
// every submission goes unannounced, and nothing errors. That was this
// project's live state until it was tested end to end.
//
// These assertions need no network: they check the part that can drift on its
// own — the forms asking for a label nobody has described.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/setup-labels.mjs");
const FORMS = path.join(REPO, ".github", "ISSUE_TEMPLATE");
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const run = (args = [], env = {}) => new Promise(resolve => {
  const out = [];
  const p = spawn(process.execPath, [SCRIPT, ...args],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => out.push(d));
  p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
});

console.log("— every label a form asks for is described —");
{
  // Read the forms the same way the script does, then require the script to
  // agree. If a new form adds a label and nobody describes it, this fails here
  // rather than months later when a submission arrives unlabelled.
  const wanted = new Set();
  for (const f of fs.readdirSync(FORMS).filter(f => f.endsWith(".yml") && f !== "config.yml")) {
    const m = fs.readFileSync(path.join(FORMS, f), "utf8").match(/^labels:\s*\[([^\]]*)\]/m);
    if (!m) continue;
    for (const raw of m[1].split(",")) {
      const n = raw.trim().replace(/^["']|["']$/g, "");
      if (n) wanted.add(n);
    }
  }
  t(wanted.size > 0, `the forms reference ${wanted.size} label(s)`);

  const described = fs.readFileSync(SCRIPT, "utf8");
  const undescribed = [...wanted].filter(n => !new RegExp(`["']?${n.replace(/[-]/g, "\\-")}["']?\\s*:\\s*{`).test(described));
  t(undescribed.length === 0,
    undescribed.length ? `NOT described: ${undescribed.join(", ")} — add them to DESCRIBED` : "all are described with a colour and wording");

  t(/submission/.test(described), "`submission` is described — the workflow filters on it");
}

console.log("— the alert workflow and the forms agree on the label —");
{
  const wf = fs.readFileSync(path.join(REPO, "export-overrides/.github/workflows/submission-alert.yml"), "utf8");
  const filter = /contains\(join\(github\.event\.issue\.labels\.\*\.name.*?'([a-z-]+)'\)/.exec(wf);
  t(!!filter, "the workflow filters on a label");
  const forms = fs.readdirSync(FORMS).filter(f => f.endsWith(".yml") && f !== "config.yml")
    .map(f => fs.readFileSync(path.join(FORMS, f), "utf8"));
  // Every submission form must carry the label the workflow keys on, or that
  // form's submissions are silently unalerted.
  const carries = forms.filter(x => x.includes(`"${filter[1]}"`));
  t(carries.length === forms.length,
    `all ${forms.length} forms apply "${filter[1]}" (${carries.length} do)`);
}

console.log("— a form asking for an undescribed label is an error —");
{
  // Point the script at a fixture directory containing an unknown label.
  const tmp = fs.mkdtempSync(path.join(REPO, ".label-test-"));
  try {
    fs.mkdirSync(path.join(tmp, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".github", "ISSUE_TEMPLATE", "x.yml"),
      'name: x\ndescription: x\nlabels: ["totally-unknown-label"]\nbody: []\n');
    // The script resolves FORMS relative to itself, so run a copy from the fixture.
    fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(tmp, "scripts", "setup-labels.mjs"));
    const r = await new Promise(resolve => {
      const out = [];
      const p = spawn(process.execPath, [path.join(tmp, "scripts", "setup-labels.mjs"), "--check"],
        { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => out.push(d));
      p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
    });
    t(r.code !== 0, "exits non-zero");
    t(/not described/.test(r.out), "names the problem");
    t(/totally-unknown-label/.test(r.out), "names the offending label");
    t(!/gh/.test(r.out) || !/auth/.test(r.out), "fails before needing the network — drift is caught offline");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nsetup-labels tests done");
