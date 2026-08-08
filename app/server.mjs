// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Tuning repo web app — local server, zero dependencies (Node >= 18).
// Reads/writes the real repo files; git remains the source of history.
// Start:  node app/server.mjs   (TUNING_REPO env var overrides repo root, PORT overrides 4590)

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { analyzeBuffer } from "./modules/index.mjs";
import { analyze as analyzeLog, FUELS } from "./modules/loganalysis.mjs";
import { parseXdf, readTable, diffTables } from "./modules/xdf.mjs";
import { detectUnit, convert, DEFAULT_PREFERENCES, QUANTITIES } from "./modules/units.mjs";
import * as scanner from "./modules/vcmscanner.mjs";

const execFileP = promisify(execFile);
const APP_VERSION = "0.31.5"; // keep in step with CHANGELOG.md — CI enforces the match
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.TUNING_REPO || path.join(__dirname, ".."));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4590);
const USER_MATH = path.join(REPO, "data", "user-math.json");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".md": "text/markdown; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml",
};

// ---------- helpers ----------

const today = () => new Date().toISOString().slice(0, 10);

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("path escapes repo");
  return p;
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "untitled";
}

async function git(...args) {
  try {
    const { stdout } = await execFileP("git", ["-C", REPO, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || e.message}`.trim() };
  }
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const shaCache = new Map(); // path -> {mtime, size, sha}
async function fileSha(p, st) {
  const hit = shaCache.get(p);
  const mtime = st.mtime.toISOString();
  if (hit && hit.mtime === mtime && hit.size === st.size) return hit.sha;
  const sha = crypto.createHash("sha256").update(await fsp.readFile(p)).digest("hex");
  shaCache.set(p, { mtime, size: st.size, sha });
  return sha;
}

async function listFiles(dir, { withHash = false } = {}) {
  try {
    const names = await fsp.readdir(dir);
    const out = [];
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = path.join(dir, n);
      const st = await fsp.stat(p);
      if (!st.isFile()) continue;
      const entry = { name: n, size: st.size, mtime: st.mtime.toISOString() };
      if (withHash) entry.sha256 = await fileSha(p, st);
      out.push(entry);
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

async function syncCounts() {
  const ahead = await git("rev-list", "--count", "@{u}..HEAD");
  const behind = await git("rev-list", "--count", "HEAD..@{u}");
  return {
    ahead: ahead.ok ? Number(ahead.out) : null,
    behind: behind.ok ? Number(behind.out) : null,
  };
}

// ---------- progression parsing (PROGRESSION.md is the source of truth) ----------

const STATUSES = ["⬜", "🟡", "🟢"];

async function readProgression() {
  const text = await fsp.readFile(path.join(REPO, "PROGRESSION.md"), "utf8");
  const stages = [];
  const milestones = [];
  let current = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^## Stage (\d+) — (.+)/);
    if (h) { current = { num: Number(h[1]), name: h[2].trim(), concepts: [] }; stages.push(current); continue; }
    if (/^## Milestones/.test(line)) { current = null; }
    const row = line.match(/^\| (.+?) \| (⬜|🟡|🟢) \| ?(.*?) ?\|$/);
    if (row && current && row[1] !== "Concept") {
      current.concepts.push({ concept: row[1].trim(), status: row[2], notes: row[3].trim() });
    }
    const ms = line.match(/^- \[( |x)\] (.+)/);
    if (ms) milestones.push({ done: ms[1] === "x", text: ms[2].trim() });
  }
  return { stages, milestones };
}

async function updateProgression({ concept, status, notes, milestone, done }) {
  const file = path.join(REPO, "PROGRESSION.md");
  let text = await fsp.readFile(file, "utf8");
  if (concept !== undefined) {
    if (!STATUSES.includes(status)) throw new Error("bad status");
    const lines = text.split("\n");
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i].match(/^\| (.+?) \| (⬜|🟡|🟢) \| ?(.*?) ?\|$/);
      if (row && row[1].trim() === concept) {
        const newNotes = notes !== undefined ? notes : row[3].trim();
        lines[i] = `| ${row[1]} | ${status} | ${newNotes} |`;
        hit = true;
        break;
      }
    }
    if (!hit) throw new Error(`concept not found: ${concept}`);
    text = lines.join("\n");
  }
  if (milestone !== undefined) {
    const re = new RegExp(`^- \\[( |x)\\] ${milestone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
    if (!re.test(text)) throw new Error(`milestone not found: ${milestone}`);
    text = text.replace(re, `- [${done ? "x" : " "}] ${milestone}`);
  }
  await fsp.writeFile(file, text);
}

// ---------- timeline ----------
// One chronological history from the pieces that already carry dates:
// filenames, session files, and the flash log. Also reports the gaps —
// a revision never flashed, a log with no revision behind it — because those
// are the things worth noticing and nothing else in the app shows them.

async function buildTimeline(id) {
  const base = path.join(REPO, "vehicles", id);
  const events = [];
  const dateOf = name => name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "";

  for (const f of await listFiles(path.join(base, "tunes", "stock"))) {
    events.push({ date: dateOf(f.name), type: "baseline", title: "Baseline archived",
      detail: f.name, ext: path.extname(f.name) });
  }

  // group the formats of one revision into a single event
  const revs = new Map();
  for (const f of (await listFiles(path.join(base, "tunes"))).filter(f => f.name !== "CHANGELOG.md")) {
    const rev = f.name.match(/^(v\d{3})/)?.[1];
    if (!rev) continue;
    if (!revs.has(rev)) revs.set(rev, { date: dateOf(f.name), rev, files: [] });
    revs.get(rev).files.push(f.name);
  }
  for (const r of revs.values()) {
    events.push({ date: r.date, type: "revision", rev: r.rev, title: `${r.rev} checked in`,
      detail: r.files.join(", ") });
  }

  const logsByRev = new Map();
  for (const f of await listFiles(path.join(base, "datalogs"))) {
    const rev = f.name.match(/_(v\d{3})_/)?.[1] || null;
    if (rev) logsByRev.set(rev, (logsByRev.get(rev) || 0) + 1);
    events.push({ date: dateOf(f.name), type: "datalog", rev, title: "Datalog captured",
      detail: f.name });
  }

  for (const f of await listFiles(path.join(base, "sessions"))) {
    let goal = "";
    try {
      const t = await fsp.readFile(path.join(base, "sessions", f.name), "utf8");
      goal = t.match(/^\*\*Goal for this session:\*\*\s*(.*)$/m)?.[1]?.trim() || "";
      if (!goal) goal = t.match(/^\*\*Tune revision flashed:\*\*\s*(.*)$/m)?.[1]?.trim() || "";
    } catch {}
    events.push({ date: dateOf(f.name), type: "session", title: "Session logged",
      detail: goal || f.name, file: `vehicles/${id}/sessions/${f.name}` });
  }

  const flashed = new Set();
  try {
    const text = await fsp.readFile(path.join(base, "flash-log.md"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/);
      if (!m) continue;
      flashed.add(m[2]);
      events.push({ date: m[1], type: "flash", rev: m[2], title: `Flashed ${m[2]}`,
        detail: [m[3], m[4] !== "—" ? m[4] : ""].filter(Boolean).join(" · ") });
    }
  } catch {}

  events.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1)); // newest first

  const revList = [...revs.keys()];
  const insights = {
    revisionsNeverFlashed: revList.filter(r => !flashed.has(r)),
    revisionsWithoutLogs: revList.filter(r => !logsByRev.has(r)),
    // a log naming a revision that was never checked in — the file is orphaned
    orphanLogRevs: [...new Set(events.filter(e => e.type === "datalog" && e.rev && !revs.has(e.rev)).map(e => e.rev))],
    flashedRevs: [...flashed],
    counts: {
      baseline: events.filter(e => e.type === "baseline").length,
      revision: revList.length,
      datalog: events.filter(e => e.type === "datalog").length,
      session: events.filter(e => e.type === "session").length,
      flash: events.filter(e => e.type === "flash").length,
    },
  };
  return { events, insights };
}

