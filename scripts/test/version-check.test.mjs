// The staleness check the launcher relies on.
//
// Written after the app served v0.31.0 for three releases: the launchd agent
// outlives every pull, so the process keeps running last week's build while
// `status` cheerfully reports the agent loaded and the port answering. Both
// were true. Neither was the question worth asking.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/version-check.mjs");
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const PORT = 4788;
const onDisk = (await fsp.readFile(path.join(REPO, "app/server.mjs"), "utf8"))
  .match(/APP_VERSION\s*=\s*"([^"]+)"/)[1];

// spawn, not execFileSync: the stand-in servers below live in THIS process, and
// a synchronous child blocks this event loop — the server would never accept
// the connection and every case would look like "nothing is listening".
const check = (...args) => new Promise(resolve => {
  const out = [];
  const p = spawn(process.execPath, [SCRIPT, ...args],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT) } });
  p.stdout.on("data", d => out.push(d));
  p.stderr.on("data", d => out.push(d));
  p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
});

// A stand-in for the app: only /api/state matters to the check.
const serve = (handler) => new Promise(resolve => {
  const s = http.createServer(handler);
  s.listen(PORT, "127.0.0.1", () => resolve(s));
});
const close = s => new Promise(r => s.close(r));

console.log("— nothing listening —");
{
  const r = await check();
  t(r.code === 2, `exit 2 (got ${r.code})`);
  t(/Nothing serving/.test(r.out), "says nothing is serving");
  t(r.out.includes(onDisk), "still reports the on-disk version");
}

console.log("— running the same version as the disk —");
{
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: onDisk }));
  });
  const r = await check();
  await close(s);
  t(r.code === 0, `exit 0 (got ${r.code})`);
  t(/current/.test(r.out), "reports current");
}

console.log("— running an older build than the disk —");
{
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "0.0.1-stale" }));
  });
  const r = await check();
  await close(s);
  t(r.code === 1, `exit 1 (got ${r.code})`);
  t(/STALE/.test(r.out), "says STALE");
  t(r.out.includes("0.0.1-stale") && r.out.includes(onDisk), "names both versions");
}

console.log("— the port belongs to something else —");
{
  // The distinction that matters: a 404 is NOT "nothing is listening". Reporting
  // it as such sent the launcher down the start branch, where it tried to bind
  // a port already in use.
  const s = await serve((req, res) => { res.statusCode = 404; res.end("nope"); });
  const r = await check();
  await close(s);
  t(r.code === 3, `exit 3, not 2 (got ${r.code})`);
  t(/not this app/.test(r.out), "says it is not this app");
}
{
  const s = await serve((req, res) => { res.end("<html>hello</html>"); });
  const r = await check();
  await close(s);
  t(r.code === 3, `200 with non-JSON is also 'not this app' (got ${r.code})`);
}
{
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ something: "else" }));   // JSON, but no version
  });
  const r = await check();
  await close(s);
  t(r.code === 3, `JSON without a version is 'not this app' (got ${r.code})`);
}

console.log("— --quiet prints nothing but still sets the code —");
{
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "0.0.1-stale" }));
  });
  const r = await check("--quiet");
  await close(s);
  t(r.code === 1, "still exits 1");
  t(r.out.trim() === "", `silent (got ${JSON.stringify(r.out)})`);
}

console.log("\nversion-check tests done");
