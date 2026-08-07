// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// VCM Scanner configuration files — read-only parsing.
//
// These files are ID-based: a Channels.xml is a list of bare ParameterID
// numbers with no names. Charts/Graphs/Layout files DO carry
// <Label>+<ParameterID>+<Unit>, so a dictionary built from those decodes the
// rest. Math expressions use [ParameterID.UnitID] syntax.
//
// Nothing here writes to a config file — VCM Scanner owns those.

import { parseXml } from "./xdf.mjs";   // same dependency-free parser, no second one

const kids = (n, tag) => n.children.filter(c => c.tag.toLowerCase() === tag.toLowerCase());
const kid = (n, tag) => kids(n, tag)[0];
const txt = (n, tag) => kid(n, tag)?.text?.trim() ?? "";

export const TYPES = ["channels", "charts", "graphs", "layouts", "math"];
export const TYPE_DIR = { channels: "channels", charts: "charts", graphs: "graphs", layout: "layouts", math: "math" };

/** HH:MM:SS.fffffff → milliseconds */
function intervalMs(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Math.round((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000);
}

export function detectType(filename, xmlText) {
  const root = (xmlText.match(/<([A-Za-z]+)[\s>]/g) || [])
    .map(s => s.replace(/[<>\s]/g, ""))
    .find(t => !/^\?xml$/i.test(t));
  const byRoot = { channels: "channels", charts: "charts", graphs: "graphs",
                   documentcontents: "layout", mathparameter: "math" };
  if (root && byRoot[root.toLowerCase()]) return byRoot[root.toLowerCase()];
  const f = filename.toLowerCase();
  for (const t of ["channels", "charts", "graphs"]) if (f.includes("." + t)) return t;
  if (f.includes(".layout")) return "layout";
  if (f.includes(".mathparameter")) return "math";
  return null;
}

// ---------- per-type parsers ----------

export function parseChannels(doc) {
  const root = kid(doc, "Channels") || doc;
  const channels = [], userDevices = [];
  for (const c of kids(root, "channel")) {
    const a = c.attrs;
    const entry = {
      parameterID: a.ParameterID || null,
      intervalMs: intervalMs(a.Interval),
      transformID: a.TransformID || null,
      address: a.Address || null,
    };
    const up = kid(c, "UserParameter");
    if (up) {
      // externally wired sensors (wideband, EGT…) — worth surfacing loudly
      entry.userDevice = {
        manufacturer: up.attrs.DeviceManufacturer || "",
        device: up.attrs.DeviceName || "",
        canBus: up.attrs.CANBus ?? null,
        offset: up.attrs.ParameterOffset ?? null,
        size: up.attrs.ParameterSize ?? null,
        dataType: up.attrs.dataType ?? null,
        scalingPerBit: up.attrs.scalingPerBit ?? null,
        unitId: up.attrs.unit ?? null,
      };
      userDevices.push({ parameterID: entry.parameterID, ...entry.userDevice });
    }
    channels.push(entry);
  }
  // "28 @ 100 ms, 9 @ 200 ms…" — how hard the bus is being worked
  const rates = {};
  for (const c of channels) if (c.intervalMs != null) rates[c.intervalMs] = (rates[c.intervalMs] || 0) + 1;
  return {
    channelCount: channels.length,
    channels,
    userDevices,
    rateSummary: Object.entries(rates).sort((a, b) => +a[0] - +b[0])
      .map(([ms, n]) => ({ intervalMs: +ms, count: n })),
  };
}

/** <Series> (charts) and <Table> (graphs) share the label/parameter shape. */
function readLabelled(node) {
  return {
    label: txt(node, "Label"),
    parameterID: txt(node, "ParameterID") || null,
    unitId: txt(node, "Unit") || null,
    decimals: txt(node, "Decimals") || null,
    maximum: txt(node, "Maximum") || null,
    high: txt(node, "HighValue") || null,
    middle: txt(node, "MiddleValue") || null,
    low: txt(node, "LowValue") || null,
    columnParameterID: txt(node, "ColumnParameterID") || null,
    columnUnitId: txt(node, "ColumnUnit") || null,
  };
}

export function parseCharts(doc) {
  const root = kid(doc, "Charts") || doc;
  const charts = kids(root, "Chart").map(c => ({ series: kids(c, "Series").map(readLabelled) }));
  return { chartCount: charts.length, charts, seriesCount: charts.reduce((n, c) => n + c.series.length, 0) };
}

export function parseGraphs(doc) {
  const root = kid(doc, "Graphs") || doc;
  const tables = kids(root, "Table").map(readLabelled);
  return { tableCount: tables.length, tables };
}

/** A Layout is a container of panes, each holding graphs and/or charts. */
export function parseLayout(doc) {
  const root = kid(doc, "DocumentContents") || doc;
  const panes = kids(root, "Content").map(c => ({
    id: c.attrs.ID, name: c.attrs.Name || c.attrs.Text || "",
    tables: kids(c, "Table").map(readLabelled),
    series: kids(c, "Chart").flatMap(ch => kids(ch, "Series").map(readLabelled))
      .concat(kids(c, "Series").map(readLabelled)),
  }));
  return {
    paneCount: panes.length, panes,
    tableCount: panes.reduce((n, p) => n + p.tables.length, 0),
    seriesCount: panes.reduce((n, p) => n + p.series.length, 0),
  };
}

export function parseMath(doc) {
  const m = kid(doc, "MathParameter") || doc.children[0];
  const a = m?.attrs || {};
  const expression = (a.Expression || "").replace(/\r?\n+/g, " ").trim();
  // [ParameterID] or [ParameterID.UnitID]
  const refs = [...expression.matchAll(/\[(\d+)(?:\.(\d+))?\]/g)]
    .map(x => ({ token: x[0], parameterID: x[1], unitId: x[2] || null }));
  return {
    name: a.Name || "", abbreviation: a.Abbreviation || "", notes: a.Notes || "",
    expression, unitId: a.Unit || null, decimals: a.Decimals || null,
    references: refs,
    uniqueParameterIDs: [...new Set(refs.map(r => r.parameterID))],
  };
}

export function parseFile(filename, xmlText) {
  const type = detectType(filename, xmlText);
  const doc = parseXml(xmlText);
  const base = { filename, type };
  switch (type) {
    case "channels": return { ...base, ...parseChannels(doc) };
    case "charts":   return { ...base, ...parseCharts(doc) };
    case "graphs":   return { ...base, ...parseGraphs(doc) };
    case "layout":   return { ...base, ...parseLayout(doc) };
    case "math":     return { ...base, ...parseMath(doc) };
    default:         return { ...base, error: "unrecognised VCM Scanner file type" };
  }
}

// ---------- channel dictionary ----------
// Built from the labelled files only. Coverage is therefore partial and
// entirely dependent on what user has charted — that is stated in the UI.

export function buildDictionary(parsedFiles) {
  const dict = {};
  const add = (entry, source) => {
    if (!entry.parameterID || !entry.label) return;
    const id = entry.parameterID;
    dict[id] ??= { parameterID: id, label: entry.label, unitIds: [], sources: [] };
    if (entry.unitId && !dict[id].unitIds.includes(entry.unitId)) dict[id].unitIds.push(entry.unitId);
    if (!dict[id].sources.includes(source)) dict[id].sources.push(source);
    // prefer the longer label — usually the more descriptive one
    if (entry.label.length > dict[id].label.length) dict[id].label = entry.label;
  };
  for (const f of parsedFiles) {
    const src = f.filename;
    if (f.type === "charts") for (const c of f.charts) c.series.forEach(s => add(s, src));
    if (f.type === "graphs") f.tables.forEach(t => add(t, src));
    if (f.type === "layout") for (const p of f.panes) { p.tables.forEach(t => add(t, src)); p.series.forEach(s => add(s, src)); }
  }
  return dict;
}

/** Substitute names where the dictionary knows them; leave the rest raw. */
export function decodeExpression(expression, dict, unitCodes = {}) {
  if (!expression) return { decoded: "", unknown: [] };
  const unknown = new Set();
  const decoded = expression.replace(/\[(\d+)(?:\.(\d+))?\]/g, (raw, id, unit) => {
    const hit = dict[id];
    if (!hit) { unknown.add(id); return raw; }
    // append the unit only when it's actually known and adds information —
    // "?" is a placeholder for an un-inferred code, and "[RPM RPM]" is noise
    const sym = unit ? unitCodes[unit]?.symbol : null;
    const useful = sym && sym !== "?" && !new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hit.label);
    return `[${hit.label.trim()}${useful ? ` ${sym}` : ""}]`;
  });
  return { decoded, unknown: [...unknown] };
}

export function decodeChannels(parsed, dict) {
  return parsed.channels.map(c => ({
    ...c,
    label: dict[c.parameterID]?.label || null,
    known: !!dict[c.parameterID],
  }));
}