// ---------- pre-flash checklist ----------
// templates/pre-flash-checklist.md is the single source of truth: edit the
// markdown and the app's checklist changes with it.

async function readChecklist() {
  const text = await fsp.readFile(path.join(REPO, "templates", "pre-flash-checklist.md"), "utf8");
  const sections = [];
  const seen = new Set();
  let current = null, lastItem = null;
  const clean = s => s.replace(/\*\*/g, "").replace(/`/g, "").trim();

  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+)/);
    if (h) { current = { section: clean(h[1]), items: [] }; sections.push(current); lastItem = null; continue; }
    const item = line.match(/^- \[ \] (.+)/);
    if (item && current) {
      lastItem = { id: "", label: clean(item[1]) };
      current.items.push(lastItem);
      continue;
    }
    // an indented non-empty line continues the item above it
    if (lastItem && /^\s+\S/.test(line)) { lastItem.label += " " + clean(line); continue; }
    if (!line.trim()) lastItem = null;
  }

  // ids derive from the label but must be unique and stable
  for (const s of sections) {
    for (const it of s.items) {
      let id = slug(it.label).slice(0, 60), n = 2;
      while (seen.has(id)) id = `${slug(it.label).slice(0, 56)}-${n++}`;
      seen.add(id);
      it.id = id;
    }
  }
  return sections.filter(s => s.items.length);
}

// ---------- vehicles ----------

// vehicle.md "Current state" is a bullet list, not a table — /api/vehicle-field
// handles table rows and cannot be reused here.
async function updateVehicleBullet(vehicleDir, label, value) {
  const file = path.join(vehicleDir, "vehicle.md");
  let text = await fsp.readFile(file, "utf8");
  const re = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*$`, "m");
  if (!re.test(text)) throw new Error(`bullet not found in vehicle.md: ${label}`);
  text = text.replace(re, `- ${label}: ${String(value).replace(/\n/g, " ")}`);
  await fsp.writeFile(file, text);
}

function parseCurrentState(profile) {
  const get = label => {
    const m = profile.match(new RegExp(`^- ${label}: (.*)$`, "m"));
    const v = m?.[1]?.trim() || "";
    return /^[—-]?\s*(\(stock\))?$/.test(v) ? "" : v;   // treat the placeholders as empty
  };
  return {
    currentRevision: get("Current tune revision"),
    lastFlashed: get("Last flashed"),
  };
}

async function vehicleState(id) {
  const base = path.join(REPO, "vehicles", id);
  const tunesDir = path.join(base, "tunes");
  const tunes = (await listFiles(tunesDir, { withHash: true })).filter(f => f.name !== "CHANGELOG.md");
  const stock = await listFiles(path.join(tunesDir, "stock"), { withHash: true });
  const datalogs = await listFiles(path.join(base, "datalogs"));
  const sessions = await listFiles(path.join(base, "sessions"));
  let changelog = "", profile = "";
  try { changelog = await fsp.readFile(path.join(tunesDir, "CHANGELOG.md"), "utf8"); } catch {}
  try { profile = await fsp.readFile(path.join(base, "vehicle.md"), "utf8"); } catch {}
  let flashLog = "";
  try { flashLog = await fsp.readFile(path.join(base, "flash-log.md"), "utf8"); } catch {}
  return { id, tunes, stock, datalogs, sessions, changelog, profile, flashLog, ...parseCurrentState(profile) };
}

function nextRev(tunes) {
  let max = 0;
  for (const f of tunes) {
    const m = f.name.match(/^v(\d{3})_/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "v" + String(max + 1).padStart(3, "0");
}

// ---------- platforms & definitions ----------

async function readPlatforms() {
  const dir = path.join(REPO, "data", "platforms");
  const out = [];
  try {
    for (const f of await fsp.readdir(dir)) {
      if (f.endsWith(".json")) out.push(JSON.parse(await fsp.readFile(path.join(dir, f), "utf8")));
    }
  } catch {}
  return out;
}

async function readDonorFiles() {
  return listFiles(path.join(REPO, "donor-files"), { withHash: true });
}

// Reference docs, surfaced in the app so notes are readable where the work happens
async function readDocs() {
  const out = [];
  // top-level docs a reader should meet first
  for (const f of ["USER-GUIDE.md", "DISCLAIMER.md", "README.md"]) {
    if (fs.existsSync(path.join(REPO, f)))
      out.push({ path: f, name: f.replace(/\.md$/, ""), group: "start here" });
  }
  for (const rel of ["reference", "reference/tools", "reference/platforms", "reference/incidents"]) {
    for (const f of await listFiles(path.join(REPO, rel))) {
      if (f.name.endsWith(".md")) out.push({ path: `${rel}/${f.name}`, name: f.name.replace(/\.md$/, ""), group: rel });
    }
  }
  return out;
}

async function readDefinitions() {
  const dir = path.join(REPO, "definitions");
  const out = [];
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push({ osId: e.name, files: await listFiles(path.join(dir, e.name)) });
    }
  } catch {}
  return out.sort((a, b) => a.osId.localeCompare(b.osId));
}

// ---------- VCM Scanner configs ----------
const SCAN_DIR = path.join(REPO, "vcm-scanner");
const SCAN_FOLDERS = { channels: "channels", charts: "charts", graphs: "graphs", layout: "layouts", math: "math" };

async function readJsonOr(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
}

/** Parse every config, merge the dictionary, and attach index metadata. */
async function readScanner() {
  const index = await readJsonOr(path.join(SCAN_DIR, "index.json"), { files: {} });
  const unitCodes = (await readJsonOr(path.join(SCAN_DIR, "unit-codes.json"), { codes: {} })).codes;
  const dictFile = await readJsonOr(path.join(SCAN_DIR, "channel-dictionary.json"), { generated: {}, manual: {} });

  const parsed = [];
  for (const folder of new Set(Object.values(SCAN_FOLDERS))) {
    for (const f of await listFiles(path.join(SCAN_DIR, folder))) {
      if (!f.name.toLowerCase().endsWith(".xml")) continue;
      try {
        const text = await fsp.readFile(path.join(SCAN_DIR, folder, f.name), "utf8");
        const p = scanner.parseFile(f.name, text);
        parsed.push({ ...p, folder, size: f.size, meta: index.files?.[f.name] || {} });
      } catch (e) { parsed.push({ filename: f.name, folder, error: e.message, meta: index.files?.[f.name] || {} }); }
    }
  }
  // manual entries win over generated ones and are never overwritten
  const dictionary = { ...scanner.buildDictionary(parsed), ...(dictFile.manual || {}) };
  return { files: parsed, dictionary, unitCodes, platforms: [...new Set(parsed.map(p => p.meta?.platform).filter(Boolean))].sort() };
}

