// scripts/check-kit-docs.mjs: each check fails when it should, and a clean kit passes.
//
// A minimal kit is built in a temp folder, proven clean, then broken one way at
// a time. A docs gate that cannot be shown to fail is a gate that may never
// have worked.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkKitDocs, CHECKS } from "../check-kit-docs.mjs";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };

const BASE = {
  "app/server.mjs": `const APP_VERSION = "1.2.3";\nconst MIN_NODE = 20;\n  if (req.method === "GET" && url.pathname === "/api/state") {}\n  if (req.method === "POST" && url.pathname === "/api/thing") {}\n`,
  "app/public/index.html": `const TABS = [["garage", "Garage"], ["overview", "Overview"]];`,
  "app/modules/foo.mjs": "export {};\n",
  "scripts/foo.mjs": "export {};\n",
  "start-tuning.sh": `node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)" || { echo "Node.js 20 or newer is needed"; }\n`,
  "start-tuning.cmd": `node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"\r\necho Node.js 20 or newer is needed\r\n`,
  "CHANGELOG.md": `# Changelog

## [Unreleased]

## [1.2.3] - 2026-02-02

### Added

- A thing.

### Fixed

- Another.

## [1.2.2] - 2026-02-01

### Added

- Earlier.

[Unreleased]: https://example.com/compare/v1.2.3...HEAD
[1.2.3]: https://example.com/compare/v1.2.2...v1.2.3
[1.2.2]: https://example.com/releases/tag/v1.2.2
`,
  "README.md": `# Kit

Plain Node 20+. See [the guide](USER-GUIDE.md#usage) and \`scripts/foo.mjs\`, \`app/modules/foo.mjs\`.

\`\`\`bash
node scripts/foo.mjs
\`\`\`

## The app

| Tab | What |
|---|---|
| **Garage** | cars |
| **Overview** | one car |

You keep \`data/preferences.json\`, created on first use. Launch with \`start-tuning.sh\` or \`start-tuning.cmd\`.
`,
  "USER-GUIDE.md": `# Guide\n\nLast checked against **v1.2.3**.\n\n## Usage\n\nText.\n`,
  "reference/api.md": "# API\n\nWrites need `X-Tuning-Garage: 1`.\n\n| a | b |\n|---|---|\n| `GET` `/api/state` | x |\n| `POST` `/api/thing` | y |\n",
  ".github/workflows/ci.yml": "jobs:\n  t:\n    strategy:\n      matrix:\n        node-version: [20, 24]\n    steps:\n      - run: node scripts/foo.mjs\n",
};

