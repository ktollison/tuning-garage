// The alert path. Borrowed wholesale from the deed-parse project, where each
// of these behaviours was learned from a real failure — so they are tested
// here rather than assumed to have survived the port.

import { spawn } from "node:child_process";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/notify-pushover.sh");
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "pushover-"));
const ENV_FILE = path.join(TMP, "pushover.env");
await fsp.writeFile(ENV_FILE, 'PUSHOVER_TOKEN=test-token\nPUSHOVER_USER=test-user\n');

let PORT = 4791;
// A stand-in Pushover. `reply` decides what each request gets; `seen` records
// what actually arrived so the secret-handling can be checked.
const stand = (reply) => new Promise(resolve => {
  const seen = [];
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString());
      const r = reply(seen.length);
      res.writeHead(r.code, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  s.listen(PORT, "127.0.0.1", () => resolve({ server: s, seen }));
});
const close = s => new Promise(r => s.close(r));

const run = (args = ["--title", "t", "--message", "m"]) => new Promise(resolve => {
  const out = [];
  const p = spawn("bash", [SCRIPT, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TUNING_PUSHOVER_ENV: ENV_FILE,
           TUNING_PUSHOVER_API: `http://127.0.0.1:${PORT}/messages.json` },
  });
  p.stdout.on("data", d => out.push(d));
  p.stderr.on("data", d => out.push(d));
  p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
});

console.log("— success is read from the body, not the status code —");
{
  const { server, seen } = await stand(() => ({ code: 200, body: '{"status":1,"request":"abc"}' }));
  const r = await run(); await close(server);
  t(r.code === 0, "exit 0 on a real success");
  t(/sent/.test(r.out), "says it sent");
  t(seen.length === 1, "one request, no needless retry");
}
{
  // HTTP 200 with status 0 is a FAILURE. Trusting the code alone reports sends
  // that never landed.
  const { server } = await stand(() => ({ code: 200, body: '{"status":0,"errors":["user identifier is invalid"]}' }));
  const r = await run(); await close(server);
  t(r.code !== 0, "HTTP 200 with status 0 is a failure, not a success");
  t(/status != 1/.test(r.out), "says why");
  t(/user identifier is invalid/.test(r.out), "surfaces the API's own reason rather than swallowing it");
}
{
  // If Pushover ever pretty-prints, an exact-string match would turn every
  // future alert into a false failure. This is the case that caught it.
  const { server } = await stand(() => ({ code: 200, body: '{\n  "status": 1,\n  "request": "abc"\n}' }));
  const r = await run(); await close(server);
  t(r.code === 0, "pretty-printed JSON still reads as success");
}

console.log("— retries: 5xx yes, 4xx never —");
{
  const { server, seen } = await stand(n => n < 3
    ? { code: 500, body: "upstream boom" }
    : { code: 200, body: '{"status":1}' });
  const r = await run(); await close(server);
  t(r.code === 0, "recovers when a 5xx clears");
  t(seen.length === 3, `retried to success (${seen.length} attempts)`);
}
{
  const { server, seen } = await stand(() => ({ code: 400, body: '{"status":0,"errors":["application token is invalid"]}' }));
  const r = await run(); await close(server);
  t(r.code !== 0, "4xx fails");
  t(seen.length === 1, "4xx is NOT retried — repeating those earns an IP block");
  t(/PERMANENT/.test(r.out), "names it permanent");
}
{
  const { server } = await stand(() => ({ code: 429, body: '{"status":0}' }));
  const r = await run(); await close(server);
  t(/monthly message quota/.test(r.out), "429 explains the quota rather than leaving a bare code");
}

console.log("— secrets and limits —");
{
  const { server, seen } = await stand(() => ({ code: 200, body: '{"status":1}' }));
  await run(); await close(server);
  t(/test-token/.test(seen[0]) && /test-user/.test(seen[0]), "credentials do reach the API");
  // They must arrive in the body, never as argv — argv is world-readable via ps.
  t(!/token=test-token/.test(process.argv.join(" ")), "and never appear in this process's arguments");
}
{
  const { server, seen } = await stand(() => ({ code: 200, body: '{"status":1}' }));
  await run(["--title", "T".repeat(400), "--message", "M".repeat(2000)]); await close(server);
  const title = /name="title"\r?\n\r?\n(T+)/.exec(seen[0]);
  t(title && title[1].length === 250, `title trimmed to 250 (got ${title ? title[1].length : "none"})`);
  t(seen[0].length < 4000, "message trimmed rather than letting the API reject the lot");
}
{
  // Priority 2 without retry/expire is a 400 — the most important alert lost.
  const { server, seen } = await stand(() => ({ code: 200, body: '{"status":1}' }));
  await run(["--title", "t", "--message", "m", "--priority", "2"]); await close(server);
  t(/name="retry"/.test(seen[0]) && /name="expire"/.test(seen[0]),
    "emergency priority supplies retry and expire automatically");
}

console.log("— absent config is not an error —");
{
  const r = await new Promise(resolve => {
    const out = [];
    const p = spawn("bash", [SCRIPT, "--title", "t"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TUNING_PUSHOVER_ENV: path.join(TMP, "nope.env") },
    });
    p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => out.push(d));
    p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
  });
  t(r.code === 0, "no config -> exit 0, so a fresh clone works");
  t(/not sending/.test(r.out), "and says it did nothing");
}

await fsp.rm(TMP, { recursive: true, force: true });
console.log("\npushover tests done");
