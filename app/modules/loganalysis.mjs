// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Datalog analysis — CSV in, binned statistics out. Pure functions, no I/O.
//
// Everything here produces *draft readings for review*. Nothing it computes is
// ever written into a tune: the MAF suggestion is a table to apply by hand in
// HP Tuners, after you agree with it.

import { detectUnit, convert, requireUnit } from "./units.mjs";

// ---------- channel detection ----------
// VCM Scanner column names vary by layout and are user-editable, so match
// loosely and always let the caller override.
const PATTERNS = {
  time:        [/^time/i, /offset/i, /elapsed/i],
  rpm:         [/engine\s*speed/i, /\brpm\b/i],
  // HP Tuners calls these "Mass Airflow Sensor" (Hz) and "Mass Airflow (SAE)"
  // (lb/min) — neither contains "MAF", and the two are told apart only by
  // their unit, so the frequency channel is matched on its declared [Hz].
  mafHz:       [/maf.*(freq|hz)/i, /\bmaf\s*hz\b/i, /mass\s*air\s*flow.*\[\s*hz\s*\]/i],
  mafGs:       [/maf.*(g\/s|gps|g per|airflow|air flow)/i, /mass\s*air\s*flow\b(?!.*\[\s*hz\s*\])/i],
  ltft:        [/ltft/i, /long\s*term.*(fuel|trim)/i],
  stft:        [/stft/i, /short\s*term.*(fuel|trim)/i],
  ect:         [/\bect\b/i, /coolant/i],
  iat:         [/\biat\b/i, /intake\s*air\s*temp/i],
  tps:         [/\btps\b/i, /throttle\s*position/i, /pedal/i],
  map:         [/\bmap\b/i, /manifold\s*abs/i],
  load:        [/\bload\b/i, /cylinder\s*airmass/i, /air\s*mass/i],
  // The PCM's final airflow figure. On a MAF-primary Gen 3 tune it tracks the
  // MAF closely; where it does not, the speed-density (VE) side is contributing
  // — which is exactly the handoff worth seeing.
  dynAir:      [/dyn(amic)?\s*air/i],
  pe:          [/power\s*enrich/i, /\bpe\b/i],
  closedLoop:  [/closed.?loop/i, /fuel\s*sys/i, /\bcl\b/i],
  knockRetard: [/knock\s*retard/i, /\bkr\b/i],
  spark:       [/spark\s*adv/i, /ignition\s*timing/i, /timing\s*adv/i],
  // HP Tuners writes the noun first ("Equivalence Ratio Commanded"), so match
  // both word orders rather than assuming "commanded" comes first.
  commandedAfr:[/commanded.*(afr|equiv|lambda)/i, /\beq\s*cmd\b/i, /afr.*(cmd|command)/i, /target.*(afr|lambda)/i,
                /(equiv|lambda|air-?fuel\s*ratio).*command/i],
  // On Gen III there is no CAN wideband: the controller feeds the MPVI's
  // analog input over the ProLink cable, and VCM Scanner names that channel
  // after the DEVICE — "MPVI2.1 -> AEM 30-(03x0,2340,5130)" — with no "AFR",
  // "UEGO" or "wideband" anywhere in it. Match the common controllers by name.
  widebandAfr: [/wideband/i, /wb.*afr/i, /afr.*wide/i, /\bafr\b/i, /\blambda\b/i, /\beq\s*act\b/i, /uego/i, /\bo2.*wide/i,
                /\baem\b/i, /afr\s*500/i, /innovate/i, /\blc-?[12]\b/i, /\bmtx-?l\b/i, /zeitronix/i,
                /ballenger/i, /\bplx\b/i, /spartan/i, /14\s*point\s*7/i],
};

// Fuel chemistry. Stoichiometric AFR depends on the fuel, so lambda↔AFR
// conversion is fuel-dependent and must never be hard-coded to gasoline.
export const FUELS = {
  gasoline: { label: "Gasoline (E10 pump)", stoich: 14.7 },
  e85:      { label: "E85", stoich: 9.765 },
  e50:      { label: "E50 blend", stoich: 11.7 },
  methanol: { label: "Methanol (M100)", stoich: 6.4 },
};

// Every column matching each role, in order. analyze() needs the full list
// because the FIRST match is not always the live one: a log can carry three
// wideband channels where only the third reports.
export function detectCandidates(headers) {
  const found = {};
  for (const [role, pats] of Object.entries(PATTERNS)) {
    const idxs = headers.map((h, i) => ({ h, i })).filter(({ h }) => pats.some(p => p.test(h))).map(({ i }) => i);
    if (idxs.length) found[role] = idxs;
  }
  return found;
}

export function detectChannels(headers) {
  const found = {};
  for (const [role, pats] of Object.entries(PATTERNS)) {
    // bank-specific trims: collect every match so both banks can be averaged
    const idxs = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => pats.some(p => p.test(h)))
      .map(({ i }) => i);
    if (idxs.length) found[role] = role === "ltft" || role === "stft" ? idxs : idxs[0];
  }
  return found;
}

// ---------- CSV parsing ----------
// Two shapes turn up in practice and they are nothing alike:
//
//   plain      one header row, every row carries every channel.
//
//   HP Tuners  a preamble ([Log Information], [Channel Information],
//              [Channel Data]) followed by SPARSE rows — each channel logs on
//              its own interval, so a row holds only the channels that ticked.
//              In a real 42-channel log, no row carried both RPM and STFT.
//
// Reading an HP Tuners file as plain CSV silently yields one column named
// "HP Tuners CSV Log File" and zero detected channels, which is how this went
// unnoticed until a real export was tried. Sparse files must be run through
// densify() before any row-wise filtering.
const splitCsv = l => l.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
const toNum = c => { const v = parseFloat(c); return Number.isFinite(v) ? v : c; };

// Channel names can contain unquoted commas. A real export carried
// "MPVI2.1 -> AEM 30-(03x0,2340,5130)" — the device's part numbers — which
// splits into three fields and pushes the names row out of step with the IDs,
// units and data rows. Rejoin by balancing brackets until the count matches.
// That one sat last so only its own name was mangled, but a comma-bearing name
// mid-list would misalign every channel after it.
function rejoinNames(fields, target) {
  if (!target || fields.length <= target) return fields;
  const depthOf = s => (s.match(/[([]/g) || []).length - (s.match(/[)\]]/g) || []).length;
  const out = [];
  let buf = null, depth = 0;
  for (const f of fields) {
    if (buf === null) {
      const d = depthOf(f);
      if (d > 0) { buf = f; depth = d; } else out.push(f);
    } else {
      buf += "," + f; depth += depthOf(f);
      if (depth <= 0) { out.push(buf); buf = null; depth = 0; }
    }
  }
  if (buf !== null) out.push(buf);
  // still too many: fold the tail into the last column rather than misalign
  while (out.length > target) out.splice(target - 1, 2, out[target - 1] + "," + out[target]);
  return out;
}