/** One place that turns a parsed Math Lab parameter into a User Math entry.
 *  Both the import endpoint and the upload path go through this. */
function mathParamToUserMath(m, sourceFile, dictionary, unitCodes) {
  const dec = scanner.decodeExpression(m.expression, dictionary, unitCodes);
  const uc = m.unitId ? unitCodes[m.unitId] : null;
  return {
    id: "vcm-" + slug(m.name || path.basename(sourceFile, ".xml")),
    name: (m.name || path.basename(sourceFile, ".xml")).trim(),
    category: "VCM Scanner Math Lab",
    expression: m.expression,
    units: uc?.symbol && uc.symbol !== "?"
      ? `${uc.symbol} (HPT unit code ${m.unitId}, inferred)`
      : (m.unitId ? `HPT unit code ${m.unitId} — meaning unverified` : ""),
    inputs: m.uniqueParameterIDs.map(pid => dictionary[pid]?.label || `#${pid}`).join(", "),
    notes: [
      dec.decoded !== m.expression ? `Decoded: ${dec.decoded}` : "",
      dec.unknown.length ? `Parameter IDs not yet in the channel dictionary: ${dec.unknown.join(", ")}.` : "",
      `From ${sourceFile}; ${m.decimals ?? "?"} decimals.`,
    ].filter(Boolean).join(" "),
    source: `VCM Scanner Math Lab export (${sourceFile})`,
    status: "unverified",
    updated: today(),
  };
}

// ---------- preferences (in the repo, so both machines agree) ----------
const PREFS_FILE = path.join(REPO, "data", "preferences.json");

async function readPrefs() {
  try {
    const p = JSON.parse(await fsp.readFile(PREFS_FILE, "utf8"));
    return { ...DEFAULT_PREFERENCES, ...p, units: { ...DEFAULT_PREFERENCES.units, ...(p.units || {}) } };
  } catch { return structuredClone(DEFAULT_PREFERENCES); }
}

async function writePrefs(next) {
  await fsp.mkdir(path.dirname(PREFS_FILE), { recursive: true });
  await fsp.writeFile(PREFS_FILE, JSON.stringify(next, null, 2) + "\n");
}

// ---------- user math ----------

async function readUserMath() {
  try { return JSON.parse(await fsp.readFile(USER_MATH, "utf8")); } catch { return { parameters: [] }; }
}

