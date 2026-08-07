// The scrubber is the thing standing between a contributor and publishing
// their VIN. Anything attached to a public issue is public immediately and
// cannot be truly withdrawn, so these assertions matter more than most.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../app/modules/loganalysis.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "scrub-test-"));
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const scrub = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath,
      [path.join(REPO, "scripts/scrub-log.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
};

const log = (rows, names = "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE)",
             units = "s,rpm,%", notes = "") => `HP Tuners CSV Log File
Version: 1.0

[Log Information]
Creation Time: 7/7/2026 10:13:47 PM
Notes: ${notes}

[Channel Information]
${names.split(",").map((_, i) => i).join(",")}
${names}
${units}

[Channel Data]
${rows.join("\n")}
`;
const write = (name, body) => { const p = path.join(TMP, name); fs.writeFileSync(p, body); return p; };

console.log("— a clean log passes —");
{
  const f = write("clean.csv", log(["0.1,800,-5", "0.2,810,-6"]));
  const r = scrub(["--check", f]);
  t(r.code === 0, "exit 0");
  t(/nothing to redact/.test(r.out), "reports nothing to redact");
}

console.log("— VINs are caught wherever they appear —");
for (const [where, body] of [
  ["the preamble", log(["0.1,800,-5"], undefined, undefined, "car 1ZZTEST99Z1234567")],
  ["a channel name", log(["0.1,800,-5,1"], "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),VIN 1ZZTEST99Z1234567", "s,rpm,%,")],
  ["the data rows", log(["0.1,800,-5", "1ZZTEST99Z1234567,810,-6"])],
]) {
  const f = write(`vin-${where.replace(/\W/g, "")}.csv`, body);
  const r = scrub(["--check", f]);
  t(r.code === 1, `caught in ${where}`);
}

console.log("— VIN matching does not fire on innocent text —");
for (const [what, body] of [
  ["a 17-char word", log(["0.1,800,-5"], undefined, undefined, "AAAAAAAAAAAAAAAAA")],
  ["a 16-char token", log(["0.1,800,-5"], undefined, undefined, "1ZZTEST99Z123456")],
  ["a long number", log(["0.1,800,-5"], undefined, undefined, "12345678901234567890")],
]) {
  const f = write(`ok-${what.replace(/\W/g, "")}.csv`, body);
  // notes are always cleared, so check the VIN specifically rather than exit code
  const r = scrub([f, "-o", path.join(TMP, "out.csv")]);
  t(!/VIN-shaped/.test(r.out), `no false positive on ${what}`);
}

console.log("— the Notes field is cleared —");
{
  const f = write("notes.csv", log(["0.1,800,-5"], undefined, undefined, "garage at 123 Main St"));
  const r = scrub([f, "-o", path.join(TMP, "notes-out.csv")]);
  t(/Notes field cleared/.test(r.out), "reported");
  const after = fs.readFileSync(path.join(TMP, "notes-out.csv"), "utf8");
  t(/^Notes:$/m.test(after), "the key stays, the value goes");
  t(!/Main St/.test(after), "the content is gone");
}

console.log("— locating channels are removed entirely —");
{
  const f = write("gps.csv", log(["0.1,800,-5,42.3601,-71.0589"],
    "Offset,Engine RPM (SAE),Short Term Fuel Trim Bank 1 (SAE),GPS Latitude,GPS Longitude", "s,rpm,%,deg,deg"));
  const out = path.join(TMP, "gps-out.csv");
  const r = scrub([f, "-o", out]);
  t(/locating channel/.test(r.out), "reported");
  const after = fs.readFileSync(out, "utf8");
  t(!/42\.3601|-71\.0589/.test(after), "coordinates gone from the data");
  t(!/GPS/.test(after), "columns gone from the header");
  t(scrub(["--check", out]).code === 0, "the scrubbed file passes --check");
}

console.log("— scrubbing does not change the analysis —");
{
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(`${(i * 0.1).toFixed(1)},${1500 + (i % 3)},-5`);
  const dirty = write("round.csv", log(rows, undefined, undefined, "1ZZTEST99Z1234567 my car"));
  const out = path.join(TMP, "round-out.csv");
  scrub([dirty, "-o", out]);
  const a = analyze(fs.readFileSync(dirty, "utf8"));
  const b = analyze(fs.readFileSync(out, "utf8"));
  t(a.rowCount === b.rowCount && a.keptCount === b.keptCount,
    `row and kept counts identical (${a.rowCount}/${a.keptCount})`);
  t(JSON.stringify(a.channels) === JSON.stringify(b.channels), "same channels detected");
}

console.log("— --check never writes —");
{
  const f = write("nowrite.csv", log(["0.1,800,-5"], undefined, undefined, "1ZZTEST99Z1234567"));
  const before = fs.readdirSync(TMP).length;
  scrub(["--check", f]);
  t(fs.readdirSync(TMP).length === before, "no output file created in --check mode");
  t(/1ZZTEST99Z1234567/.test(fs.readFileSync(f, "utf8")), "the input is left untouched");
}

await fsp.rm(TMP, { recursive: true, force: true });
console.log("\nscrub-log tests done");