function kit(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-kitdocs-"));
  for (const [p, c] of Object.entries({ ...BASE, ...over })) {
    if (c === null) continue;
    const f = path.join(dir, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  }
  return dir;
}
const run = over => { const d = kit(over); const r = checkKitDocs({ root: d }); fs.rmSync(d, { recursive: true, force: true }); return r.problems; };
const fails = (over, id, re, msg) => {
  const p = run(over).filter(x => x.id === id);
  t(p.length > 0 && (!re || p.some(x => re.test(x.message))), `${msg}${p[0] ? "" : " — NOT CAUGHT"}`);
};
const edit = (file, from, to) => ({ [file]: BASE[file].replace(from, to) });

console.log("— a clean kit passes —");
t(run({}).length === 0, `no findings on the baseline kit (${run({}).map(p => p.message).join("; ")})`);
t(CHECKS.length >= 10, `${CHECKS.length} checks are defined`);

console.log("— each check fails when it should —");
fails(edit("app/server.mjs", '"1.2.3"', '"1.2.4"'), "version", /newest CHANGELOG release/, "version: APP_VERSION ahead of the changelog");
fails(edit("CHANGELOG.md", "## [Unreleased]\n\n", ""), "version", /Unreleased/, "version: no [Unreleased] section");
fails(edit("CHANGELOG.md", "### Added\n\n- A thing.\n\n### Fixed", "### Fixed\n\n- A thing.\n\n### Added"), "changelog", /out of order/, "changelog: sections out of order");
fails(edit("CHANGELOG.md", "### Fixed", "### Fixed — wrong numbers"), "changelog", /use only/, "changelog: a non-standard section name");
fails(edit("CHANGELOG.md", "### Fixed\n\n- Another.", "### Fixed\n\n- Another.\n\n### Fixed\n\n- Again."), "changelog", /twice/, "changelog: a section used twice");
fails(edit("CHANGELOG.md", "## [1.2.2] - 2026-02-01", "## [1.2.2]"), "changelog", /YYYY-MM-DD/, "changelog: a release with no date");
fails(edit("CHANGELOG.md", "[1.2.2]: https://example.com/releases/tag/v1.2.2\n", ""), "changelog", /no \[1\.2\.2\] link/, "changelog: a release with no compare link");
fails(edit("USER-GUIDE.md", "v1.2.3", "v1.2.0"), "guide-stamp", /Last checked against \*\*v1\.2\.3\*\*/, "guide: a stale version stamp");
fails(edit("README.md", "`scripts/foo.mjs`, `app", "`scripts/gone.mjs`, `app"), "paths", /scripts\/gone\.mjs/, "paths: a file the kit does not contain");
t(run({}).every(p => p.id !== "paths"), "paths: a runtime-created file (data/preferences.json) is allowed");
fails(edit("README.md", "node scripts/foo.mjs", "node scripts/missing.mjs"), "commands", /missing\.mjs/, "commands: a command that runs a missing script");
fails(edit("README.md", "(USER-GUIDE.md#usage)", "(USER-GUIDE.md#nowhere)"), "links", /no "#nowhere" heading/, "links: an anchor that does not exist");
fails(edit("README.md", "(USER-GUIDE.md#usage)", "(NOPE.md)"), "links", /not in the kit/, "links: a file that does not exist");
fails(edit("README.md", "(USER-GUIDE.md#usage)", "(../../security/advisories/new)"), "links", /leaves the repository/, "links: a relative link that leaves the repository");
fails({ "scripts/extra.mjs": "export {};\n" }, "documented-files", /scripts\/extra\.mjs/, "documented-files: a script no doc names");
fails({ "app/modules/extra.mjs": "export {};\n" }, "documented-files", /app\/modules\/extra\.mjs/, "documented-files: a module no doc names");
fails(edit("app/public/index.html", '["overview", "Overview"]', '["overview", "Overview"], ["extra", "Extra"]'), "tabs", /"Extra" tab/, "tabs: an app tab the README does not list");
fails(edit("README.md", "| **Overview** | one car |", "| **Overview** | one car |\n| **Ghost** | none |"), "tabs", /"Ghost" tab/, "tabs: a README tab the app does not have");
fails(edit("app/server.mjs", "}\n", "}\n  if (req.method === \"GET\" && url.pathname === \"/api/new\") {}\n"), "api", /does not document \/api\/new/, "api: an endpoint the reference lacks");
fails(edit("reference/api.md", "| `POST` `/api/thing` | y |", "| `POST` `/api/thing` | y |\n| `GET` `/api/ghost` | z |"), "api", /\/api\/ghost/, "api: an endpoint the server does not answer");
fails(edit("reference/api.md", "X-Tuning-Garage", "the header"), "api", /X-Tuning-Garage/, "api: the write-header requirement is not mentioned");
fails(edit("start-tuning.sh", ">= 20", ">= 18"), "node", /start-tuning\.sh requires Node 18/, "node: a launcher with a different minimum");
fails(edit("README.md", "Node 20+", "Node 18+"), "node", /promises Node 18\+/, "node: a doc promising another minimum");
fails(edit(".github/workflows/ci.yml", "[20, 24]", "[18, 24]"), "node", /tests Node 18/, "node: CI testing a different lowest version");
fails(edit(".github/workflows/ci.yml", "      matrix:\n        node-version: [20, 24]\n", ""), "node", /does not set a node-version matrix/, "node: CI with no version matrix");
fails(edit(".github/workflows/ci.yml", "node scripts/foo.mjs", "node scripts/ghost.mjs"), "workflows", /ghost\.mjs/, "workflows: a workflow that runs a missing script");

console.log("— the real kit is checked the same way —");
{
  // every check has a title for --list, and a failure always names its check
  t(CHECKS.every(c => c.id && c.title && typeof c.run === "function"), "every check has an id, a title and a runner");
  const crash = checkKitDocs({ root: path.join(os.tmpdir(), "definitely-not-a-kit-" + process.pid) });
  t(crash.problems.length > 0 && crash.problems.every(p => /could not run/.test(p.message)), "an unreadable kit reports a failure rather than passing");
}