// HP Tuners states units in their own row rather than in the channel name.
// Everything downstream (the ECT threshold, the wideband scale) reads units
// out of the header text, so fold them in: "Engine Coolant Temp" + "°F".
const mergeUnits = (names, units) =>
  names.map((n, i) => {
    const u = (units?.[i] || "").trim();
    return u && !n.includes("[") ? `${n} [${u}]` : n;
  });

export function parseCsv(text) {
  const raw = text.split(/\r?\n/);
  const isHpt = /^HP Tuners CSV Log File/i.test(raw[0]?.trim() || "")
    || raw.slice(0, 40).some(l => l.trim() === "[Channel Data]");

  if (isHpt) {
    const idx = l => raw.findIndex(x => x.trim() === l);
    const chInfo = idx("[Channel Information]");
    const chData = idx("[Channel Data]");
    if (chData === -1) return { headers: [], rows: [], format: "hptuners" };

    // [Channel Information] holds up to three rows: parameter IDs, names,
    // units. Older exports omit the ID row, so find the names row by working
    // back from [Channel Data] rather than assuming a fixed offset.
    const block = raw.slice(chInfo + 1, chData).map(l => l.trimEnd()).filter(l => l.trim());
    let ids = null, names = null, units = null;
    if (block.length >= 3) [ids, names, units] = block.slice(-3).map(splitCsv);
    else if (block.length === 2) [names, units] = block.map(splitCsv);
    else if (block.length === 1) names = splitCsv(block[0]);
    if (!names) return { headers: [], rows: [], format: "hptuners" };

    // If the "ids" row isn't actually numeric IDs, it was really the names row.
    if (ids && !ids.every(v => /^\d*$/.test(v))) { units = names; names = ids; ids = null; }
    // Column count comes from the DATA rows: they are what the header has to
    // line up with. The IDs and units rows are only a fallback — trusting a
    // short IDs row would fold genuine channels together.
    const firstData = raw.slice(chData + 1).find(l => l.trim() && !l.trim().startsWith("["));
    const width = firstData ? splitCsv(firstData).length : (ids?.length || units?.length || 0);
    names = rejoinNames(names, width);

    const headers = mergeUnits(names, units);
    const rows = [];
    let filled = 0;
    for (let i = chData + 1; i < raw.length; i++) {
      const line = raw[i];
      if (!line.trim() || line.trim().startsWith("[")) continue;
      const cells = splitCsv(line);
      rows.push(cells.map(c => (c === "" ? null : toNum(c))));
      for (const c of cells) if (c !== "") filled++;
    }
    // sparse if rows are mostly holes — the signature of interval logging
    const density = rows.length ? filled / (rows.length * headers.length) : 1;
    return {
      headers, rows, unitsRow: units || null, parameterIds: ids,
      format: "hptuners", sparse: density < 0.9, density: +density.toFixed(3),
      timeIdx: headers.findIndex(h => /^offset/i.test(h)),
    };
  }

  const lines = raw.filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [], format: "plain" };
  // VCM Scanner exports sometimes carry a units row under the header
  const headers = splitCsv(lines[0]);
  let start = 1;
  const looksNumeric = r => r.filter(c => Number.isFinite(parseFloat(c))).length > r.length / 2;
  if (lines[1] && !looksNumeric(splitCsv(lines[1]))) start = 2;
  const rows = [];
  for (let i = start; i < lines.length; i++) rows.push(splitCsv(lines[i]).map(toNum));
  return { headers, rows, unitsRow: start === 2 ? splitCsv(lines[1]) : null, format: "plain", sparse: false };
}

// ---------- resampling sparse logs onto a uniform time grid ----------
// Forward-fill (last known value holds) onto a fixed interval. Two reasons for
// a grid rather than filling in place:
//   * statistics become time-weighted instead of weighted by how often a
//     channel happens to be polled;
//   * the steady-state filter compares consecutive rows, and filling in place
//     leaves long runs of identical held values whose deltas are always 0 —
//     every transient would look like steady state.
// A held value must also EXPIRE. One real 4.7-hour log sat idle for long
// stretches; holding each channel's last reading across those gaps invented
// ~160,000 identical samples and buried the genuine data underneath them. So a
// channel may only be held for a few of its OWN update intervals, measured
// from the log itself because intervals are per-channel and user-configured.
function updateIntervals(parsed, ti) {
  const width = parsed.headers.length;
  const prev = new Array(width).fill(null);
  const gaps = Array.from({ length: width }, () => []);
  for (const row of parsed.rows) {
    const t = Number(row[ti]);
    if (!Number.isFinite(t)) continue;
    for (let i = 0; i < width; i++) {
      if (row[i] === null || row[i] === undefined || row[i] === "") continue;
      if (prev[i] !== null && t > prev[i]) gaps[i].push(t - prev[i]);
      prev[i] = t;
    }
  }
  return gaps.map(g => {
    if (!g.length) return null;
    g.sort((a, b) => a - b);
    return g[Math.floor(g.length / 2)];      // median, so one pause doesn't skew it
  });
}

// One exported file can hold more than one logging run: the Offset column
// restarts near zero and counts up again. A real 129k-row export contained two
// sessions (21 min, then 14 min) plus a single corrupt timestamp of 16778.048 s
// sitting between them. Left alone, the corrupt row makes everything after it
// look out-of-order and the whole second session is silently discarded.
//
// So: drop implausible forward jumps, and rebase each restart so the sessions
// run back to back on one timeline. Segment boundaries are reported, because a
// boundary is the one place a sample-to-sample delta is meaningless.
export function normalizeTime(parsed) {
  const ti = parsed.timeIdx ?? 0;
  const rows = parsed.rows.filter(r => Number.isFinite(Number(r[ti])));
  if (rows.length < 3) return { rows: parsed.rows, segments: 1, droppedRows: 0, boundaries: [] };

  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const d = Number(rows[i][ti]) - Number(rows[i - 1][ti]);
    if (d > 0) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.1;
  const jumpLimit = Math.max(60, med * 1000);   // beyond this, the stamp is junk

  const out = [];
  const boundaries = [];
  let offset = 0, prev = null, dropped = 0, segments = 1;
  for (const r of rows) {
    const t = Number(r[ti]);
    if (prev !== null) {
      const d = t - prev;
      if (d > jumpLimit) { dropped++; continue; }          // corrupt stamp
      if (d < 0) {                                          // session restart
        offset += prev + med - t;
        segments++;
        boundaries.push(+(t + offset).toFixed(3));
      }
    }
    const copy = [...r];
    copy[ti] = +(t + offset).toFixed(3);
    out.push(copy);
    prev = t;
  }
  return { rows: out, segments, droppedRows: dropped, boundaries };
}

