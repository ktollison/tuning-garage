// Runs every scripts/test/*.test.mjs in its own process and reports.
//   node scripts/test.mjs
//
// These are the unit tests for the analysis code — the parts where a silent
// wrong answer is worse than a crash: Gen3 checksums, unit conversion,
// air-fuel scales, XDF scaling maths, knock detection. CI runs this on every
// push; run it yourself before touching any module under app/modules/.

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "test");
const files = (await readdir(dir)).filter(f => f.endsWith(".test.mjs")).sort();

const run = file => new Promise(resolve => {
  const out = [];
  const p = spawn(process.execPath, [path.join(dir, file)], { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", d => out.push(d));
  p.stderr.on("data", d => out.push(d));
  p.on("close", code => resolve({ file, code, output: Buffer.concat(out).toString() }));
});

let failed = 0, passedAssertions = 0, failedAssertions = 0;
for (const file of files) {
  const r = await run(file);
  const pass = (r.output.match(/^✓/gm) || []).length;
  const fail = (r.output.match(/^✗/gm) || []).length;
  passedAssertions += pass; failedAssertions += fail;
  if (r.code !== 0) failed++;
  console.log(`${r.code === 0 ? "✓" : "✗"} ${file.padEnd(22)} ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
  if (r.code !== 0) console.log(r.output.split("\n").filter(l => l.startsWith("✗") || /Error/.test(l)).map(l => "    " + l).join("\n"));
}

console.log(`\n${files.length} suites · ${passedAssertions} assertions passed${failedAssertions ? ` · ${failedAssertions} FAILED` : ""}`);
if (failed) { console.error(`${failed} suite(s) failed`); process.exit(1); }
