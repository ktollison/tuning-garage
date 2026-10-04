// The server, end to end: boots app/server.mjs against a throwaway repository
// and checks the findings of the October 2026 code audit stay fixed.
//
// Every case here was a real defect. The first two were proven against the
// running app before they were fixed: a request carrying a foreign Origin
// wrote a file outside the repository through the upload endpoint.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "tg-server-"));
const REPO = path.join(TMP, "repo"), OUTSIDE = path.join(TMP, "outside");
const crlf = s => s.replace(/\n/g, "\r\n");      // written the way a Windows checkout would
const put = (rel, text) => { const f = path.join(REPO, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
fs.mkdirSync(OUTSIDE, { recursive: true });

put("PROGRESSION.md", crlf(`# Tracker

## Stage 1 — Foundations

| Concept | Status | Notes / sessions |
|---------|--------|------------------|
| Reading the PCM | 🟢 | done |
| Flashing basics | 🟡 | |

## Milestones

- [x] Stock read archived
- [ ] First successful flash
`));
put("templates/pre-flash-checklist.md", fs.readFileSync(path.join(ROOT, "templates/pre-flash-checklist.md"), "utf8"));
put("data/user-math.json", JSON.stringify({ parameters: [
  { id: "afr-from-lambda", name: "AFR from lambda", category: "Fueling", expression: "[1]*14.7", status: "unverified",
    platform: "gm-gen5", sample: true, assumes: { requires: "lambda in λ" } }] }, null, 2));
put("vehicles/test-car/vehicle.md", crlf(`# Test car

| Field | Value |
|-------|-------|
| VIN | |

## Current state

- Current tune revision: v001 (flashed 2026-01-02)
- Last flashed: 2026-01-02
`));
put("vehicles/test-car/flash-log.md", crlf(`# Flash log

| Date | Revision | Adapter | Notes |
|---|---|---|---|
| 2026-01-02 | v001 | MPVI3 | — |
`));
put("vehicles/test-car/tunes/CHANGELOG.md", "# Tune Changelog\n\n---\n");
put("vehicles/test-car/tunes/v001_2026-01-01_base.bin", "x");
put("vehicles/test-car/datalogs/.gitkeep", "");
put("vehicles/test-car/sessions/.gitkeep", "");
put("vehicles/no-bullets/vehicle.md", "# No bullets\n");
put("vehicles/no-bullets/tunes/CHANGELOG.md", "---\n");
// an HP Tuners export: preamble, sparse rows, a comma inside a channel name
put("vehicles/test-car/datalogs/2026-01-03_v001_cruise.csv",
`HP Tuners CSV Log File
Version: 1.0

[Channel Information]
0,12,40001
Offset,Engine RPM (SAE),MPVI2.1 -> AEM 30-(03x0,2340,5130)
s,rpm,

[Channel Data]
0.0,800,14.7
0.5,,14.6
1.0,850,
2.5,900,14.5
16777.0,9999,
`);

const port = await new Promise(res => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(ROOT, "app/server.mjs")],
  { env: { ...process.env, TUNING_REPO: REPO, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/state`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

const W = { "X-Tuning-Garage": "1" };
const post = (p, body, headers = W) => fetch(base + p, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const rawRequest = (headers) => new Promise(resolve => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`GET /api/file?path=PROGRESSION.md HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`));
  let d = ""; s.on("data", c => d += c); s.on("end", () => resolve(d.split(" ")[1]));
});

try {
  console.log("— only the app itself may talk to the server —");
  {
    const evil = await post("/api/upload?vehicle=test-car&kind=datalog&name=x.csv&desc=log", "x",
      { ...W, Origin: "https://evil.example" });
    t(evil.status === 403, `a cross-origin write is refused (${evil.status})`);
    const bare = await post("/api/preferences", { units: {} }, {});
    t(bare.status === 403, `a write without the app's header is refused (${bare.status})`);
    t(await rawRequest("Host: evil.example:" + port + "\r\n") === "403", "a request for another host name (DNS rebinding) is refused, reads included");
    t(await rawRequest(`Host: localhost:${port}\r\n`) === "200", "localhost itself still works");
  }

  console.log("— names that become file paths cannot climb out —");
  {
    const esc = path.relative(path.join(REPO, "vehicles/test-car/datalogs"), path.join(OUTSIDE, "escaped"));
    const r = await post(`/api/upload?vehicle=test-car&kind=datalog&name=x.csv&desc=log&date=${encodeURIComponent(esc)}`, "proof");
    t(r.status === 400, `a crafted upload date is rejected (${r.status})`);
    t(fs.readdirSync(OUTSIDE).length === 0, "and nothing was written outside the repository");
    const rev = await post(`/api/upload?vehicle=test-car&kind=datalog&name=x.csv&desc=log&rev=${encodeURIComponent("../../../x")}`, "proof");
    t(rev.status === 400, `a crafted datalog revision is rejected (${rev.status})`);
    const ses = await post("/api/session", { vehicle: "test-car", date: "../../../../escaped", goal: "x" });
    t(ses.status === 400, `a crafted session date is rejected (${ses.status})`);
    const ok = await post("/api/upload?vehicle=test-car&kind=datalog&name=good.csv&desc=fine&rev=v001&date=2026-01-04", "a,b\n1,2\n");
    t(ok.status === 200 && fs.existsSync(path.join(REPO, "vehicles/test-car/datalogs/2026-01-04_v001_fine.csv")), "a normal upload still lands where it should");
  }

  console.log("— a CRLF checkout parses like any other —");
  {
    const s = await (await fetch(`${base}/api/state`)).json();
    t(s.progression.stages[0]?.concepts.length === 2, `progression rows parsed (${s.progression.stages[0]?.concepts.length})`);
    t(s.progression.milestones.length === 2, "milestones parsed");
    t(s.vehicles.find(v => v.id === "test-car").currentRevision.startsWith("v001"), "current revision read from vehicle.md");
    const tl = await (await fetch(`${base}/api/timeline?vehicle=test-car`)).json();
    t(tl.insights.flashedRevs.includes("v001") && !tl.insights.revisionsNeverFlashed.includes("v001"),
      "the flash log is read — v001 is not reported as never flashed");
  }

  console.log("— editing a formula keeps what the form does not show —");
  {
    await post("/api/usermath", { id: "afr-from-lambda", name: "AFR from lambda", category: "Fueling",
      expression: "[1]*14.7", status: "verified", units: "AFR", inputs: "", notes: "edited", source: "" });
    const p = (await (await fetch(`${base}/api/state`)).json()).userMath.parameters.find(x => x.id === "afr-from-lambda");
    t(p.status === "verified" && p.notes === "edited", "the edit applied");
    t(p.platform === "gm-gen5" && p.sample === true && p.assumes?.requires, "platform, sample and assumes survived it");
  }

  console.log("— the quick summary reads an HP Tuners export —");
  {
    const r = await (await fetch(`${base}/api/logsummary?path=${encodeURIComponent("vehicles/test-car/datalogs/2026-01-03_v001_cruise.csv")}`)).json();
    const names = r.channels.map(c => c.name);
    t(r.format === "hptuners" && names.some(n => n.startsWith("Engine RPM")) && names.some(n => n.includes("AEM 30-(03x0,2340,5130)")),
      `real channel names, the comma-bearing one intact (${names.join(" | ")})`);
    const rpm = r.channels.find(c => c.name.startsWith("Engine RPM"));
    t(rpm.min === 800 && rpm.max === 900 && rpm.samples === 3, `RPM 800–900 over 3 samples (${rpm.min}–${rpm.max}, ${rpm.samples})`);
    t(r.durationSec === 2.5 && r.corruptTimestamps === 1, `a corrupt timestamp is dropped, not taken as the duration (${r.durationSec} s, ${r.corruptTimestamps} dropped)`);
  }

  console.log("— a flash record is validated before anything is written —");
  {
    const sections = (await (await fetch(`${base}/api/checklist`)).json()).sections;
    const checked = sections.flatMap(s => s.items.map(i => i.id));
    const bad = await post("/api/flashed", { vehicle: "test-car", rev: "v001 | x", checked });
    t(bad.status === 400, `a revision that would break the flash-log table is rejected (${bad.status})`);
    const half = await post("/api/flashed", { vehicle: "no-bullets", rev: "v001", checked });
    t(half.status === 400 && !fs.existsSync(path.join(REPO, "vehicles/no-bullets/flash-log.md")),
      "a profile missing its bullets is refused before the flash log is touched");
    const good = await post("/api/flashed", { vehicle: "test-car", rev: "v002", checked, date: "2026-01-05", adapter: "MPVI3" });
    const log = fs.readFileSync(path.join(REPO, "vehicles/test-car/flash-log.md"), "utf8");
    t(good.status === 200 && /\| 2026-01-05 \| v002 \| MPVI3 \| — \|/.test(log), "a valid flash is recorded");
    t(/Last flashed: 2026-01-05/.test(fs.readFileSync(path.join(REPO, "vehicles/test-car/vehicle.md"), "utf8")), "and the profile updated with it");
  }

  console.log("— still up after all of the above —");
  t((await fetch(`${base}/api/state`)).status === 200, "the server survived every refused and malformed request");
} finally {
  server.kill();
  await fsp.rm(TMP, { recursive: true, force: true });
}