export function densify(input, { intervalMs = 100, holdFactor = 3, minHoldSec = 1, unknownHoldSec = 5 } = {}) {
  const ti = input.timeIdx ?? 0;
  if (!input.rows.length || ti < 0) return input;
  const time = normalizeTime(input);
  const parsed = { ...input, rows: time.rows };
  const step = intervalMs / 1000;
  const width = parsed.headers.length;
  const medians = updateIntervals(parsed, ti);
  // A channel that reported only once has no measurable interval. Holding it
  // forever is the wrong default — it would fill the rest of the log with a
  // single reading — so cap it at a short, explicit fallback.
  const maxHold = medians.map(m => (m === null ? unknownHoldSec : Math.max(minHoldSec, m * holdFactor)));

  const last = new Array(width).fill(null);
  const seenAt = new Array(width).fill(-Infinity);
  const out = [];
  const t0 = Number(parsed.rows[0][ti]);
  if (!Number.isFinite(t0)) return parsed;
  let next = t0, tMax = t0, backward = 0;

  const snapshot = at => {
    const r = new Array(width).fill(null);
    for (let i = 0; i < width; i++) if (at - seenAt[i] <= maxHold[i]) r[i] = last[i];
    r[ti] = +at.toFixed(3);
    return r;
  };

  for (const row of parsed.rows) {
    const t = Number(row[ti]);
    if (!Number.isFinite(t)) continue;
    if (t < tMax) { backward++; continue; }   // out-of-order rows (seen at one log's tail)
    tMax = t;
    while (t >= next + step) { out.push(snapshot(next)); next += step; }
    for (let i = 0; i < width; i++) {
      if (row[i] === null || row[i] === undefined || row[i] === "") continue;
      last[i] = row[i]; seenAt[i] = t;
    }
  }
  out.push(snapshot(tMax));
  return {
    ...parsed,
    rows: out,
    resampled: { intervalMs, holdFactor, fromRows: input.rows.length, toRows: out.length,
                 durationSec: +(tMax - t0).toFixed(2), outOfOrderRows: backward,
                 sessions: time.segments, corruptTimestamps: time.droppedRows,
                 sessionBoundaries: time.boundaries },
  };
}