async function writeUserMath(data) {
  await fsp.mkdir(path.dirname(USER_MATH), { recursive: true });
  await fsp.writeFile(USER_MATH, JSON.stringify(data, null, 2) + "\n");
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const q = url.searchParams;
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // ----- read state -----
  if (req.method === "GET" && url.pathname === "/api/state") {
    const vehicleIds = (await fsp.readdir(path.join(REPO, "vehicles"), { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name).sort();
    const vehicles = [];
    for (const id of vehicleIds) vehicles.push(await vehicleState(id));
    const progression = await readProgression();
    const userMath = await readUserMath();
    const platforms = await readPlatforms();
    const definitions = await readDefinitions();
    const donorFiles = await readDonorFiles();
    const docs = await readDocs();
    const preferences = await readPrefs();
    const scannerConfigs = await readScanner();
    const status = await git("status", "--porcelain");
    const last = await git("log", "-1", "--format=%h %ad %s", "--date=format:%Y-%m-%d %H:%M");
    const { ahead, behind } = await syncCounts();
    return send(200, {
      repo: REPO, version: APP_VERSION, vehicles, progression, userMath, platforms, definitions, donorFiles, docs, preferences, quantities: QUANTITIES, fuels: FUELS, scanner: scannerConfigs,
      git: status.ok ? {
        dirty: status.out ? status.out.split("\n").length : 0,
        lastCommit: last.ok ? last.out : "",
        ahead, behind,
      } : { dirty: 0, lastCommit: "not a git repo yet — run: git init", ahead: null, behind: null },
    });
  }

  // ----- file download / view -----
  if (req.method === "GET" && url.pathname === "/api/file") {
    const p = safeJoin(REPO, q.get("path") || "");
    const st = await fsp.stat(p);
    if (!st.isFile()) return send(404, { error: "not a file" });
    const name = path.basename(p);
    res.writeHead(200, {
      "content-type": MIME[path.extname(name)] || "application/octet-stream",
      "content-length": st.size,
      "content-disposition": q.get("dl") ? `attachment; filename="${name}"` : "inline",
    });
    fs.createReadStream(p).pipe(res);
    return;
  }

  // ----- read-only bin analysis (platform modules) -----
  if (req.method === "GET" && url.pathname === "/api/analyze") {
    const p = safeJoin(REPO, q.get("path") || "");
    if (!fs.existsSync(p)) return send(404, { error: "file not found" });
    if (path.extname(p).toLowerCase() !== ".bin")
      return send(200, { analyzable: false, reason: "analysis works on raw .bin files only (.hpt is a proprietary HP Tuners format)" });
    const buf = await fsp.readFile(p);
    const analysis = analyzeBuffer(buf);
    if (!analysis) return send(200, { analyzable: false, reason: "no platform module recognizes this file (size/signature mismatch — partial or non-Gen3 read?)" });
    return send(200, { analyzable: true, file: path.relative(REPO, p), ...analysis });
  }

  // ----- segment-aware bin compare -----
  if (req.method === "GET" && url.pathname === "/api/compare") {
    const pa = safeJoin(REPO, q.get("a") || ""), pb = safeJoin(REPO, q.get("b") || "");
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) return send(404, { error: "one or both files not found" });
    if (![pa, pb].every(p => p.toLowerCase().endsWith(".bin")))
      return send(200, { comparable: false, reason: "compare works on raw .bin files only" });
    const [bufA, bufB] = await Promise.all([fsp.readFile(pa), fsp.readFile(pb)]);
    const anA = analyzeBuffer(bufA), anB = analyzeBuffer(bufB);
    const minLen = Math.min(bufA.length, bufB.length);
    let totalDiff = 0;
    for (let i = 0; i < minLen; i++) if (bufA[i] !== bufB[i]) totalDiff++;
    totalDiff += Math.abs(bufA.length - bufB.length);
    const out = {
      comparable: true,
      a: { file: path.relative(REPO, pa), size: bufA.length, osId: anA?.osId, sha256: crypto.createHash("sha256").update(bufA).digest("hex") },
      b: { file: path.relative(REPO, pb), size: bufB.length, osId: anB?.osId, sha256: crypto.createHash("sha256").update(bufB).digest("hex") },
      identical: bufA.length === bufB.length && totalDiff === 0,
      totalBytesChanged: totalDiff,
      sizeMismatch: bufA.length !== bufB.length,
    };
    // Table-level diff when a definition is supplied (or auto-found for this OS)
    let xdfPath = q.get("xdf");
    if (!xdfPath && anA?.osId && anA.osId === anB?.osId) {
      const dir = path.join(REPO, "definitions", String(anA.osId));
      const cand = (await listFiles(dir)).find(f => f.name.toLowerCase().endsWith(".xdf"));
      if (cand) xdfPath = path.join("definitions", String(anA.osId), cand.name);
    }
    if (xdfPath) {
      try {
        const xdf = parseXdf(await fsp.readFile(safeJoin(REPO, xdfPath), "utf8"));
        out.tableDiff = { xdf: xdfPath, ...diffTables(bufA, bufB, xdf) };
      } catch (e) { out.tableDiff = { error: "XDF parse failed: " + e.message, xdf: xdfPath }; }
    }

    if (anA?.segments && !out.sizeMismatch) {
      const diffIn = (start, len) => {
        let n = 0;
        const end = Math.min(start + len, minLen);
        for (let i = start; i < end; i++) if (bufA[i] !== bufB[i]) n++;
        return n;
      };
      const os2len = anA.pcm === "P59" ? 0xdfffe : 0x5fffe;
      out.regions = [
        { name: "OS header/cal (0x0-0x4000)", bytesChanged: diffIn(0, 0x4000) },
        { name: "EEPROM data (VIN/serial)", bytesChanged: diffIn(0x4000, 0x4000) },
        { name: "OS segment 2", bytesChanged: diffIn(0x20000, os2len) },
        ...anA.segments.filter(s => !s.error).map(s => ({
          name: s.name, bytesChanged: diffIn(s.start, s.length),
          calIdA: s.calId, calIdB: anB?.segments?.find(x => x.name === s.name)?.calId,
        })),
      ];
    }
    return send(200, out);
  }

  // ----- upload (raw body; metadata in query) -----
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const vehicle = q.get("vehicle"), kind = q.get("kind"), orig = q.get("name") || "file.bin";
    const ext = path.extname(orig).toLowerCase() || ".bin";
    const desc = slug(q.get("desc"));
    const date = q.get("date") || today();

    // A Math Lab parameter uploaded from the User Math tab: the XML is kept as
    // the loadable scanner artifact AND an entry is created here, since that's
    // where math lives now.
    if (kind === "mathparam") {
      const body = await readBody(req);
      if (!body.length) return send(400, { error: "empty upload" });
      const text = body.toString("utf8");
      if (scanner.detectType(orig, text) !== "math")
        return send(400, { error: "that isn't a Math Lab parameter — expected a .MathParameter.xml export" });
      const dir = safeJoin(REPO, path.join("vcm-scanner", "math"));
      await fsp.mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(orig));
      await fsp.writeFile(dest, body);

      const { dictionary, unitCodes } = await readScanner();
      const m = scanner.parseFile(path.basename(orig), text);
      const entry = mathParamToUserMath(m, path.basename(orig), dictionary, unitCodes);
      const data = await readUserMath();
      const i = data.parameters.findIndex(x => x.id === entry.id);
      const replaced = i >= 0;
      if (replaced) data.parameters[i] = { ...data.parameters[i], ...entry }; else data.parameters.push(entry);
      await writeUserMath(data);
      return send(200, { saved: path.relative(REPO, dest), id: entry.id, name: entry.name, replaced });
    }

    // VCM Scanner configs: type detected from the XML, filed by type,
    // original filename preserved so the scanner can load it back
    if (kind === "scanner") {
      const body = await readBody(req);
      if (!body.length) return send(400, { error: "empty upload" });
      const text = body.toString("utf8");
      const type = scanner.detectType(orig, text);
      if (!type) return send(400, { error: "not a recognised VCM Scanner file (expected Channels, Charts, Graphs, Layout or MathParameter XML)" });
      const folder = SCAN_FOLDERS[type];
      const dir = safeJoin(REPO, path.join("vcm-scanner", folder));
      await fsp.mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(orig));
      const existed = fs.existsSync(dest);
      await fsp.writeFile(dest, body);
      // record metadata so the platform filter has something to work with
      const idxFile = path.join(SCAN_DIR, "index.json");
      const idx = await readJsonOr(idxFile, { files: {} });
      idx.files ??= {};
      idx.files[path.basename(orig)] = {
        platform: q.get("platform") || null, vehicle: q.get("vehicle") || null,
        notes: q.get("notes") || "", added: today(),
        ...(existed ? { replaced: today() } : {}),
      };
      await fsp.writeFile(idxFile, JSON.stringify(idx, null, 2) + "\n");
      return send(200, { saved: path.relative(REPO, dest), size: body.length, type, replaced: existed });
    }

    // donor/practice files belong to no vehicle
    if (kind === "donor") {
      const body = await readBody(req);
      if (!body.length) return send(400, { error: "empty upload" });
      const ddir = safeJoin(REPO, "donor-files");
      await fsp.mkdir(ddir, { recursive: true });
      const base = slug(q.get("desc")) || path.basename(orig, ext);
      let dest = path.join(ddir, `${base}${ext}`);
      let n = 2;
      while (fs.existsSync(dest)) dest = path.join(ddir, `${base}-${n++}${ext}`);
      await fsp.writeFile(dest, body);
      return send(200, { saved: path.relative(REPO, dest), size: body.length, analysis: ext === ".bin" ? analyzeBuffer(body) : null });
    }

    // definitions are keyed by OS ID, not by vehicle
    if (kind === "definition") {
      const osid = (q.get("osid") || "").replace(/[^0-9A-Za-z_-]/g, "");
      if (!osid) return send(400, { error: "osid required for definitions" });
      const body = await readBody(req);
      if (!body.length) return send(400, { error: "empty upload" });
      const ddir = safeJoin(REPO, path.join("definitions", osid));
      await fsp.mkdir(ddir, { recursive: true });
      const dest = path.join(ddir, path.basename(orig));
      await fsp.writeFile(dest, body);
      // every OS folder gets a SOURCES.md scaffold — provenance matters for community XDFs
      const sources = path.join(ddir, "SOURCES.md");
      if (!fs.existsSync(sources)) {
        await fsp.writeFile(sources,
          `# Sources — OS ${osid}\n\n| File | Source (thread/URL) | Author | Added |\n|---|---|---|---|\n| ${path.basename(orig)} | *(fill in)* | | ${today()} |\n`);
      }
      return send(200, { saved: path.relative(REPO, dest), size: body.length });
    }

    const vdir = safeJoin(REPO, path.join("vehicles", vehicle || ""));
    if (!fs.existsSync(vdir)) return send(400, { error: `unknown vehicle: ${vehicle}` });
    const body = await readBody(req);
    if (!body.length) return send(400, { error: "empty upload" });

    // duplicate detection: identical bytes already checked in?
    const bodySha = crypto.createHash("sha256").update(body).digest("hex");
    if (kind === "stock" || kind === "tune") {
      const existing = [
        ...(await listFiles(path.join(vdir, "tunes"), { withHash: true })).filter(f => f.name !== "CHANGELOG.md"),
        ...(await listFiles(path.join(vdir, "tunes", "stock"), { withHash: true })),
      ];
      const dupe = existing.find(f => f.sha256 === bodySha);
      if (dupe) return send(409, { error: `identical file already checked in as ${dupe.name} — nothing new to save` });
    }

    let dest, rel;
    if (kind === "stock") {
      dest = path.join(vdir, "tunes", "stock", `stock_${date}_${desc || "full-read"}${ext}`);
      if (fs.existsSync(dest)) return send(409, { error: "a stock file with that name already exists — stock is never overwritten" });
    } else if (kind === "tune") {
      // optional rev override lets a second format (.bin + .hpt) attach to an existing revision
      let rev = q.get("rev");
      if (rev && !/^v\d{3}$/.test(rev)) return send(400, { error: "rev must look like v001" });
      if (!rev) rev = nextRev((await listFiles(path.join(vdir, "tunes"))));
      dest = path.join(vdir, "tunes", `${rev}_${date}_${desc || "revision"}${ext}`);
    } else if (kind === "datalog") {
      const rev = q.get("rev") || "v000";
      dest = path.join(vdir, "datalogs", `${date}_${rev}_${desc || "log"}${ext}`);
    } else return send(400, { error: "kind must be stock|tune|datalog" });

    await fsp.writeFile(dest, body, { flag: "wx" }).catch(async e => {
      if (e.code !== "EEXIST") throw e;
      dest = dest.replace(ext, `-${Date.now() % 10000}${ext}`);
      await fsp.writeFile(dest, body, { flag: "wx" });
    });
    rel = path.relative(REPO, dest);
    // Gen3 .bin uploads get analyzed on the way in (read-only; bad-read protection)
    let analysis = null;
    if (ext === ".bin") analysis = analyzeBuffer(body);

    // Cross-check the bin's VIN against the vehicle profile. A donor/practice
    // bin once sailed through as a "baseline" because nothing compared them.
    let vinCheck = null;
    if (analysis?.eeprom?.vin) {
      let profileVin = "";
      try {
        const vtext = await fsp.readFile(path.join(vdir, "vehicle.md"), "utf8");
        const row = vtext.match(/^\| VIN \| (.*?) \|$/m)?.[1]?.trim() || "";
        if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(row)) profileVin = row.toUpperCase();
      } catch {}
      vinCheck = profileVin
        ? (profileVin === analysis.eeprom.vin.toUpperCase()
            ? { status: "match", vin: analysis.eeprom.vin }
            : { status: "mismatch", vin: analysis.eeprom.vin, profileVin })
        : { status: "unknown", vin: analysis.eeprom.vin };
    }

    // Auto-complete the stock-read milestone only when the file is provably
    // this vehicle's: clean checksums AND a VIN matching the profile.
    let milestoneChecked = false;
    if (kind === "stock" && analysis?.checksumSummary === "all checksums OK" && vinCheck?.status === "match") {
      try {
        const pfile = path.join(REPO, "PROGRESSION.md");
        let ptext = await fsp.readFile(pfile, "utf8");
        const m = ptext.match(/^- \[ \] (Stock read archived[^\n]*)$/m);
        if (m) {
          ptext = ptext.replace(m[0], `- [x] ${m[1]}`);
          await fsp.writeFile(pfile, ptext);
          milestoneChecked = true;
        }
      } catch {}
    }
    return send(200, { saved: rel, size: body.length, analysis, vinCheck, milestoneChecked });
  }

  // ----- datalog CSV quick summary -----
  if (req.method === "GET" && url.pathname === "/api/logsummary") {
    const p = safeJoin(REPO, q.get("path") || "");
    if (path.extname(p).toLowerCase() !== ".csv")
      return send(200, { ok: false, reason: ".hpl is a proprietary format — export CSV from VCM Scanner / PCM Logger to analyze here" });
    const text = await fsp.readFile(p, "utf8");
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return send(200, { ok: false, reason: "no data rows" });
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const cols = headers.map(() => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 }));
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(",");
      for (let c = 0; c < Math.min(cells.length, cols.length, 40); c++) {
        const v = parseFloat(cells[c]);
        if (Number.isFinite(v)) {
          const s = cols[c];
          if (v < s.min) s.min = v;
          if (v > s.max) s.max = v;
          s.sum += v; s.n++;
        }
      }
    }
    // every channel carries the unit stated in its own header; converted
    // values additionally name the unit they came from
    const prefs = await readPrefs();
    const channels = headers.slice(0, 40).map((h, i) => {
      if (!cols[i].n) return { name: h, nonNumeric: true };
      const u = detectUnit(h);
      const native = u?.unit ?? null;
      const target = u?.convertible && u.quantity ? (prefs.units[u.quantity] || native) : native;
      const conv = v => (native && target && native !== target ? +convert(v, native, target).toFixed(3) : v);
      return {
        name: h, samples: cols[i].n, unit: target, nativeUnit: native,
        converted: !!(native && target && native !== target),
        min: conv(cols[i].min), max: conv(cols[i].max), avg: conv(cols[i].sum / cols[i].n),
      };
    });
    const timeCol = cols[headers.findIndex(h => /time|offset/i.test(h))];
    return send(200, {
      ok: true, rows: lines.length - 1, channels,
      durationSec: timeCol && timeCol.n ? +(timeCol.max - timeCol.min).toFixed(1) : null,
      durationUnit: "s",
    });
  }

  // everything below has a JSON body
  const jsonBody = async () => JSON.parse((await readBody(req)).toString("utf8") || "{}");

  // ----- changelog entry (prepended below the --- separator) -----
  if (req.method === "POST" && url.pathname === "/api/changelog") {
    const b = await jsonBody();
    const file = safeJoin(REPO, path.join("vehicles", b.vehicle, "tunes", "CHANGELOG.md"));
    let text = await fsp.readFile(file, "utf8");
    const entry = [
      `## ${b.rev} — ${b.date || today()} — ${b.title || ""}`.trimEnd(),
      `- **Base:** ${b.base || ""}`,
      `- **Changed:** ${b.changed || ""}`,
      `- **Why:** ${b.why || ""}`,
      `- **Result:** ${b.result || "(pending)"}`,
      "",
    ].join("\n");
    const sep = text.indexOf("\n---\n");
    text = sep >= 0
      ? text.slice(0, sep + 5) + "\n" + entry + text.slice(sep + 5)
      : text + "\n" + entry;
    // drop the placeholder line once real entries exist
    text = text.replace(/\n\*\(No revisions yet\..*?\)\*\n?/, "\n");
    await fsp.writeFile(file, text);
    return send(200, { ok: true });
  }

  // ----- session log -----
  if (req.method === "POST" && url.pathname === "/api/session") {
    const b = await jsonBody();
    const date = b.date || today();
    const dir = safeJoin(REPO, path.join("vehicles", b.vehicle, "sessions"));
    let file = path.join(dir, `${date}_session.md`);
    let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${date}_session-${n++}.md`);
    const md = [
      `# Tuning Session — ${date}`,
      "",
      `**Vehicle:** ${b.vehicle}`,
      `**Goal for this session:** ${b.goal || ""}`,
      `**Tune revision flashed:** ${b.rev || "—"}`,
      `**Tools used:** ${b.tools || ""}`,
      "",
      "## Datalogs captured",
      "",
      b.datalogs || "-",
      "",
      "## Observations",
      "",
      b.observations || "-",
      "",
      "## Changes made",
      "",
      b.changes || "-",
      "",
      "## Result",
      "",
      b.result || "-",
      "",
      "## Next steps",
      "",
      b.next || "-",
      "",
      "## Concepts practiced (update PROGRESSION.md)",
      "",
      b.concepts || "-",
      "",
    ].join("\n");
    await fsp.writeFile(file, md);
    return send(200, { saved: path.relative(REPO, file) });
  }

  // ----- VCM Scanner: add/remove a manual dictionary entry -----
  // Manual entries survive regeneration and win over harvested ones, so a name
  // read off the scanner's parameter list can be recorded without charting it.
  if (req.method === "POST" && url.pathname === "/api/scanner-dictionary") {
    const b = await jsonBody();
    const file = path.join(SCAN_DIR, "channel-dictionary.json");
    const dict = await readJsonOr(file, { generated: {}, manual: {} });
    dict.manual ??= {};
    const id = String(b.parameterID || "").trim();
    if (!/^\d+$/.test(id)) return send(400, { error: "parameter ID must be numeric" });
    if (b.delete) {
      delete dict.manual[id];
    } else {
      if (!b.label?.trim()) return send(400, { error: "a name is required" });
      dict.manual[id] = {
        parameterID: id, label: b.label.trim(),
        unitIds: b.unitId ? [String(b.unitId).trim()] : [],
        sources: ["manual entry"],
        notes: b.notes || "",
      };
    }
    await fsp.writeFile(file, JSON.stringify(dict, null, 2) + "\n");
    return send(200, { ok: true, manualCount: Object.keys(dict.manual).length });
  }

  // ----- VCM Scanner: one file, fully decoded -----
  if (req.method === "GET" && url.pathname === "/api/scanner-file") {
    const rel = q.get("path") || "";
    const p = safeJoin(REPO, rel);
    if (!fs.existsSync(p)) return send(404, { error: "file not found" });
    const { dictionary, unitCodes } = await readScanner();
    const parsed = scanner.parseFile(path.basename(p), await fsp.readFile(p, "utf8"));
    if (parsed.type === "channels") parsed.decodedChannels = scanner.decodeChannels(parsed, dictionary);
    if (parsed.type === "math") parsed.decoded = scanner.decodeExpression(parsed.expression, dictionary, unitCodes);
    return send(200, { ok: true, file: rel, ...parsed });
  }

  // ----- VCM Scanner: import a math parameter into the User Math repo -----
  if (req.method === "POST" && url.pathname === "/api/scanner-import-math") {
    const b = await jsonBody();
    const p = safeJoin(REPO, b.path || "");
    if (!fs.existsSync(p)) return send(404, { error: "file not found" });
    const m = scanner.parseFile(path.basename(p), await fsp.readFile(p, "utf8"));
    if (m.type !== "math") return send(400, { error: "that file is not a Math Lab parameter" });
    const { dictionary, unitCodes } = await readScanner();
    const entry = mathParamToUserMath(m, path.basename(p), dictionary, unitCodes);
    const data = await readUserMath();
    if (data.parameters.some(x => x.id === entry.id))
      return send(409, { error: `${entry.name} is already in the User Math repository` });
    data.parameters.push(entry);
    await writeUserMath(data);
    return send(200, { ok: true, id: entry.id, name: entry.name });
  }

  // ----- export a User Math entry as a VCM Scanner Math Lab parameter -----
  // Completes the round trip: write a formula here, load it in the scanner.
  if (req.method === "GET" && url.pathname === "/api/usermath-export") {
    const data = await readUserMath();
    const p = data.parameters.find(x => x.id === q.get("id"));
    if (!p) return send(404, { error: "no such user math parameter" });
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xA;");
    // recover the numeric HPT unit code if the entry carries one
    const unitCode = String(p.units || "").match(/unit code (\d+)/)?.[1] || "";
    const decimals = String(p.notes || "").match(/(\d+) decimals/)?.[1] || "2";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MathParameter Notes="${esc(p.notes)}" Decimals="${esc(decimals)}" Unit="${esc(unitCode)}" Expression="${esc(p.expression)}" Abbreviation="" Name="${esc(p.name)}" />\n`;
    const filename = `${slug(p.name) || "parameter"}.MathParameter.xml`;
    res.writeHead(200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    });
    return res.end(xml);
  }

  // ----- preferences -----
  if (req.method === "GET" && url.pathname === "/api/preferences") {
    return send(200, { preferences: await readPrefs(), quantities: QUANTITIES });
  }
  if (req.method === "POST" && url.pathname === "/api/preferences") {
    const b = await jsonBody();
    const cur = await readPrefs();
    const units = { ...cur.units };
    for (const [q, u] of Object.entries(b.units || {})) {
      if (!QUANTITIES[q]) return send(400, { error: `unknown quantity: ${q}` });
      if (!QUANTITIES[q].units.includes(u)) return send(400, { error: `${u} is not a valid unit for ${q}` });
      units[q] = u;
    }
    const next = { ...cur, units };
    await writePrefs(next);
    return send(200, { preferences: next });
  }

  // ----- XDF: list tables in a definition -----
  if (req.method === "GET" && url.pathname === "/api/xdf") {
    const p = safeJoin(REPO, q.get("path") || "");
    if (!fs.existsSync(p)) return send(404, { error: "definition not found" });
    try {
      const parsed = parseXdf(await fsp.readFile(p, "utf8"));
      // keep the payload small — full axis detail comes with /api/xdf-table
      return send(200, {
        ok: true, file: path.relative(REPO, p),
        title: parsed.title, description: parsed.description,
        baseOffset: parsed.baseOffset, tableCount: parsed.tableCount, constantCount: parsed.constantCount,
        tables: parsed.tables.map(t => ({
          id: t.id, title: t.title, categories: t.categories, rows: t.rows, cols: t.cols,
          address: t.z?.address, bits: t.z?.bits, units: t.z?.units,
          signed: t.z?.signed, lsbFirst: t.z?.lsbFirst, layoutAmbiguous: t.z?.layoutAmbiguous,
        })),
        constants: parsed.constants.map(c => ({ id: c.id, title: c.title, units: c.units, address: c.address })),
      });
    } catch (e) { return send(200, { ok: false, reason: "could not parse this XDF: " + e.message }); }
  }

  // ----- XDF + bin: render one table's values -----
  if (req.method === "GET" && url.pathname === "/api/xdf-table") {
    const xp = safeJoin(REPO, q.get("xdf") || ""), bp = safeJoin(REPO, q.get("bin") || "");
    if (!fs.existsSync(xp) || !fs.existsSync(bp)) return send(404, { error: "xdf or bin not found" });
    const parsed = parseXdf(await fsp.readFile(xp, "utf8"));
    const table = parsed.tables.find(t => t.id === q.get("id")) || parsed.tables[Number(q.get("index") || 0)];
    if (!table) return send(404, { error: "table not found in this definition" });
    const buf = await fsp.readFile(bp);
    return send(200, { ok: true, table: readTable(buf, table),
      note: "Values are read through the XDF — a definition written for a different OS will produce confident nonsense. Draft readings." });
  }

  // ----- vehicle timeline -----
  if (req.method === "GET" && url.pathname === "/api/timeline") {
    const id = q.get("vehicle") || "";
    if (!fs.existsSync(safeJoin(REPO, path.join("vehicles", id)))) return send(400, { error: `unknown vehicle: ${id}` });
    return send(200, { vehicle: id, ...(await buildTimeline(id)) });
  }

  // ----- datalog analysis: filtered trim bins + heat map -----
  if (req.method === "GET" && url.pathname === "/api/loganalysis") {
    const p = safeJoin(REPO, q.get("path") || "");
    if (path.extname(p).toLowerCase() !== ".csv")
      return send(200, { ok: false, reason: "analysis needs a CSV — export one from VCM Scanner (Scan → Export)" });
    if (!fs.existsSync(p)) return send(404, { error: "file not found" });
    const text = await fsp.readFile(p, "utf8");
    // channel overrides arrive as ch_<role>=<column index>
    const channels = {};
    for (const [k, v] of q.entries()) {
      if (!k.startsWith("ch_")) continue;
      const role = k.slice(3);
      channels[role] = (role === "ltft" || role === "stft") ? v.split(",").map(Number) : Number(v);
    }
    const opts = { channels };
    if (q.get("binSize")) opts.binSize = Number(q.get("binSize"));
    if (q.get("minSamples")) opts.minSamples = Number(q.get("minSamples"));
    const filters = {};
    for (const f of ["minEct", "maxTpsDelta", "maxRpmDelta", "minRpm"]) if (q.get(f)) filters[f] = Number(q.get(f));
    if (q.get("requireClosedLoop") === "0") filters.requireClosedLoop = false;
    if (q.get("excludePe") === "0") filters.excludePe = false;
    if (q.get("minEctUnit")) filters.minEctUnit = q.get("minEctUnit");
    if (Object.keys(filters).length) opts.filters = filters;
    // wideband options: fuel decides the lambda↔AFR conversion, scale resolves
    // the lambda-vs-EQ ambiguity a log can't express
    const prefsNow = await readPrefs();
    opts.fuel = q.get("fuel") || prefsNow.fuel || "gasoline";
    for (const k of ["widebandScale", "commandedScale"]) if (q.get(k)) opts[k] = q.get(k);
    for (const k of ["wotTps", "wotLeanLambda"]) if (q.get(k)) opts[k] = Number(q.get(k));
    return send(200, { ok: true, file: path.relative(REPO, p), preferences: await readPrefs(), ...analyzeLog(text, opts) });
  }

  // ----- pre-flash checklist (parsed from the template) -----
  if (req.method === "GET" && url.pathname === "/api/checklist") {
    return send(200, { sections: await readChecklist() });
  }

  // ----- record a flash (checklist-gated) -----
  if (req.method === "POST" && url.pathname === "/api/flashed") {
    const b = await jsonBody();
    const vdir = safeJoin(REPO, path.join("vehicles", b.vehicle || ""));
    if (!fs.existsSync(vdir)) return send(400, { error: `unknown vehicle: ${b.vehicle}` });
    if (!b.rev) return send(400, { error: "which revision was flashed?" });

    // Enforcement, not decoration: re-parse the template and require every item.
    // A client that skips the UI still cannot record a flash.
    const sections = await readChecklist();
    const required = sections.flatMap(s => s.items.map(i => i.id));
    const checked = new Set(Array.isArray(b.checked) ? b.checked : []);
    const missing = required.filter(id => !checked.has(id));
    if (missing.length) {
      const labels = sections.flatMap(s => s.items).filter(i => missing.includes(i.id)).map(i => i.label);
      return send(400, { error: "pre-flash checklist incomplete", missing, missingLabels: labels });
    }

    const date = b.date || today();
    await updateVehicleBullet(vdir, "Current tune revision", `${b.rev} (flashed ${date})`);
    await updateVehicleBullet(vdir, "Last flashed", date);

    // flash log — one row per flash, created on first use
    const logFile = path.join(vdir, "flash-log.md");
    const row = `| ${date} | ${b.rev} | ${(b.adapter || "your proven write interface").replace(/\|/g, "/")} | ${(b.notes || "").replace(/\|/g, "/") || "—"} |`;
    if (fs.existsSync(logFile)) {
      const text = (await fsp.readFile(logFile, "utf8")).trimEnd();
      await fsp.writeFile(logFile, text + "\n" + row + "\n");
    } else {
      await fsp.writeFile(logFile,
        `# Flash log — ${b.vehicle}\n\nEvery write recorded here, newest at the bottom. Written by the app only\nafter the full pre-flash checklist has been completed.\n\n| Date | Revision | Adapter | Notes |\n|---|---|---|---|\n${row}\n`);
    }

    // first recorded flash ticks the milestone — proven fact, same rule as the stock read
    let milestoneChecked = false;
    try {
      const pfile = path.join(REPO, "PROGRESSION.md");
      let ptext = await fsp.readFile(pfile, "utf8");
      const m = ptext.match(/^- \[ \] (First successful flash[^\n]*)$/m);
      if (m) {
        ptext = ptext.replace(m[0], `- [x] ${m[1]}`);
        await fsp.writeFile(pfile, ptext);
        milestoneChecked = true;
      }
    } catch {}

    return send(200, { ok: true, rev: b.rev, date, milestoneChecked });
  }

  // ----- relocate a misfiled upload into donor-files/ -----
  // The only sanctioned way to move a file out of a vehicle's tunes/ — it logs
  // the move in the donor README so the reason survives.
  if (req.method === "POST" && url.pathname === "/api/relocate") {
    const b = await jsonBody();
    const from = safeJoin(REPO, b.from || "");
    if (!fs.existsSync(from)) return send(404, { error: "file not found" });
    if (!/[\\/]vehicles[\\/]/.test(from)) return send(400, { error: "only files under vehicles/ can be relocated" });
    const ddir = safeJoin(REPO, "donor-files");
    await fsp.mkdir(ddir, { recursive: true });
    let dest = path.join(ddir, path.basename(from));
    let n = 2;
    while (fs.existsSync(dest)) {
      const e = path.extname(from);
      dest = path.join(ddir, `${path.basename(from, e)}-${n++}${e}`);
    }
    await fsp.rename(from, dest);
    const readme = path.join(ddir, "README.md");
    const HEADING = "## Moves log";
    const row = `| ${today()} | \`${path.basename(dest)}\` | \`${path.relative(REPO, from)}\` | ${(b.reason || "not this vehicle's file").replace(/\|/g, "/")} |`;
    const table = `${HEADING}\n\nFiles relocated here out of a vehicle folder, and why.\n\n| Date | File | Was | Reason |\n|---|---|---|---|\n${row}\n`;
    try {
      let text = await fsp.readFile(readme, "utf8");
      text = text.includes(HEADING)
        ? text.trimEnd() + "\n" + row + "\n"     // append under the existing table
        : text.trimEnd() + "\n\n" + table;        // create the section once
      await fsp.writeFile(readme, text);
    } catch { await fsp.writeFile(readme, `# Donor / practice files\n\n${table}`); }
    return send(200, { moved: path.relative(REPO, dest) });
  }

  // ----- create a vehicle -----
  // Scaffolds the same structure the repo conventions expect, from the
  // template, so a second car starts life identical to the first.
  if (req.method === "POST" && url.pathname === "/api/vehicle") {
    const b = await jsonBody();
    const id = slug(b.id || `${b.year || ""}-${b.model || ""}-${b.engine || ""}`);
    if (!id || id === "untitled") return send(400, { error: "give the vehicle a name (year-model-engine works well)" });
    const dir = safeJoin(REPO, path.join("vehicles", id));
    if (fs.existsSync(dir)) return send(409, { error: `a vehicle folder named ${id} already exists` });

    for (const sub of ["tunes/stock", "datalogs", "sessions"]) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true });
      await fsp.writeFile(path.join(dir, sub, ".gitkeep"), "");
    }

    let profile = await fsp.readFile(path.join(REPO, "templates", "vehicle-profile.md"), "utf8");
    const title = [b.year, b.make, b.model].filter(Boolean).join(" ") || id;
    profile = profile.replace(/^# .*$/m, `# ${title}`);
    const setRow = (label, value) => {
      if (!value) return;
      const re = new RegExp(`^\\| ${label} \\| .*\\|$`, "m");
      if (re.test(profile)) profile = profile.replace(re, `| ${label} | ${String(value).replace(/\|/g, "/")} |`);
    };
    setRow("Year / Model", [b.year, b.model].filter(Boolean).join(" "));
    setRow("Engine", b.engine);
    setRow("Transmission", b.transmission);
    setRow("PCM / ECU", b.pcm);
    setRow("VIN", b.vin);
    setRow("Fuel", b.fuel);
    if (b.notes) profile += `\n## Notes\n\n${b.notes}\n`;
    await fsp.writeFile(path.join(dir, "vehicle.md"), profile);

    await fsp.writeFile(path.join(dir, "tunes", "CHANGELOG.md"),
      `# Tune Changelog — ${title}\n\nNewest at the top. One entry per revision, written **before** flashing.\n\nFormat:\n\n\`\`\`\n## vNNN — YYYY-MM-DD — short description\n- **Base:** (stock | vNNN it was copied from)\n- **Changed:** table(s), axis range, before → after values\n- **Why:** what the datalog/observation showed\n- **Result:** (fill in after driving/logging on it)\n\`\`\`\n\n---\n\n*(No revisions yet. The first entry should be the archived stock read.)*\n`);

    return send(200, { ok: true, id, title, next: "Archive the stock read before changing anything." });
  }

  // ----- vehicle profile field update (targeted table-row replace) -----
  if (req.method === "POST" && url.pathname === "/api/vehicle-field") {
    const b = await jsonBody();
    const file = safeJoin(REPO, path.join("vehicles", b.vehicle || "", "vehicle.md"));
    let text = await fsp.readFile(file, "utf8");
    const field = String(b.field || "");
    const re = new RegExp(`^\\| ${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| .*\\|$`, "m");
    if (!re.test(text)) return send(400, { error: `field row not found in vehicle.md: ${field}` });
    text = text.replace(re, `| ${field} | ${String(b.value || "").replace(/\|/g, "/")} |`);
    await fsp.writeFile(file, text);
    return send(200, { ok: true });
  }

  // ----- progression update -----
  if (req.method === "POST" && url.pathname === "/api/progression") {
    await updateProgression(await jsonBody());
    return send(200, { ok: true });
  }

  // ----- user math CRUD -----
  if (req.method === "POST" && url.pathname === "/api/usermath") {
    const b = await jsonBody();
    const data = await readUserMath();
    if (b.delete) {
      data.parameters = data.parameters.filter(p => p.id !== b.id);
    } else {
      const entry = {
        id: b.id || slug(b.name) + "-" + Date.now().toString(36),
        name: b.name || "Unnamed",
        category: b.category || "General",
        expression: b.expression || "",
        units: b.units || "",
        inputs: b.inputs || "",
        notes: b.notes || "",
        source: b.source || "",
        status: b.status || "unverified",
        updated: today(),
      };
      const i = data.parameters.findIndex(p => p.id === entry.id);
      if (i >= 0) data.parameters[i] = entry; else data.parameters.push(entry);
    }
    await writeUserMath(data);
    return send(200, { ok: true });
  }

  // ----- git commit + push / sync (fetch + ff-only pull) -----
  if (req.method === "POST" && url.pathname === "/api/git") {
    const b = await jsonBody();
    if (b.action === "commit-push") {
      await git("add", "-A");
      const msg = (b.message || "app: update").slice(0, 200) +
        "\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>";
      const commit = await git("commit", "-m", msg);
      // a failed commit must never masquerade as success: push says
      // "Everything up-to-date" even when the commit silently failed
      if (!commit.ok && !/nothing to commit/i.test(commit.out)) {
        const hint = /author identity unknown|please tell me who you are/i.test(commit.out)
          ? ' — run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"'
          : "";
        return send(200, { committed: false, pushed: false, error: commit.out.split("\n").slice(0, 3).join(" ") + hint });
      }
      const push = await git("push");
      return send(200, {
        committed: commit.ok, commit: commit.out,
        pushed: push.ok, push: push.out,
        error: push.ok ? null : "push failed: " + push.out.split("\n").slice(-2).join(" "),
      });
    }
    if (b.action === "sync") {
      const fetch_ = await git("fetch", "--quiet");
      if (!fetch_.ok) return send(200, { synced: false, message: "Fetch failed — offline? (" + fetch_.out.split("\n")[0] + ")" });
      const dirty = (await git("status", "--porcelain")).out;
      let { ahead, behind } = await syncCounts();
      if (!behind) return send(200, { synced: true, message: ahead ? `Up to date with GitHub — ${ahead} commit(s) ready to push` : "Up to date with GitHub" });
      if (dirty) return send(200, { synced: false, message: `Behind GitHub by ${behind} commit(s), but there are uncommitted changes here — commit & push first, then sync` });
      const pull = await git("pull", "--ff-only");
      if (!pull.ok) return send(200, { synced: false, message: "Pull failed: " + pull.out.split("\n")[0] });
      return send(200, { synced: true, message: `Pulled ${behind} commit(s) from GitHub` });
    }
    return send(400, { error: "unknown action" });
  }

  send(404, { error: "no such endpoint" });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    // static frontend
    let rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const p = safeJoin(PUBLIC, rel);
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "content-type": MIME[path.extname(p)] || "application/octet-stream",
      "cache-control": "no-store", // repo app: always serve the current file
    });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tuning app on http://localhost:${PORT}  (repo: ${REPO})`);
});

// On startup: fetch, and fast-forward automatically when it's unambiguously safe
// (clean tree, nothing local to push). Otherwise leave it to the Sync button.
(async () => {
  const f = await git("fetch", "--quiet");
  if (!f.ok) return console.log("startup fetch failed (offline?) — working from local state");
  const dirty = (await git("status", "--porcelain")).out;
  const { ahead, behind } = await syncCounts();
  if (behind && !dirty && !ahead) {
    const p = await git("pull", "--ff-only");
    console.log(p.ok ? `auto-pulled ${behind} commit(s) from GitHub` : "auto-pull failed: " + p.out.split("\n")[0]);
  } else if (behind) {
    console.log(`repo is ${behind} commit(s) behind GitHub — local work present, sync from the app when ready`);
  }
})();
