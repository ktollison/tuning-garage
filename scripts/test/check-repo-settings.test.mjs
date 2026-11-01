// scripts/check-repo-settings.mjs: a setting a doc depends on, switched off, is
// caught — and the finding says how to fix it. gh is a stub on PATH, so this
// never touches GitHub.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../check-repo-settings.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-repo-settings.mjs");

const GOOD = {
  repo: { private: false, is_template: true, has_discussions: true, web_commit_signoff_required: true, topics: ["tuning"] },
  vulnerabilityReporting: true,
  protection: { enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_conversation_resolution: { enabled: true } },
};
const broken = (over, name) => evaluate({ ...GOOD, ...over }).filter(c => !c.ok && (!name || c.what.includes(name)));

console.log("— evaluating settings —");
t(evaluate(GOOD).every(c => c.ok), "everything on: every promise is kept");
{
  const f = broken({ vulnerabilityReporting: false });
  t(f.length === 1 && f[0].level === "must" && /SECURITY\.md/.test(f[0].promised) && /private-vulnerability-reporting/.test(f[0].fix),
    "private vulnerability reporting off: caught, naming SECURITY.md and the command that turns it on");
}
t(broken({ repo: { ...GOOD.repo, is_template: false } }, "template").length === 1, "not a template repository: caught");
t(broken({ repo: { ...GOOD.repo, has_discussions: false } }, "Discussions").length === 1, "Discussions off: caught");
t(broken({ repo: { ...GOOD.repo, web_commit_signoff_required: false } }, "signed off").length === 1, "web sign-off not required: caught");
t(broken({ repo: { ...GOOD.repo, private: true } }, "public").length === 1, "a private repository: caught");
t(broken({ protection: { ...GOOD.protection, enforce_admins: { enabled: false } } }, "administrators").length === 1, "protection not applied to admins: caught");
t(broken({ protection: { ...GOOD.protection, allow_force_pushes: { enabled: true } } }, "force pushes").length === 1, "force pushes allowed: caught");
t(broken({ protection: { ...GOOD.protection, required_conversation_resolution: { enabled: false } } }, "conversations").length === 1, "conversation resolution off: caught");
t(broken({ protection: null }, "protected branch").length === 1, "no branch protection at all: caught");
{
  const f = broken({ repo: { ...GOOD.repo, topics: [] } }, "topics");
  t(f.length === 1 && f[0].level === "should", "no topics: reported, but as a suggestion, not a broken promise");
}

console.log("— the command, with a stub gh —");
if (process.platform === "win32") console.log("✓ stub-gh cases skipped on Windows (shell-script stub)");
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-settings-"));
  const stub = (vuln, extra = "") => {
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version 9" ;;
  "auth status") exit 0 ;;
  "api repos/owner/repo") echo '{"private":false,"is_template":true,"has_discussions":true,"web_commit_signoff_required":true,"topics":["tuning"]}' ;;
  "api repos/owner/repo/private-vulnerability-reporting") echo '{"enabled":${vuln}}' ;;
  "api repos/owner/repo/branches/main/protection") echo '{"enforce_admins":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false},"required_conversation_resolution":{"enabled":true}}' ;;
  *) ${extra} exit 0 ;;
esac
`, { mode: 0o755 });
  };
  const run = (args = []) => spawnSync(process.execPath, [SCRIPT, "--skip-labels", ...args], { encoding: "utf8",
    env: { ...process.env, GH: path.join(dir, "gh"), TUNING_PROJECT_REPO: "owner/repo" } });

  stub(true);
  let r = run();
  t(/private vulnerability reporting is enabled/.test(r.stdout) && !/✗ private vulnerability/.test(r.stderr), "settings in order: the vulnerability-reporting promise passes");

  stub(false);
  r = run();
  t(r.status === 1 && /✗ private vulnerability reporting is enabled/.test(r.stderr) && /fix: gh api -X PUT repos\/owner\/repo\/private-vulnerability-reporting/.test(r.stderr),
    "reporting off: the run fails and prints the fix command");

  fs.writeFileSync(path.join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  r = run();
  t(r.status === 1 && /cannot check the settings/.test(r.stderr), "gh unusable: a failure, not a silent pass");
  r = run(["--offline"]);
  t(r.status === 0 && /not checked/.test(r.stdout), "gh unusable with --offline: skipped, says so");
  fs.rmSync(dir, { recursive: true, force: true });
}