const num = (row, idx) => (idx === undefined ? null : (typeof row[idx] === "number" ? row[idx] : null));
const avgOf = (row, idxs) => {
  if (!idxs) return null;
  const vals = (Array.isArray(idxs) ? idxs : [idxs]).map(i => num(row, i)).filter(v => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

// truthy for the various ways tools encode a flag column
function isOn(v) {
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(1|true|yes|on|active|enabled)$/i.test(v.trim());
  return false;
}

// ---------- filtering ----------
// Trim data is only meaningful warmed up, in closed loop, out of power
// enrichment, at steady state. Everything else is noise that will happily
// produce a confident, wrong correction.
export const DEFAULT_FILTERS = {
  minEct: 160,
  minEctUnit: "°F",   // the threshold's OWN unit — converted to the log's unit before comparing
  maxTpsDelta: 2,     // % change between samples — steady state
  maxRpmDelta: 200,   // RPM change between samples
  minRpm: 500,        // running
  requireClosedLoop: true,
  excludePe: true,
};

export function filterRows(parsed, ch, opts = {}, channelUnits = {}) {
  const f = { ...DEFAULT_FILTERS, ...opts };
  const kept = [];
  const warnings = [];
  const rejected = { cold: 0, openLoop: 0, powerEnrich: 0, transient: 0, notRunning: 0, noTrimData: 0 };

  // Convert the threshold into whatever unit the log actually reports, rather
  // than converting every sample. If the log doesn't state a temperature unit
  // we DISABLE the filter and say so — guessing here silently threw away a
  // whole Celsius log before this was fixed.
  const ectReq = requireUnit(channelUnits, "ect", "temperature", f.minEctUnit, "coolant temperature");
  const ectUnit = ectReq.ok ? ectReq.unit : null;
  let ectThreshold = null;
  if (!ectReq.ok) {
    warnings.push(`${ectReq.reason} — the warmed-up filter was disabled rather than guessed. Add units to the channel name, or set the threshold manually.`);
  } else {
    ectThreshold = {
      value: +convert(f.minEct, f.minEctUnit, ectUnit).toFixed(1),
      unit: ectUnit,
      from: `${f.minEct} ${f.minEctUnit}`,
      converted: ectUnit !== f.minEctUnit,
    };
  }

  // Power enrichment with no PE flag and no closed-loop flag: commanded
  // mixture stands in. Commanding richer than stoich IS power enrichment, so
  // this is a sound proxy — but it is an inference, so it is only used when
  // both real flags are absent, and it is reported rather than assumed.
  let peProxy = null;
  if (f.excludePe && ch.pe === undefined && ch.closedLoop === undefined && ch.commandedAfr !== undefined) {
    const cmdHeader = parsed.headers[ch.commandedAfr];
    const sample = parsed.rows.slice(0, 400).map(r => num(r, ch.commandedAfr)).filter(v => v !== null);
    const s = detectScale(cmdHeader, sample);
    if (s.scale === "lambda" || s.scale === "eq" || s.scale === "afr") {
      const rich = v => (s.scale === "eq" ? v > 1.02 : s.scale === "afr" ? v / 14.7 < 0.98 : v < 0.98);
      peProxy = { column: cmdHeader, scale: s.scale, basis: s.basis, test: rich };
      warnings.push(`No power-enrichment or closed-loop flag in this log, so “${cmdHeader}” was used to detect PE instead: any sample commanding richer than stoichiometric is treated as power enrichment (${s.basis}). This is an inference — log Fuel System Status or a PE flag to remove the guesswork.`);
    }
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i], prev = parsed.rows[i - 1];
    if (peProxy) {
      const c = num(row, ch.commandedAfr);
      if (c !== null && peProxy.test(c)) { rejected.powerEnrich++; continue; }
    }
    const rpm = num(row, ch.rpm);
    if (rpm !== null && rpm < f.minRpm) { rejected.notRunning++; continue; }

    const ect = num(row, ch.ect);
    if (ectThreshold && ect !== null && ect < ectThreshold.value) { rejected.cold++; continue; }

    if (f.requireClosedLoop && ch.closedLoop !== undefined && !isOn(row[ch.closedLoop])) { rejected.openLoop++; continue; }
    if (f.excludePe && ch.pe !== undefined && isOn(row[ch.pe])) { rejected.powerEnrich++; continue; }

    if (prev) {
      const dTps = Math.abs((num(row, ch.tps) ?? 0) - (num(prev, ch.tps) ?? 0));
      const dRpm = Math.abs((rpm ?? 0) - (num(prev, ch.rpm) ?? 0));
      if (dTps > f.maxTpsDelta || dRpm > f.maxRpmDelta) { rejected.transient++; continue; }
    }

    const ltft = avgOf(row, ch.ltft), stft = avgOf(row, ch.stft);
    if (ltft === null && stft === null) { rejected.noTrimData++; continue; }

    kept.push({ row, ltft: ltft ?? 0, stft: stft ?? 0, total: (ltft ?? 0) + (stft ?? 0) });
  }
  return { kept, rejected, filters: f, totalRows: parsed.rows.length, ectThreshold, warnings,
           peProxy: peProxy ? { column: peProxy.column, scale: peProxy.scale, basis: peProxy.basis } : null };
}

// ---------- 1D binning: trim vs a chosen axis (MAF Hz by default) ----------
export function binByAxis(kept, ch, axisRole = "mafHz", binSize = 500, minSamples = 20) {
  const axisIdx = ch[axisRole];
  if (axisIdx === undefined) return { error: `no ${axisRole} channel found in this log` };
  const bins = new Map();
  for (const k of kept) {
    const x = num(k.row, axisIdx);
    if (x === null) continue;
    const key = Math.floor(x / binSize) * binSize;
    if (!bins.has(key)) bins.set(key, { from: key, to: key + binSize, n: 0, ltft: 0, stft: 0, total: 0 });
    const b = bins.get(key);
    b.n++; b.ltft += k.ltft; b.stft += k.stft; b.total += k.total;
  }
  return {
    binSize, minSamples, axis: axisRole,
    bins: [...bins.values()].sort((a, b) => a.from - b.from).map(b => ({
      from: b.from, to: b.to, n: b.n,
      avgLtft: +(b.ltft / b.n).toFixed(2),
      avgStft: +(b.stft / b.n).toFixed(2),
      avgTotal: +(b.total / b.n).toFixed(2),
      // Positive trim = PCM adding fuel = MAF under-reporting airflow, so the
      // MAF table value for this cell should go UP by the same proportion.
      suggestedPct: +(b.total / b.n).toFixed(1),
      multiplier: +((100 + b.total / b.n) / 100).toFixed(4),
      enoughData: b.n >= minSamples,
    })),
  };
}

// The load axis must be binned in the units the CALIBRATION TABLE uses, not the
// units the log happened to record. GM VE and spark tables are indexed in kPa;
// this car logs manifold pressure in psi, so a 10-unit bin — correct for kPa —
// collapsed the entire 11–97 kPa range into two rows, 0 and 10 psi. Every
// load-resolved map was effectively one-dimensional and said nothing.
//
// Returns a function converting this channel's values to kPa, or null when the
// log does not state a unit — in which case we bin raw and say so, rather than
// guessing, exactly as the coolant threshold does.
export function loadToKpa(channelUnits, role = "map") {
  const r = requireUnit(channelUnits, role, "pressure", "kPa", "manifold pressure");
  return r.ok ? r.convert : null;
}

// ---------- 2D heat map: average value over an X/Y grid ----------
// yScale converts the Y value before binning (see loadToKpa).
export function heatmap(kept, ch, xRole, yRole, xBin, yBin, minSamples = 5, yScale = null) {
  const xi = ch[xRole], yi = ch[yRole];
  if (xi === undefined || yi === undefined) return { error: `need both ${xRole} and ${yRole} in the log` };
  const cells = new Map();
  for (const k of kept) {
    const x = num(k.row, xi);
    let y = num(k.row, yi);
    if (x === null || y === null) continue;
    if (yScale) y = yScale(y);
    const xk = Math.floor(x / xBin) * xBin, yk = Math.floor(y / yBin) * yBin;
    const key = `${xk}|${yk}`;
    if (!cells.has(key)) cells.set(key, { x: xk, y: yk, n: 0, sum: 0 });
    const c = cells.get(key);
    c.n++; c.sum += k.total;
  }
  const list = [...cells.values()].map(c => ({ x: c.x, y: c.y, n: c.n, avg: +(c.sum / c.n).toFixed(2), enoughData: c.n >= minSamples }));
  return {
    xRole, yRole, xBin, yBin, minSamples, cells: list,
    xs: [...new Set(list.map(c => c.x))].sort((a, b) => a - b),
    ys: [...new Set(list.map(c => c.y))].sort((a, b) => b - a),
  };
}

// ---------- wideband ----------
// Three scales are in play and two of them look identical in a log:
//   AFR    ~10–20      (gasoline; scale is fuel-dependent)
//   lambda ~0.7–1.3    1.0 = stoich, BELOW 1 = rich
//   EQ     ~0.7–1.4    1.0 = stoich, ABOVE 1 = rich   (GM's commanded EQ = 1/lambda)
// lambda and EQ cannot be told apart by range, so: use the unit in the header
// if it states one, otherwise infer AFR-vs-ratio from magnitude and SAY which
// assumption was made. Never quietly pick between lambda and EQ.
export function detectScale(header, sampleValues) {
  const full = String(header || "");
  // A declared unit outranks the channel name. Real case: an AEM channel named
  // "WB EQ Ratio 1" whose logged unit is λ — the name and the unit disagree,
  // and believing the name would inverse the mixture (λ 0.85 is rich, EQ 0.85
  // is lean). The unit comes from the logging tool; the name is user-typed.
  const declared = full.match(/\[([^\]]+)\]\s*$/)?.[1]?.trim().toLowerCase() || null;
  const name = full.replace(/\s*\[[^\]]*\]\s*$/, "").toLowerCase();
  const fromUnit = declared === null ? null
    : /^(λ|lambda)$/.test(declared) ? "lambda"
    : /^(eq|equiv)/.test(declared) ? "eq"
    : /^afr$/.test(declared) ? "afr" : null;
  const fromName = /\blambda\b|λ/.test(name) ? "lambda"
    : /\beq\b|equiv/.test(name) ? "eq"
    : /\bafr\b/.test(name) ? "afr" : null;

  if (fromUnit) {
    return fromName && fromName !== fromUnit
      ? { scale: fromUnit, basis: `declared unit “${declared}” — note the channel name says ${fromName.toUpperCase()}; the unit was trusted`, nameConflict: { name: fromName, unit: fromUnit } }
      : { scale: fromUnit, basis: `declared unit “${declared}”` };
  }
  if (fromName) return { scale: fromName, basis: "stated in the channel name" };
  const vals = sampleValues.filter(Number.isFinite);
  if (!vals.length) return { scale: null, basis: "no numeric samples" };
  const med = vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  if (med > 5) return { scale: "afr", basis: `inferred from magnitude (median ${med.toFixed(2)})` };
  return { scale: "ratio-ambiguous", basis: `values near 1.0 (median ${med.toFixed(3)}) — could be lambda or EQ; assuming lambda`, assumedLambda: true };
}

/** Everything is compared in lambda: 1.0 = stoich, <1 rich, >1 lean. */
export function toLambda(value, scale, stoich) {
  if (value == null || !Number.isFinite(value)) return null;
  if (scale === "afr") return value / stoich;
  if (scale === "eq") return value === 0 ? null : 1 / value;
  return value;                       // lambda, or ratio assumed to be lambda
}

