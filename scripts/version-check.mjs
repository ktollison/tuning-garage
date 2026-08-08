// Is the running server the code that is on disk?
//
//   node scripts/version-check.mjs          human-readable, sets an exit code
//   node scripts/version-check.mjs --quiet  exit code only
//
// Exit codes:
//   0  a server is running and matches app/server.mjs
//   1  a server is running but is STALE — it started before the last pull
//   2  nothing is listening
//   3  something is listening but it is not this app
//
// Why this exists: the launchd agent keeps one long-lived node process alive.
// Pulling new code does not touch that process, so the app can go on serving
// last week's build indefinitely. Nothing surfaced it — `status` reported the
// agent loaded and the port answering, both true, while the code was stale.

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4590);
const quiet = process.argv.includes("--quiet");
const say = m => { if (!quiet) console.log(m); };

const onDisk = (await fsp.readFile(path.join(REPO, "app/server.mjs"), "utf8"))
  .match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!onDisk) { say("Could not read APP_VERSION from app/server.mjs"); process.exit(3); }

// Distinguish "nothing is listening" from "something is, but not us" — the
// two need opposite responses, so collapsing them into one code sent the
// launcher down the wrong branch and it tried to bind an occupied port.
let res;
try {
  res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(3000) });
} catch {
  say(`Nothing serving on port ${PORT}. On disk: v${onDisk}`);
  process.exit(2);
}

let state = null;
if (res.ok) { try { state = await res.json(); } catch { /* not JSON */ } }
if (!state?.version) {
  say(`Port ${PORT} is in use by something that is not this app (HTTP ${res.status}).`);
  process.exit(3);
}

if (state.version === onDisk) {
  say(`Running v${state.version} — current.`);
  process.exit(0);
}

say(`STALE: serving v${state.version}, but the code on disk is v${onDisk}.`);
say("The server started before the last pull and is still running the old build.");
process.exit(1);
