// The submission poller's debounce.
//
// Borrowed from deed-parse's submission_alert.sh, where the lesson was that a
// path unit fires on far more than the event you care about — so it announces
// only what is newer than the last thing it announced. Same hazard here for a
// different reason: polling re-lists the same open issues every few minutes,
// and an alert that repeats itself gets muted, which is the same as no alert.
//
// `gh` and the notifier are both stubbed, so this never touches the real repo
// and never sends a notification.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "watch-"));
const BIN = path.join(TMP, "bin");
await fsp.mkdir(BIN, { recursive: true });

// A stub `gh` that answers from a JSON file we control.
const writeGh = async (issues, prs) => {
  await fsp.writeFile(path.join(TMP, "issues.json"), JSON.stringify(issues));
  await fsp.writeFile(path.join(TMP, "prs.json"), JSON.stringify(prs));
  await fsp.writeFile(path.join(BIN, "gh"), `#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  issue) cat "${path.join(TMP, "issues.json")}" ;;
  pr) cat "${path.join(TMP, "prs.json")}" ;;
esac
`, { mode: 0o755 });
};

const run = (args = []) => new Promise(resolve => {
  const out = [];
  const p = spawn(process.execPath, [path.join(REPO, "scripts/watch-submissions.mjs"), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`,
           TUNING_STATE_DIR: path.join(TMP, "state"),
           // point the notifier at a config that does not exist -> it no-ops
           TUNING_PUSHOVER_ENV: path.join(TMP, "absent.env") },
  });
  p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => out.push(d));
  p.on("close", code => resolve({ code, out: Buffer.concat(out).toString() }));
});

const issue = (n, labels = ["submission"]) =>
  ({ number: n, title: `log ${n}`, url: `https://x/${n}`, author: { login: "someone" },
     createdAt: "2026-01-01", labels: labels.map(name => ({ name })) });

console.log("— announces new items once, then stays quiet —");
{
  await writeGh([issue(1), issue(2)], []);
  const announced = (out, kind, n) => new RegExp(`new ${kind} #${n}\\b`).test(out);
  const first = await run();
  t(announced(first.out, "issue", 1) && announced(first.out, "issue", 2), "first run announces both");
  t(/2 announced/.test(first.out), "reports the count");

  const second = await run();
  t(!announced(second.out, "issue", 1) && !announced(second.out, "issue", 2),
    "second run announces nothing again");
  t(/nothing new/.test(second.out), "and says so");

  await writeGh([issue(1), issue(2), issue(3)], []);
  const third = await run();
  t(announced(third.out, "issue", 3), "a genuinely new issue is announced");
  t(!announced(third.out, "issue", 1), "without re-announcing the old ones");
}

console.log("— fork pull requests are not missed —");
{
  await fsp.rm(path.join(TMP, "state"), { recursive: true, force: true });
  // A contributor cannot label an issue in a repo they do not own, so requiring
  // a label would drop exactly the fork PRs this poller exists to catch.
  await writeGh([], [{ number: 7, title: "add channel names", url: "https://x/7",
                       author: { login: "outsider" }, createdAt: "2026-01-01", labels: [] }]);
  const r = await run();
  t(/new pr #7\b/.test(r.out), "an unlabelled pull request still counts as a submission");
  t(/pr/.test(r.out), "identified as a pull request");
}

console.log("— issues and pull requests are tracked separately —");
{
  await fsp.rm(path.join(TMP, "state"), { recursive: true, force: true });
  await writeGh([issue(10)], [{ number: 3, title: "pr", url: "https://x/3",
                                author: { login: "a" }, createdAt: "x", labels: [] }]);
  await run();
  // PR #4 is lower than issue #10 — a single shared counter would swallow it.
  await writeGh([issue(10)], [{ number: 3, title: "pr", url: "https://x/3", author: { login: "a" }, createdAt: "x", labels: [] },
                              { number: 4, title: "newer pr", url: "https://x/4", author: { login: "b" }, createdAt: "x", labels: [] }]);
  const r = await run();
  t(/new pr #4\b/.test(r.out), "PR #4 announced even though issue #10 is a higher number");
}

console.log("— an unreadable state file does not cause a flood —");
{
  const stateFile = path.join(TMP, "state", "last-announced.json");
  await fsp.writeFile(stateFile, "{ this is not json");
  await writeGh([issue(1), issue(2), issue(3)], []);
  const r = await run();
  t(!/new issue #1\b/.test(r.out), "does not re-announce everything it has ever seen");
  t(/unreadable/.test(r.out), "and says the state file was the problem");
}

console.log("— dry run writes no state —");
{
  await fsp.rm(path.join(TMP, "state"), { recursive: true, force: true });
  await writeGh([issue(99)], []);
  await run(["--dry-run"]);
  t(!fs.existsSync(path.join(TMP, "state", "last-announced.json")), "no state file after a dry run");
  const real = await run();
  t(/new issue #99\b/.test(real.out), "so the real run still announces it");
}

await fsp.rm(TMP, { recursive: true, force: true });
console.log("\nwatch-submissions tests done");