export function analyzeWideband(parsed, ch, channelUnits, opts = {}) {
  const wbIdx = ch.widebandAfr, cmdIdx = ch.commandedAfr;
  if (wbIdx === undefined) return { present: false, reason: "no wideband channel found in this log" };

  const fuel = FUELS[opts.fuel] || FUELS.gasoline;
  const col = i => parsed.rows.map(r => num(r, i)).filter(v => v !== null);
  const wbScale = opts.widebandScale
    ? { scale: opts.widebandScale, basis: "set manually" }
    : detectScale(parsed.headers[wbIdx], col(wbIdx).slice(0, 400));
  const cmdScale = cmdIdx === undefined ? null : (opts.commandedScale
    ? { scale: opts.commandedScale, basis: "set manually" }
    : detectScale(parsed.headers[cmdIdx], col(cmdIdx).slice(0, 400)));

  const leanLimit = opts.wotLeanLambda ?? 1.0;     // λ at high load that warrants attention
  const wotTps = opts.wotTps ?? 80;                 // % throttle counted as WOT

  const wotByRpm = new Map();
  let wotSamples = 0, leanWotSamples = 0, worstWot = null;
  const clPairs = [];
  const clProxy = ch.closedLoop === undefined && cmdIdx !== undefined
    && (cmdScale.scale === "lambda" || cmdScale.scale === "eq" || cmdScale.scale === "afr");

  for (const row of parsed.rows) {
    const wb = toLambda(num(row, wbIdx), wbScale.scale, fuel.stoich);
    if (wb === null) continue;
    const cmd = cmdIdx === undefined ? null : toLambda(num(row, cmdIdx), cmdScale.scale, fuel.stoich);
    const tps = num(row, ch.tps);
    const rpm = num(row, ch.rpm);
    const pe = ch.pe !== undefined && isOn(row[ch.pe]);
    // With no Fuel System Status channel, commanding stoichiometric IS the
    // closed-loop condition — the PCM only targets λ 1.00 when it is trimming
    // to the narrowband. Reported as an inference, never assumed silently.
    const cl = ch.closedLoop !== undefined ? isOn(row[ch.closedLoop])
      : (clProxy && cmd !== null ? Math.abs(cmd - 1) <= 0.01 : null);
    const atWot = pe || (tps !== null && tps >= wotTps);

    if (atWot && rpm !== null) {
      // This is the region trims can't see and where lean actually hurts.
      const key = Math.floor(rpm / 500) * 500;
      if (!wotByRpm.has(key)) wotByRpm.set(key, { from: key, to: key + 500, n: 0, sumWb: 0, sumCmd: 0, nCmd: 0, leanest: null });
      const b = wotByRpm.get(key);
      b.n++; b.sumWb += wb;
      if (cmd !== null) { b.sumCmd += cmd; b.nCmd++; }
      if (b.leanest === null || wb > b.leanest) b.leanest = wb;
      wotSamples++;
      if (wb > leanLimit) leanWotSamples++;
      if (!worstWot || wb > worstWot.lambda) worstWot = { lambda: +wb.toFixed(3), rpm, tps, commanded: cmd === null ? null : +cmd.toFixed(3) };
    }
    if (cl === true && !pe && cmd !== null) clPairs.push({ wb, cmd });
  }

  const asAfr = l => +(l * fuel.stoich).toFixed(2);
  const wot = [...wotByRpm.values()].sort((a, b) => a.from - b.from).map(b => ({
    from: b.from, to: b.to, n: b.n,
    avgLambda: +(b.sumWb / b.n).toFixed(3),
    avgAfr: asAfr(b.sumWb / b.n),
    commandedLambda: b.nCmd ? +(b.sumCmd / b.nCmd).toFixed(3) : null,
    commandedAfr: b.nCmd ? asAfr(b.sumCmd / b.nCmd) : null,
    errorPct: b.nCmd ? +(((b.sumWb / b.n) / (b.sumCmd / b.nCmd) - 1) * 100).toFixed(1) : null,
    leanestLambda: +b.leanest.toFixed(3),
    lean: (b.sumWb / b.n) > leanLimit,
  }));

  // Closed-loop cross-check: the narrowband can be happy while the wideband isn't.
  let closedLoopCheck = null;
  if (clPairs.length >= 20) {
    const avgWb = clPairs.reduce((s, p) => s + p.wb, 0) / clPairs.length;
    const avgCmd = clPairs.reduce((s, p) => s + p.cmd, 0) / clPairs.length;
    closedLoopCheck = {
      samples: clPairs.length,
      avgMeasuredLambda: +avgWb.toFixed(3), avgCommandedLambda: +avgCmd.toFixed(3),
      avgMeasuredAfr: asAfr(avgWb), avgCommandedAfr: asAfr(avgCmd),
      errorPct: +((avgWb / avgCmd - 1) * 100).toFixed(1),
    };
  }

  return {
    present: true,
    channel: parsed.headers[wbIdx],
    commandedChannel: cmdIdx === undefined ? null : parsed.headers[cmdIdx],
    scale: wbScale, commandedScale: cmdScale,
    fuel: { key: opts.fuel || "gasoline", ...fuel },
    wotDefinition: { pePreferred: ch.pe !== undefined, tpsThresholdPct: wotTps, leanLimitLambda: leanLimit },
    wotSamples, leanWotSamples,
    worstWot,
    wot,
    closedLoopCheck,
    closedLoopBasis: ch.closedLoop !== undefined
      ? `Fuel System Status channel (${parsed.headers[ch.closedLoop]})`
      : clProxy ? `inferred: commanded mixture within 1% of stoichiometric (“${parsed.headers[cmdIdx]}”) — no Fuel System Status channel was logged`
      : null,
    units: { lambda: "λ (1.00 = stoich, below 1 rich)", afr: `AFR (stoich ${fuel.stoich} for ${fuel.label})`, error: "%" },
    note: "Lambda is the comparison basis; AFR is derived using the selected fuel's stoichiometric ratio. Draft readings — confirm the wideband's scale and your fuel before acting on them.",
  };
}

// ---------- spark & knock ----------
// Different rules from fuelling: knock matters most exactly where the fuel
// filters throw data away (WOT, power enrichment), so this pass keeps those
// rows. Cells report MAX knock retard, never the average — averaging a 6°
// spike among zeros hides the event you needed to see.
export function analyzeSpark(parsed, ch, channelUnits, opts = {}) {
  const krIdx = ch.knockRetard;
  if (krIdx === undefined && ch.spark === undefined)
    return { present: false, reason: "no knock-retard or spark-advance channel in this log" };

  const yRole = ch.map !== undefined ? "map" : (ch.load !== undefined ? "load" : null);
  const rpmBin = opts.sparkRpmBin || 500;
  // 10 is a kPa bin, so the values must BE kPa. Without this a psi log gave
  // two rows for the whole range and the map said nothing.
  const yScale = yRole === "map" ? loadToKpa(channelUnits, "map") : null;
  const loadUnit = yRole === "map" ? (yScale ? "kPa" : (channelUnits?.map?.unit ?? null))
                                   : (channelUnits?.[yRole]?.unit ?? null);
  const loadBin = opts.sparkLoadBin || (yRole === "map" && !yScale ? 2 : 10);
  const krThreshold = opts.krThreshold ?? 0.1;     // ° of retard that counts as knock

  const krCells = new Map(), sparkCells = new Map();
  const events = [];
  let cur = null, krSamples = 0, worst = null, running = 0;

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const rpm = num(row, ch.rpm);
    if (rpm !== null && rpm < 500) { if (cur) { events.push(cur); cur = null; } continue; }
    running++;
    let y = yRole ? num(row, ch[yRole]) : null;
    if (y !== null && yScale) y = yScale(y);
    const kr = krIdx === undefined ? null : num(row, krIdx);
    const adv = ch.spark === undefined ? null : num(row, ch.spark);
    const iat = num(row, ch.iat), ect = num(row, ch.ect), tps = num(row, ch.tps);

    if (rpm !== null && y !== null) {
      const key = `${Math.floor(rpm / rpmBin) * rpmBin}|${Math.floor(y / loadBin) * loadBin}`;
      if (kr !== null) {
        const c = krCells.get(key) || { x: Math.floor(rpm / rpmBin) * rpmBin, y: Math.floor(y / loadBin) * loadBin, n: 0, max: 0, hits: 0, iatSum: 0, iatN: 0 };
        c.n++; if (kr > c.max) c.max = kr;
        if (kr >= krThreshold) {
          c.hits++;
          if (iat !== null) { c.iatSum += iat; c.iatN++; }   // only IAT while knocking
        }
        krCells.set(key, c);
      }
      if (adv !== null) {
        const c = sparkCells.get(key) || { x: Math.floor(rpm / rpmBin) * rpmBin, y: Math.floor(y / loadBin) * loadBin, n: 0, sum: 0, max: -Infinity };
        c.n++; c.sum += adv; if (adv > c.max) c.max = adv;
        sparkCells.set(key, c);
      }
    }

    // contiguous run of retard = one knock event
    if (kr !== null && kr >= krThreshold) {
      krSamples++;
      if (!cur) cur = { startRow: i, samples: 0, peakKr: 0, rpmAt: rpm, rpmMin: rpm, rpmMax: rpm, load: y, iat, ect, tps, spark: adv };
      cur.samples++;
      if (kr > cur.peakKr) { cur.peakKr = kr; cur.rpmAt = rpm; cur.load = y; cur.iat = iat; cur.spark = adv; }
      if (rpm !== null) { cur.rpmMin = Math.min(cur.rpmMin ?? rpm, rpm); cur.rpmMax = Math.max(cur.rpmMax ?? rpm, rpm); }
      if (!worst || kr > worst.kr) worst = { kr: +kr.toFixed(2), rpm, load: y, iat, spark: adv, tps };
    } else if (cur) { events.push(cur); cur = null; }
  }
  if (cur) events.push(cur);

  const round = (v, d = 2) => (v == null ? null : +v.toFixed(d));
  const evs = events.map(e => ({
    samples: e.samples, peakKr: round(e.peakKr), rpm: e.rpmAt,
    rpmRange: e.rpmMin === e.rpmMax ? `${e.rpmMin}` : `${e.rpmMin}–${e.rpmMax}`,
    load: round(e.load, 1), iat: round(e.iat, 1), ect: round(e.ect, 1),
    tps: round(e.tps, 1), sparkAtPeak: round(e.spark, 1),
    // Knock under light load rarely is knock — rough road and drivetrain
    // noise fool the sensors. Flag it for a human rather than judging it.
    suspectFalse: e.tps !== null && e.tps < 25,
  })).sort((a, b) => b.peakKr - a.peakKr);

  // The documented Gen 3 procedure: subtract the knock retard seen in a cell
  // from the corresponding High Octane spark cell. MAX, never mean — one hard
  // event is what matters, and averaging it away is how detonation gets tuned
  // around instead of out.
  const hotIat = opts.hotIatF ?? 100;              // °F above which IAT retard is the likelier cause
  // express the threshold in the log's own unit rather than converting every sample
  const iatReq = requireUnit(channelUnits, "iat", "temperature", "°F", "intake air temperature");
  const iatUnit = iatReq.ok ? iatReq.unit : null;
  const hotIatInLogUnit = iatReq.ok ? convert(hotIat, "°F", iatReq.unit) : null;
  const krList = [...krCells.values()].map(c => {
    const iatAvg = c.iatN ? c.iatSum / c.iatN : null;
    const iatSuspect = iatAvg !== null && hotIatInLogUnit !== null && iatAvg >= hotIatInLogUnit;
    return {
      ...c, max: round(c.max),
      // rounded to 0.5° — finer than the table resolution is false precision
      suggestedSparkDelta: c.max >= krThreshold ? -(Math.round(c.max * 2) / 2) : 0,
      iatWhileKnocking: iatAvg === null ? null : round(iatAvg),
      iatSuspect,
      advice: c.max < krThreshold ? null
        : iatSuspect
          ? "Knock here coincides with high intake air temperature — look at the IAT spark-retard table before pulling timing from the main table."
          : "Subtract this from the High Octane main spark cell, then re-log.",
    };
  });
  const sparkList = [...sparkCells.values()].map(c => ({ x: c.x, y: c.y, n: c.n, avg: round(c.sum / c.n, 1), max: round(c.max, 1) }));
  const axes = list => ({
    xs: [...new Set(list.map(c => c.x))].sort((a, b) => a - b),
    ys: [...new Set(list.map(c => c.y))].sort((a, b) => b - a),
  });

  return {
    present: true,
    hasKnockChannel: krIdx !== undefined,
    hasSparkChannel: ch.spark !== undefined,
    krChannel: krIdx === undefined ? null : parsed.headers[krIdx],
    sparkChannel: ch.spark === undefined ? null : parsed.headers[ch.spark],
    yRole, yUnit: loadUnit,
    rpmBin, loadBin, krThreshold,
    runningSamples: running,
    krSamples,
    eventCount: evs.length,
    worst,
    events: evs.slice(0, 25),
    krMap: krCells.size ? { cells: krList, ...axes(krList), valueUnit: "° crank (max retard in cell)",
                            suggestionUnit: "° crank to subtract from the High Octane table",
                            iatUnit, hotIatThreshold: hotIatInLogUnit === null ? null : round(hotIatInLogUnit) } : null,
    sparkSuggestions: krList.filter(c => c.suggestedSparkDelta !== 0)
      .sort((a, b) => b.max - a.max)
      .map(c => ({ rpm: c.x, load: c.y, maxKr: c.max, delta: c.suggestedSparkDelta,
                   samples: c.hits, iat: c.iatWhileKnocking, iatSuspect: c.iatSuspect, advice: c.advice })),
    blendCaveat: "Logged spark advance is the PCM's blend of the High and Low Octane tables, weighted by the knock learn factor — a single logged figure cannot be attributed to one table. Subtractions target the High Octane table because that is where the procedure applies them; verify against your own calibration.",
    sparkMap: sparkCells.size ? { cells: sparkList, ...axes(sparkList), valueUnit: "° crank (average advance)" } : null,
    units: { kr: "° crank", spark: "° crank", load: yRole ? (channelUnits[yRole]?.unit ?? "unit not stated") : null },
    note: "Knock-retard cells show the MAXIMUM in each cell, not the average — a single hard event matters more than a quiet average. Draft readings.",
  };
}

export function analyze(text, opts = {}) {
  const raw = parseCsv(text);
  if (!raw.headers.length) return { error: "no data rows in this CSV" };
  // Interval-logged files have no row where all the needed channels coexist,
  // so they must be put on a common time base before anything else runs.
  const parsed = raw.sparse ? densify(raw, { intervalMs: opts.intervalMs || 100 }) : raw;
  const chAll = { ...detectChannels(parsed.headers), ...(opts.channels || {}) };

  // A channel can be present in the header and carry no data at all — the
  // wideband was configured but never reported, and so was Fuel System Status.
  // Left in place, an empty closed-loop flag reads as "not in closed loop" on
  // every row and silently rejects the entire log. Drop them and say so.
  const hasData = i => i !== undefined && parsed.rows.some(r => typeof r[i] === "number");
  const candidates = detectCandidates(parsed.headers);
  const ch = {}, silentChannels = [];
  for (const [role, idx] of Object.entries(chAll)) {
    if (Array.isArray(idx)) {                       // trims: keep every live bank
      const live = idx.filter(hasData);
      if (live.length) ch[role] = live;
      else silentChannels.push({ role, column: parsed.headers[idx[0]] });
      continue;
    }
    // Single-column role: prefer the first candidate that actually reported.
    // Three wideband channels were configured on this car and only the analog
    // one carried data — taking the first match would have found nothing.
    const overridden = opts.channels && role in opts.channels;
    const pool = overridden ? [idx] : (candidates[role] || [idx]);
    const live = pool.find(hasData);
    if (live !== undefined) {
      ch[role] = live;
      for (const dead of pool.filter(i => i !== live && !hasData(i)))
        silentChannels.push({ role, column: parsed.headers[dead], superseded: parsed.headers[live] });
    } else silentChannels.push({ role, column: parsed.headers[pool[0]] });
  }

  // Unit per detected channel, read from its header. Unknown stays unknown.
  const channelUnits = {};
  for (const [role, idx] of Object.entries(ch)) {
    const i = Array.isArray(idx) ? idx[0] : idx;
    const header = parsed.headers[i];
    const u = header ? detectUnit(header) : null;
    channelUnits[role] = { column: header, unit: u?.unit ?? null, quantity: u?.quantity ?? null, convertible: !!u?.convertible };
  }

  const missing = ["mafHz", "ltft", "stft", "ect", "closedLoop", "pe", "tps", "rpm"].filter(r => ch[r] === undefined);
  const filtered = filterRows(parsed, ch, opts.filters, channelUnits);
  for (const s of silentChannels)
    filtered.warnings.push(s.superseded
      // a dead channel that another live column covers is a note, not a gap
      ? `“${s.column}” was logged but contains no samples — “${s.superseded}” is being used for ${s.role} instead. Worth removing the dead channel from the layout.`
      : `“${s.column}” was logged but contains no samples, so the ${s.role} check was skipped. The channel is in your scanner layout but the device never reported.`);
  const yRole = ch.map !== undefined ? "map" : "load";
  return {
    headers: parsed.headers,
    channels: Object.fromEntries(Object.entries(ch).map(([k, v]) =>
      [k, Array.isArray(v) ? v.map(i => parsed.headers[i]) : parsed.headers[v]])),
    channelUnits,
    missingChannels: missing,
    format: raw.format,
    resampled: parsed.resampled || null,
    silentChannels,
    emptyChannels: parsed.headers
      .map((h, i) => (parsed.rows.some(r => typeof r[i] === "number") ? null : h))
      .filter(Boolean),
    rowCount: parsed.rows.length,
    keptCount: filtered.kept.length,
    rejected: filtered.rejected,
    filters: filtered.filters,
    ectThreshold: filtered.ectThreshold,
    peProxy: filtered.peProxy,
    warnings: filtered.warnings,
    mafBins: {
      ...binByAxis(filtered.kept, ch, "mafHz", opts.binSize || 500, opts.minSamples || 20),
      axisUnit: channelUnits.mafHz?.unit ?? "Hz",
      valueUnit: "%",
      multiplierUnit: "dimensionless ratio",
    },
    heat: {
      ...heatmap(filtered.kept, ch, "rpm", yRole, 500,
                 yRole === "map" && !loadToKpa(channelUnits, "map") ? 2 : 10, 5,
                 yRole === "map" ? loadToKpa(channelUnits, "map") : null),
      xUnit: channelUnits.rpm?.unit ?? "RPM",
      yUnit: yRole === "map" && loadToKpa(channelUnits, "map") ? "kPa" : (channelUnits[yRole]?.unit ?? null),
      valueUnit: "%",
    },
    wideband: analyzeWideband(parsed, ch, channelUnits, opts),
    spark: analyzeSpark(parsed, ch, channelUnits, opts),
    airModels: analyzeAirModels(parsed, ch, channelUnits, opts),
    ve: analyzeVE(parsed, ch, channelUnits, opts),
    note: "Draft readings for review. Suggestions are computed from filtered log data and must be applied by hand after you agree with them — nothing here writes to a tune.",
  };
}

// ---------- MAF vs speed-density agreement (Gen 3) ----------
// Where the two air models disagree is where the MAF table and the VE table
// disagree. This needs no wideband and no open loop, because it compares two
// airflow estimates against each other rather than against measured fuelling —
// so it runs on an ordinary closed-loop cruise log, which VE correction cannot.
//
// Binned on the VE table's own axes (RPM x kPa) so a disagreement points at a
// cell you can actually go and look at.
//
// Draft readings. A divergence says the models differ, not which one is right.
export function analyzeAirModels(parsed, ch, channelUnits, opts = {}) {
  if (ch.dynAir === undefined || ch.mafGs === undefined)
    return { present: false, reason: "needs both a dynamic-airflow and a mass-airflow channel" };
  if (ch.rpm === undefined || ch.map === undefined)
    return { present: false, reason: "needs RPM and MAP to bin on the VE table's axes" };

  const dynReq = requireUnit(channelUnits, "dynAir", "airflow", "g/s", "dynamic airflow");
  const mafReq = requireUnit(channelUnits, "mafGs", "airflow", "g/s", "mass airflow");
  if (!dynReq.ok || !mafReq.ok)
    return { present: false, reason: (dynReq.ok ? mafReq : dynReq).reason };
  const dynGs = dynReq.convert, mafGs = mafReq.convert;

  const yScale = loadToKpa(channelUnits, "map");
  if (!yScale)
    return { present: false, reason: "manifold pressure has no unit, so it cannot be binned in kPa" };

  const rpmBin = opts.airRpmBin || 500, loadBin = opts.airLoadBin || 10;
  const minSamples = opts.minSamples || 20;
  const cells = new Map();
  let n = 0, sumDyn = 0, sumMaf = 0;

  for (const row of parsed.rows) {
    const rpm = num(row, ch.rpm), rawMap = num(row, ch.map);
    const d = num(row, ch.dynAir), m = num(row, ch.mafGs);
    if (rpm === null || rawMap === null || d === null || m === null) continue;
    if (rpm < 500) continue;
    const dg = dynGs(d), mg = mafGs(m);
    if (!(mg > 0)) continue;                       // no ratio against zero airflow
    const x = Math.floor(rpm / rpmBin) * rpmBin;
    const y = Math.floor(yScale(rawMap) / loadBin) * loadBin;
    const key = `${x}|${y}`;
    const c = cells.get(key) || { x, y, n: 0, dyn: 0, maf: 0 };
    c.n++; c.dyn += dg; c.maf += mg;
    cells.set(key, c);
    n++; sumDyn += dg; sumMaf += mg;
  }
  if (!n) return { present: false, reason: "no rows carried RPM, MAP and both airflow channels together" };

  const list = [...cells.values()].map(c => {
    const dyn = c.dyn / c.n, maf = c.maf / c.n;
    return { x: c.x, y: c.y, n: c.n,
             dynAirGs: +dyn.toFixed(3), mafGs: +maf.toFixed(3),
             // positive = the PCM's airflow exceeds what the MAF alone reports
             diffPct: +(((dyn / maf) - 1) * 100).toFixed(1),
             enoughData: c.n >= minSamples };
  });
  const usable = list.filter(c => c.enoughData);
  const worst = usable.slice().sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct))[0] || null;

  return {
    present: true,
    dynAirChannel: parsed.headers[ch.dynAir], mafChannel: parsed.headers[ch.mafGs],
    rpmBin, loadBin, minSamples, samples: n,
    overallDiffPct: +(((sumDyn / sumMaf) - 1) * 100).toFixed(1),
    worst,
    cells: list,
    xs: [...new Set(list.map(c => c.x))].sort((a, b) => a - b),
    ys: [...new Set(list.map(c => c.y))].sort((a, b) => b - a),
    units: { airflow: "g/s", load: "kPa", rpm: "RPM", diff: "%" },
    note: "Positive means the PCM's dynamic airflow exceeds the mass-airflow reading alone — the speed-density side is adding air. Close agreement means the VE and MAF tables tell the same story in that cell; it does not mean either is correct. Draft readings.",
  };
}

// ---------- VE correction (Gen 3, open loop only) ----------
// The Gen 3 VE table is indexed RPM x MAP(kPa) and holds cylinder fill against
// theoretical maximum. The published procedure tunes it in OPEN LOOP from
// wideband error alone, applying the percentage error straight to the cell.
//
// Closed-loop data is deliberately refused. With the narrowband in control the
// PCM has already corrected the mixture through the fuel trims, so measured
// lambda sits at commanded by construction and the cell error reads as zero.
// Worse, on a MAF-primary tune those trims describe the MAF table, not the VE
// table — feeding them into VE would move the wrong table using a number that
// does not mean what it appears to.
//
// Direction: VE tells the PCM how much air is in the cylinder. Too high and it
// over-estimates air, injects too much fuel, and the mixture comes out RICH.
// So measured richer than commanded => reduce VE. factor = lambda_measured /
// lambda_commanded, applied multiplicatively.
export function analyzeVE(parsed, ch, channelUnits, opts = {}) {
  const wb = analyzeWideband(parsed, ch, channelUnits, opts);
  if (!wb.present) return { present: false, reason: `no usable wideband: ${wb.reason || "not found"}` };
  if (ch.commandedAfr === undefined)
    return { present: false, reason: "needs a commanded-mixture channel to compute the error against" };
  if (ch.rpm === undefined || ch.map === undefined)
    return { present: false, reason: "needs RPM and MAP to bin on the VE table's axes" };

  const yScale = loadToKpa(channelUnits, "map");
  if (!yScale) return { present: false, reason: "manifold pressure has no unit, so it cannot be binned in kPa" };

  const fuel = FUELS[opts.fuel || "gasoline"] || FUELS.gasoline;
  const wbScale = wb.scale.scale, cmdScale = wb.commandedScale?.scale;
  const wbIdx = ch.widebandAfr, cmdIdx = ch.commandedAfr;

  const rpmBin = opts.veRpmBin || 500, loadBin = opts.veLoadBin || 10;
  const minSamples = opts.minSamples || 20;
  const cells = new Map();
  let openLoop = 0, closedLoopSkipped = 0;

  for (const row of parsed.rows) {
    const rpm = num(row, ch.rpm), rawMap = num(row, ch.map);
    const meas = toLambda(num(row, wbIdx), wbScale, fuel.stoich);
    const cmd = toLambda(num(row, cmdIdx), cmdScale, fuel.stoich);
    if (rpm === null || rawMap === null || meas === null || cmd === null || rpm < 500) continue;

    // Open loop = the PCM is not trimming to the narrowband. A commanded
    // mixture away from stoichiometric is the reliable marker; an explicit
    // closed-loop flag, when logged, is better still.
    const flagged = ch.closedLoop !== undefined ? isOn(row[ch.closedLoop]) : null;
    const isOpenLoop = flagged === false || (flagged === null && Math.abs(cmd - 1) > 0.02);
    if (!isOpenLoop) { closedLoopSkipped++; continue; }
    if (!(cmd > 0)) continue;

    const x = Math.floor(rpm / rpmBin) * rpmBin;
    const y = Math.floor(yScale(rawMap) / loadBin) * loadBin;
    const key = `${x}|${y}`;
    const c = cells.get(key) || { x, y, n: 0, sumFactor: 0, sumMeas: 0, sumCmd: 0 };
    c.n++; c.sumFactor += meas / cmd; c.sumMeas += meas; c.sumCmd += cmd;
    cells.set(key, c);
    openLoop++;
  }

  if (!openLoop) {
    return {
      present: false,
      closedLoopSkipped,
      reason: "no open-loop samples in this log, so no VE correction can be computed",
      why: "VE is tuned open loop on the wideband. In closed loop the PCM holds the mixture at commanded through the fuel trims, so the cell error reads as zero however wrong the VE table is — and on a MAF-primary tune those trims describe the MAF table, not VE. Log a WOT pull, or a session with the MAF disabled, and run this again.",
    };
  }

  const list = [...cells.values()].map(c => {
    const factor = c.sumFactor / c.n;
    return {
      x: c.x, y: c.y, n: c.n,
      avgMeasuredLambda: +(c.sumMeas / c.n).toFixed(3),
      avgCommandedLambda: +(c.sumCmd / c.n).toFixed(3),
      multiplier: +factor.toFixed(4),
      changePct: +((factor - 1) * 100).toFixed(1),
      enoughData: c.n >= minSamples,
    };
  });

  return {
    present: true,
    channel: parsed.headers[wbIdx], commandedChannel: parsed.headers[cmdIdx],
    scale: wb.scale, commandedScale: wb.commandedScale,
    fuel: { key: opts.fuel || "gasoline", ...fuel },
    openLoopSamples: openLoop, closedLoopSkipped,
    openLoopBasis: ch.closedLoop !== undefined
      ? `the Fuel System Status channel (${parsed.headers[ch.closedLoop]})`
      : "commanded mixture more than 2% from stoichiometric — no Fuel System Status channel was logged, so this is an inference",
    rpmBin, loadBin, minSamples,
    cells: list,
    xs: [...new Set(list.map(c => c.x))].sort((a, b) => a - b),
    ys: [...new Set(list.map(c => c.y))].sort((a, b) => b - a),
    units: { load: "kPa", rpm: "RPM", multiplier: "dimensionless ratio", change: "%" },
    note: "Multiply the VE cell by the multiplier — measured richer than commanded means VE is over-estimating air and must come down. Cells below the sample threshold are shown but should not be applied. Draft readings: confirm the wideband's scale and your fuel before touching a table, and change one region at a time.",
  };
}
