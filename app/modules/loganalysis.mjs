// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Datalog analysis — CSV in, binned statistics out. Pure functions, no I/O.
//
// Everything here produces *draft readings for review*. Nothing it computes is
// ever written into a tune: the MAF suggestion is a table to apply by hand in
// HP Tuners, after you agree with it.

import { detectUnit, convert, requireUnit } from "./units.mjs";
import { compile } from "./expr.mjs";

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
  injectorPw:  [/injector\s*pulse\s*width/i, /\bipw\b/i],
  // PCM supply voltage. Collapsing toward 0 V is the key going off — the one
  // unambiguous sign the rest of the row is no longer the PCM's live data.
  moduleVoltage: [/control\s*module\s*volt/i, /\b(pcm|ecm|ecu)\s*volt/i, /\b(battery|system|ignition)\s*volt/i],
  spark:       [/spark\s*adv/i, /ignition\s*timing/i, /timing\s*adv/i],
  // HP Tuners writes the noun first ("Equivalence Ratio Commanded"), so match
  // both word orders rather than assuming "commanded" comes first.
  // "EQ Ratio Commanded" / "Commanded EQ Ratio" (GM enhanced) went undetected:
  // with no commanded channel only the λ 1.0 backstop ran, and a WOT bin 11.8%
  // leaner than commanded passed.
  commandedAfr:[/commanded.*(afr|equiv|lambda|\beq\b)/i, /\beq\s*cmd\b/i, /afr.*(cmd|command)/i, /target.*(afr|lambda)/i,
                /(equiv|lambda|air-?fuel\s*ratio|\beq\b).*command/i],
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
// These convert lambda to AFR for DISPLAY only. They no longer drive any input
// conversion — see resolveStoichs below for why that mattered.
export const FUELS = {
  gasoline: { label: "Gasoline (E0)", stoich: 14.7 },
  e10:      { label: "Pump gas (E10)", stoich: 14.08 },
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
export function rejoinNames(fields, target) {
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

// ---------- loop state ----------
// SAE PID 03, Fuel System Status. HP Tuners writes it as TEXT — "CL - Normal",
// "OL - Not Ready", "OL - Accel/Decel" — and isOn() reads every one of those
// as false, so a live status channel would have rejected the entire log as
// open loop. It survived only because the text also failed the "has data"
// test and was dropped as empty, leaving closed loop and PE to be guessed from
// commanded λ — and the guess counted cold warm-up as power enrichment.
//
// Reasons: normal; notReady (closed-loop conditions not met — warm-up, OR
// closed loop disabled in the tune for VE work, so coolant temperature decides
// which); accelDecel (PE, accel enrichment or DFCO — told apart by commanded
// λ); fault; other (a plain closed-loop flag that says nothing about why).
const SAE_FUEL_STATUS = { 1: [false, "notReady"], 2: [true, "normal"], 4: [false, "accelDecel"],
                          8: [false, "fault"], 16: [true, "fault"] };

function readStatusText(s) {
  const t = s.trim();
  const reason = /not\s*ready|cold|warm/i.test(t) ? "notReady" : /accel|decel|\bpe\b|enrich/i.test(t) ? "accelDecel"
    : /fault/i.test(t) ? "fault" : /normal/i.test(t) ? "normal" : "other";
  if (/^cl\b|closed/i.test(t)) return { closed: true, reason };
  if (/^ol\b|open/i.test(t)) return { closed: false, reason };
  if (/^(1|true|yes|on|active|enabled)$/i.test(t)) return { closed: true, reason: "other" };
  if (/^(0|false|no|off|inactive|disabled)$/i.test(t)) return { closed: false, reason: "other" };
  return null;
}

// Returns row → { closed, reason } | null, or null when there is no channel.
// Numeric values are SAE bit codes only when the channel is Fuel System Status
// AND carries a code a 0/1 flag cannot (2, 4, 8, 16) — otherwise a plain
// "Closed Loop" 1 would read as "OL - Not Ready".
export function makeLoopReader(parsed, ch) {
  const idx = ch.closedLoop;
  if (idx === undefined) return null;
  const nums = new Set();
  for (const r of parsed.rows) if (typeof r[idx] === "number") nums.add(r[idx]);
  const sae = /fuel\s*sys/i.test(parsed.headers[idx] || "")
    && [...nums].some(v => v in SAE_FUEL_STATUS && v !== 1)
    && [...nums].every(v => v in SAE_FUEL_STATUS);
  return row => {
    const v = row[idx];
    if (typeof v === "string") return v.trim() ? readStatusText(v) : null;
    if (typeof v !== "number") return null;
    if (sae) { const s = SAE_FUEL_STATUS[v]; return s ? { closed: s[0], reason: s[1] } : null; }
    return { closed: v !== 0, reason: "other" };
  };
}

// Trims are only trustworthy in closed loop with working feedback.
const trimsValid = s => !!s && s.closed && s.reason !== "fault";

// "Not ready" means the PCM's closed-loop conditions are not met. That is
// warm-up while the coolant is cold, AND after any restart while the O2
// sensors heat — a hot restart at 185 °F sat in "OL - Not Ready" for 16 s, and
// 0.41.0 took those rows for closed loop switched off on purpose. Only warm,
// not-ready rows that are not just after a start are treated as deliberate
// open loop, which is what VE tuning with closed loop disabled produces.
// No usable coolant reading → treated as warm-up, the cautious reading.
export const RESTART = {
  runningRpm: 400,      // at or above this the engine is running
  warmupSec: 120,       // after a start, "not ready" is warm-up until closed loop or this long
  gapSec: 2,            // no RPM for this long → assume the engine may have stopped
};
function makeWarmupTest(parsed, ch, channelUnits, opts = {}) {
  const f = { ...DEFAULT_FILTERS, ...(opts.filters || {}) };
  const req = requireUnit(channelUnits, "ect", "temperature", f.minEctUnit, "coolant temperature");
  const threshold = req.ok ? convert(f.minEct, f.minEctUnit, req.unit) : null;
  const R = { ...RESTART, ...(opts.restart || {}) };
  const loop = makeLoopReader(parsed, ch);
  const ti = ch.time ?? parsed.timeIdx;
  const afterStart = new Set();
  let running = null, startT = null, closedSinceStart = false, lastRpmT = null;
  for (const row of parsed.rows) {
    const t = num(row, ti), rpm = num(row, ch.rpm);
    if (t !== null && lastRpmT !== null && t - lastRpmT > R.gapSec) running = false;
    if (rpm !== null) {
      const now = rpm >= R.runningRpm;
      if (now && running === false) { startT = t; closedSinceStart = false; }
      running = now; lastRpmT = t;
    }
    if (loop?.(row)?.closed) closedSinceStart = true;
    if (startT !== null && t !== null && !closedSinceStart && t - startT <= R.warmupSec) afterStart.add(row);
  }
  return (status, row) => {
    if (status?.reason !== "notReady") return false;
    if (afterStart.has(row)) return true;
    const ect = num(row, ch.ect);
    return threshold === null || ect === null || ect < threshold;
  };
}

// The inference the app used before it could read the status channel, kept as
// a cross-check: a status channel that is misconfigured, mislabelled or badly
// lagging shows up as disagreement with what the PCM was commanding.
// Two disagreements are the status being RIGHT and the inference wrong, so
// they are counted as explained rather than as evidence against the channel:
// open loop at stoich while the O2 sensors are not ready, and decel fuel cut
// ("OL - Accel/Decel") with stoich still commanded. Counting them fired the
// warning at 19.5% on a log with a healthy status channel.
export function crossCheckLoop(parsed, ch, opts = {}) {
  const loop = makeLoopReader(parsed, ch);
  if (!loop || ch.commandedAfr === undefined) return null;
  const header = parsed.headers[ch.commandedAfr];
  const scale = (opts.scales || resolveScales(parsed, ch, opts)).cmd;
  const pcm = scale.scale === "afr" ? resolveStoichs(parsed, ch, opts).pcm : null;
  if (!["lambda", "eq", "afr"].includes(scale.scale) || (scale.scale === "afr" && !pcm)) return null;

  let rows = 0, agree = 0, statusClosedInferredOpen = 0, statusOpenInferredClosed = 0,
      notReadyAtStoich = 0, decelAtStoich = 0, notReadyRich = 0, unreadable = 0;
  const unreadableValues = new Set();
  for (const row of parsed.rows) {
    const raw = row[ch.closedLoop];
    if (raw === null || raw === undefined || raw === "") continue;
    const s = loop(row);
    if (!s) { unreadable++; if (unreadableValues.size < 5) unreadableValues.add(String(raw)); continue; }
    const cmd = toLambda(num(row, ch.commandedAfr), scale.scale, pcm?.value);
    if (cmd === null) continue;
    rows++;
    const inferredClosed = Math.abs(cmd - 1) <= 0.01;
    if (inferredClosed === s.closed) agree++;
    else if (s.closed) statusClosedInferredOpen++;
    else if (s.reason === "notReady") notReadyAtStoich++;
    else if (s.reason === "accelDecel") decelAtStoich++;
    else statusOpenInferredClosed++;
    if (s.reason === "notReady" && cmd < 0.98) notReadyRich++;
  }
  if (!rows && !unreadable) return null;
  const explained = notReadyAtStoich + decelAtStoich;
  const unexplained = statusClosedInferredOpen + statusOpenInferredClosed;
  const disagreePct = rows ? +(unexplained / rows * 100).toFixed(1) : null;
  const limit = opts.loopDisagreePct ?? 5;
  return {
    channel: parsed.headers[ch.closedLoop], commandedChannel: header,
    rows, agree, agreementPct: rows ? +(agree / rows * 100).toFixed(1) : null,
    explained, unexplained,
    consistentPct: rows ? +((agree + explained) / rows * 100).toFixed(1) : null,
    disagreePct, limitPct: limit, suspect: disagreePct !== null && disagreePct > limit,
    statusClosedInferredOpen, statusOpenInferredClosed, notReadyAtStoich, decelAtStoich, notReadyRich,
    unreadable, unreadableValues: [...unreadableValues],
    basis: "inferred closed loop = commanded within 1% of stoichiometric",
  };
}

// ---------- rows the PCM never sent ----------
// A logger can go on writing rows after the PCM has stopped answering. One
// real log carried 4.8 minutes of engine data and then 60.3 minutes of
// byte-identical rows with the key off: module voltage 0 V, RPM held at its
// last value of 834.75. Analysed as data, those rows produced a VE
// "correction" of ×0.4975 from 102,449 samples of nothing.
export const PCM_SILENCE = {
  minModuleVolts: 8,    // below this the PCM is powering down or off (cranking stays above ~9.5 V)
  frozenSec: 30,        // every channel unchanged this long → not live data
  minFrozenChannels: 4, // a log of a few flags can legitimately sit still
};

export function findPcmSilence(parsed, ch, channelUnits, opts = {}) {
  const P = { ...PCM_SILENCE, ...(opts.pcmSilence || {}) };
  const dead = new Set();
  let voltageRows = 0;
  const vIdx = ch.moduleVoltage;
  const vUsable = vIdx !== undefined && channelUnits.moduleVoltage?.unit === "V";
  if (vUsable) parsed.rows.forEach((r, i) => {
    const v = num(r, vIdx);
    if (v !== null && v < P.minModuleVolts) { dead.add(i); voltageRows++; }
  });

  const ti = ch.time ?? parsed.timeIdx ?? 0;
  const dataCols = parsed.headers.map((_, k) => k).filter(k => k !== ti);
  const frozenRuns = [];
  let frozenRows = 0;
  if (dataCols.length >= P.minFrozenChannels) {
    const same = (a, b) => dataCols.every(k => a[k] === b[k]);
    const live = r => dataCols.some(k => r[k] !== null && r[k] !== undefined && r[k] !== "");
    const close = (a, b) => {
      const t0 = num(parsed.rows[a], ti), t1 = num(parsed.rows[b], ti);
      if (b > a && t0 !== null && t1 !== null && t1 - t0 >= P.frozenSec && live(parsed.rows[a])) {
        // the first row of the run is the last real reading — keep it
        // counted whether or not the voltage rule already caught them — the
        // two are independent evidence, and the total below is de-duplicated
        for (let i = a + 1; i <= b; i++) { frozenRows++; dead.add(i); }
        frozenRuns.push({ from: t0, to: t1, rows: b - a });
      }
    };
    let start = 0;
    for (let i = 1; i < parsed.rows.length; i++)
      if (!same(parsed.rows[i], parsed.rows[i - 1])) { close(start, i - 1); start = i; }
    close(start, parsed.rows.length - 1);
  }
  return {
    dead, rows: dead.size, voltageRows, frozenRows, frozenRuns,
    voltageChannel: vUsable ? parsed.headers[vIdx] : null,
    minModuleVolts: P.minModuleVolts, frozenSec: P.frozenSec,
  };
}

// ---------- wideband validity ----------
// A wideband controller that is off or still heating is not reporting a
// mixture. Over the MPVI's analog input the AEM read 7.3125 AFR (λ 0.497)
// with no power, then λ 0.50–0.53 for 27 s after key-on while it heated —
// and those samples became "190 power-enrichment samples at λ 0.526" and VE
// multipliers of ×0.5. No running engine sits below λ 0.60, so a reading
// below that is the controller, not the engine. Rich is the side to bound:
// a reading pegged LEAN may be the engine and must stay visible.
export const WIDEBAND_VALID = {
  minLambda: 0.6,
  settleSec: 2,         // ignore this long after an invalid stretch ends
};

export function makeWidebandReader(parsed, ch, scale, stoich, opts = {}) {
  const W = { ...WIDEBAND_VALID, ...(opts.widebandValid || {}) };
  const ti = ch.time ?? parsed.timeIdx;
  const values = new Map();
  const stats = { implausible: 0, settling: 0, minLambda: W.minLambda, settleSec: W.settleSec, runs: [] };
  let lastBad = null;
  for (const row of parsed.rows) {
    const l = toLambda(num(row, ch.widebandAfr), scale, stoich);
    if (l === null) continue;
    const t = num(row, ti);
    if (l < W.minLambda) {
      stats.implausible++;
      if (t !== null) {
        const r = stats.runs.at(-1);
        if (r && t - r.tEnd <= 1) r.tEnd = t; else stats.runs.push({ t, tEnd: t });
        lastBad = t;
      }
      continue;
    }
    if (t !== null && lastBad !== null && t - lastBad < W.settleSec) { stats.settling++; continue; }
    values.set(row, l);
  }
  return { read: row => values.get(row) ?? null, stats };
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
  // Compare against everything within this window, not just the previous row.
  // Channels log at their own intervals (TPS every 200 ms here) on a 100 ms
  // grid, so a throttle ramp is a jump followed by a HELD row — and the held
  // row has a delta of exactly zero. Comparing one row back let ~9% of
  // transient rows into the trim statistics on a real log.
  transientWindowMs: 300,
  minRpm: 500,        // running
  requireClosedLoop: true,
  excludePe: true,
};

export function filterRows(parsed, ch, opts = {}, channelUnits = {}, scales = null) {
  const f = { ...DEFAULT_FILTERS, ...opts };
  const kept = [];
  const warnings = [];
  // noData: a row carrying nothing at all (the gap between two logging
  // sessions, or after every channel has expired). It used to fall through to
  // "no trim data", which blamed the trims for rows that simply had no data.
  // incompleteTrim: both trim channels exist in this log but only one is live
  // on this row; summing it as if the other were zero biases the bin.
  // loopUnknown: the status channel is logged but has no reading on this row
  // (expired, or a value that is not a fuel system state) — not "open loop".
  const rejected = { noData: 0, cold: 0, openLoop: 0, loopUnknown: 0, powerEnrich: 0, transient: 0,
                     notRunning: 0, incompleteTrim: 0, noTrimData: 0 };
  const hasL = ch.ltft !== undefined && (!Array.isArray(ch.ltft) || ch.ltft.length > 0);
  const hasS = ch.stft !== undefined && (!Array.isArray(ch.stft) || ch.stft.length > 0);
  const keyRoles = ["rpm", "tps", "mafHz", "ect", "map"].map(r => ch[r]).filter(i => i !== undefined)
    .concat(hasL ? [].concat(ch.ltft) : [], hasS ? [].concat(ch.stft) : []);
  const windowSec = (f.transientWindowMs ?? 300) / 1000;
  const loop = makeLoopReader(parsed, ch);

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
    const s = (scales || resolveScales(parsed, ch, {})).cmd;
    // Commanded AFR is divided by the PCM's stoich, never a hardcoded 14.7:
    // this PCM uses 14.12, so 14.12/14.7 = 0.9605 read every closed-loop row
    // as enrichment and the trim analysis kept 1 row of 21,078.
    const pcm = s.scale === "afr" ? resolveStoichs(parsed, ch, opts).pcm : null;
    if (s.scale === "afr" && !pcm) {
      warnings.push(`“${cmdHeader}” is commanded AFR but the PCM's stoichiometric ratio could not be established from this log, so it was not used to detect power enrichment. Set it under the wideband options to enable this.`);
    } else if (s.scale === "lambda" || s.scale === "eq" || s.scale === "afr") {
      const rich = v => (s.scale === "eq" ? v > 1.02 : s.scale === "afr" ? v / pcm.value < 0.98 : v < 0.98);
      peProxy = { column: cmdHeader, scale: s.scale, basis: s.basis, test: rich };
      warnings.push(`No power-enrichment or closed-loop flag in this log, so “${cmdHeader}” was used to detect PE instead: any sample commanding richer than stoichiometric is treated as power enrichment (${s.basis}). This is an inference — log Fuel System Status or a PE flag to remove the guesswork.`);
    }
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    if (keyRoles.length && keyRoles.every(k => num(row, k) === null)) { rejected.noData++; continue; }
    if (peProxy) {
      const c = num(row, ch.commandedAfr);
      if (c !== null && peProxy.test(c)) { rejected.powerEnrich++; continue; }
    }
    const rpm = num(row, ch.rpm);
    if (rpm !== null && rpm < f.minRpm) { rejected.notRunning++; continue; }

    const ect = num(row, ch.ect);
    if (ectThreshold && ect !== null && ect < ectThreshold.value) { rejected.cold++; continue; }

    if (f.requireClosedLoop && loop) {
      const s = loop(row);
      if (!s) { rejected.loopUnknown++; continue; }
      if (!trimsValid(s)) { rejected.openLoop++; continue; }
    }
    if (f.excludePe && ch.pe !== undefined && isOn(row[ch.pe])) { rejected.powerEnrich++; continue; }

    // Look back across the whole window. Null-safe: a missing value is not a
    // zero, and treating it as one manufactured huge deltas against real data.
    const tNow = num(row, ch.time);
    let moved = false;
    for (let k = i - 1; k >= 0; k--) {
      const q = parsed.rows[k];
      const tq = num(q, ch.time);
      if (tNow !== null && tq !== null) { if (tNow - tq > windowSec) break; }
      else if (i - k > 1) break;              // no time column: previous row only
      const a1 = num(row, ch.tps), b1 = num(q, ch.tps);
      const a2 = rpm, b2 = num(q, ch.rpm);
      if ((a1 !== null && b1 !== null && Math.abs(a1 - b1) > f.maxTpsDelta) ||
          (a2 !== null && b2 !== null && Math.abs(a2 - b2) > f.maxRpmDelta)) { moved = true; break; }
    }
    if (moved) { rejected.transient++; continue; }

    const ltft = avgOf(row, ch.ltft), stft = avgOf(row, ch.stft);
    if (ltft === null && stft === null) { rejected.noTrimData++; continue; }
    if (hasL && hasS && (ltft === null) !== (stft === null)) { rejected.incompleteTrim++; continue; }

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
  // A NAME saying "equivalence ratio" does not say which way it runs. SAE
  // J1979 calls its commanded λ the "equivalence ratio" — HP Tuners logs it as
  // "Equivalence Ratio Commanded", below 1 rich — while GM's enhanced EQ is
  // fuel/air, above 1 rich. Believing the name inverted the mixture on any log
  // exported without units. resolveScales() decides it from the data instead.
  if (fromName === "eq")
    return { scale: "ratio-ambiguous", nameHint: "eq",
             basis: "the name says equivalence ratio but no unit is stated — λ and EQ run in opposite directions",
             assumedLambda: true };
  if (fromName) return { scale: fromName, basis: "stated in the channel name" };
  const vals = sampleValues.filter(Number.isFinite);
  if (!vals.length) return { scale: null, basis: "no numeric samples" };
  const med = vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  if (med > 5) return { scale: "afr", basis: `inferred from magnitude (median ${med.toFixed(2)})` };
  return { scale: "ratio-ambiguous", basis: `values near 1.0 (median ${med.toFixed(3)}) — could be lambda or EQ; assuming lambda`, assumedLambda: true };
}

// ---------- the two stoichs ----------
// An AFR number is only meaningful alongside the stoichiometric ratio it was
// produced with, and a log carries AFRs produced with TWO different ones:
//
//   wideband AFR   = measured lambda x the CONTROLLER's display stoich.
//                    Lambda is what the sensor measures; the AFR shown is a
//                    presentation choice. a CAN wideband controller and most controllers
//                    default to 14.7 regardless of the fuel in the tank.
//   commanded AFR  = commanded lambda x the PCM's stoich. This car's PCM uses
//                    14.12 — derived from 7,024 paired closed-loop samples.
//
// Using one number for both is what broke. With only an AFR commanded channel,
// 14.12 / 14.7 = lambda 0.9605 in closed loop, so every closed-loop row read as
// power enrichment: trim analysis kept 1 row of 21,078, and the VE grid —
// silently — computed corrections from closed-loop cruise data.
//
// The fuel in the tank affects neither conversion. It is used only to turn a
// lambda back into an AFR for display.
export const WIDEBAND_DEFAULT_STOICH = 14.7;

export function resolveStoichs(parsed, ch, opts = {}) {
  const wb = opts.widebandStoich != null
    ? { value: +opts.widebandStoich, basis: "set manually" }
    : { value: WIDEBAND_DEFAULT_STOICH,
        basis: "controller default (14.7 gasoline display) — set it if your wideband displays another fuel" };
  if (opts.pcmStoich != null) return { wb, pcm: { value: +opts.pcmStoich, basis: "set manually" } };

  const sample = i => parsed.rows.map(r => num(r, i)).filter(v => v !== null);
  let lam = null, afr = null;
  for (const i of (detectCandidates(parsed.headers).commandedAfr || [])) {
    const s = detectScale(parsed.headers[i], sample(i).slice(0, 400));
    // at stoich λ and EQ are both 1.00, so direction does not matter here
    if (!lam && (s.scale === "lambda" || s.scale === "eq" || s.scale === "ratio-ambiguous")) lam = { i, scale: s.scale };
    if (!afr && s.scale === "afr") afr = { i };
  }
  if (!afr) return { wb, pcm: null };          // nothing commanded in AFR: nothing to convert

  // Best: the PCM states both, so its stoich is simply AFR / lambda.
  if (lam) {
    const ratios = [];
    for (const r of parsed.rows) {
      const a = num(r, afr.i), l0 = num(r, lam.i);
      if (a === null || l0 === null || l0 === 0) continue;
      // key on, engine off: commanded AFR shows a priming figure (5.4 on this
      // car) while commanded λ sits at 1.00 — not a stoich pair
      const rpm = num(r, ch.rpm);
      if (rpm !== null && rpm < 400) continue;
      const l = lam.scale === "eq" ? 1 / l0 : l0;
      if (Math.abs(l - 1) <= 0.02) ratios.push(a / l);   // closed-loop pairs only
    }
    if (ratios.length >= 20) {
      ratios.sort((x, y) => x - y);
      const v = ratios[Math.floor(ratios.length / 2)];
      return { wb, pcm: { value: +v.toFixed(3),
        basis: `derived from ${ratios.length} closed-loop samples: commanded AFR / commanded λ` } };
    }
  }
  // Otherwise: closed-loop cruise dominates any normal log, and in closed loop
  // the PCM commands exactly stoich — so the most common commanded AFR IS the
  // stoich. Required to be a clear majority, or it is not that plateau.
  const vals = sample(afr.i);
  if (vals.length >= 20) {
    const counts = new Map();
    for (const v of vals) { const k = v.toFixed(2); counts.set(k, (counts.get(k) || 0) + 1); }
    const [mode, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / vals.length >= 0.4)
      return { wb, pcm: { value: +mode,
        basis: `inferred: ${(100 * n / vals.length).toFixed(0)}% of commanded AFR sits at ${mode}, the closed-loop plateau` } };
  }
  return { wb, pcm: null };                    // refuse rather than assume 14.7
}

/** Everything is compared in lambda: 1.0 = stoich, <1 rich, >1 lean. */
export function toLambda(value, scale, stoich) {
  if (value == null || !Number.isFinite(value)) return null;
  if (scale === "afr") return stoich ? value / stoich : null;   // unknown stoich: refuse
  if (scale === "eq") return value === 0 ? null : 1 / value;
  return value;                       // lambda, or ratio assumed to be lambda
}

// ---------- λ or EQ, from the data ----------
// A ratio channel with no unit is λ (below 1 rich) or EQ (above 1 rich), and
// guessing wrong inverts every lean/rich verdict. Physics settles it where the
// log allows; only with no evidence at all is λ assumed, and said so loudly.
//   commanded: a paired commanded-AFR channel moves WITH λ and AGAINST EQ;
//              and no PCM commands lean at wide-open throttle.
//   wideband:  a narrowband O2 reading rich (> 0.6 V) means λ is lower; and
//              when the PCM commands rich, measured λ goes down.
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const cv = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) / Math.abs(m); };

function resolveCommandedRatio(parsed, ch, s) {
  const x = ch.commandedAfr;
  const others = (detectCandidates(parsed.headers).commandedAfr || []).filter(i => i !== x);
  for (const a of others) {
    const sa = detectScale(parsed.headers[a], parsed.rows.map(r => num(r, a)).filter(v => v !== null).slice(0, 400));
    if (sa.scale !== "afr") continue;
    // Stoich rows stay in: they are what gives the ratio something to vary
    // against. With no variation both products are constant and prove nothing.
    const q = [], p = [], vs = [];
    for (const r of parsed.rows) {
      const v = num(r, x), afr = num(r, a), rpm = num(r, ch.rpm);
      if (v === null || afr === null || v <= 0 || (rpm !== null && rpm < 400)) continue;
      q.push(afr / v); p.push(afr * v); vs.push(v);
    }
    if (q.length >= 20 && cv(vs) >= 0.01) {
      const cq = cv(q), cp = cv(p);
      if (cq < 0.02 && cq < cp / 2.5) return { scale: "lambda", basis: `no unit stated; λ, because it moves with “${parsed.headers[a]}” (commanded AFR ÷ it varies ${(cq * 100).toFixed(2)}%, × it varies ${(cp * 100).toFixed(2)}%, over ${q.length} rows)`, resolved: true };
      if (cp < 0.02 && cp < cq / 2.5) return { scale: "eq", basis: `no unit stated; EQ, because it moves against “${parsed.headers[a]}” (commanded AFR × it varies ${(cp * 100).toFixed(2)}%, ÷ it varies ${(cq * 100).toFixed(2)}%, over ${p.length} rows)`, resolved: true };
    }
  }
  if (ch.tps !== undefined && unitFits("tps", parsed.headers[ch.tps]).declared) {
    const wot = [];
    for (const r of parsed.rows) {
      const t = num(r, ch.tps), v = num(r, x);
      if (t !== null && v !== null && t >= 80 && Math.abs(v - 1) > 0.02) wot.push(v);
    }
    if (wot.length >= 10) {
      const med = wot.slice().sort((a, b) => a - b)[wot.length >> 1];
      if (med < 1) return { scale: "lambda", basis: `no unit stated; λ, because it falls below 1.00 at wide-open throttle (median ${med.toFixed(3)} over ${wot.length} samples) and no PCM commands lean there`, resolved: true };
      return { scale: "eq", basis: `no unit stated; EQ, because it rises above 1.00 at wide-open throttle (median ${med.toFixed(3)} over ${wot.length} samples) and no PCM commands lean there`, resolved: true };
    }
  }
  return s;
}

function resolveWidebandRatio(parsed, ch, s, cmdScale, opts) {
  const x = ch.widebandAfr;
  const plausible = v => v > 0.55 && v < 1.8;       // either reading; excludes the off/heating floor
  const o2 = parsed.headers.map((h, i) => ({ h, i }))
    .filter(({ h }) => /\bo2\b/i.test(h) && /(b(ank)?\s*[12]\s*s(ensor)?\s*1)\b|b[12]s1/i.test(h) && detectUnit(h)?.unit === "V")
    .map(({ i }) => i);
  if (o2.length) {
    const hi = [], lo = [];
    for (const r of parsed.rows) {
      const v = num(r, x);
      const volts = o2.map(i => num(r, i)).filter(w => w !== null);
      if (v === null || !plausible(v) || !volts.length) continue;
      const o = mean(volts);
      if (o > 0.6) hi.push(v); else if (o < 0.3) lo.push(v);
    }
    if (hi.length >= 50 && lo.length >= 50) {
      const mh = mean(hi), ml = mean(lo);
      const what = `${mh.toFixed(3)} when the narrowband O2 sensors read rich vs ${ml.toFixed(3)} when they read lean`;
      if (mh < ml * 0.995) return { scale: "lambda", basis: `no unit stated; λ, because it reads lower when the O2 sensors say rich (${what})`, resolved: true };
      if (mh > ml * 1.005) return { scale: "eq", basis: `no unit stated; EQ, because it reads higher when the O2 sensors say rich (${what})`, resolved: true };
    }
  }
  if (ch.commandedAfr !== undefined && cmdScale && ["lambda", "eq", "afr"].includes(cmdScale.scale)) {
    const pcm = cmdScale.scale === "afr" ? resolveStoichs(parsed, ch, opts).pcm : null;
    const rich = [], stoich = [];
    for (const r of parsed.rows) {
      const v = num(r, x);
      const c = toLambda(num(r, ch.commandedAfr), cmdScale.scale, pcm?.value);
      if (v === null || c === null || !plausible(v)) continue;
      if (c < 0.95) rich.push(v); else if (Math.abs(c - 1) <= 0.01) stoich.push(v);
    }
    if (rich.length >= 10 && stoich.length >= 20) {
      const mr = mean(rich), ms = mean(stoich);
      const what = `${mr.toFixed(3)} while rich was commanded vs ${ms.toFixed(3)} at stoich`;
      if (mr < ms * 0.99) return { scale: "lambda", basis: `no unit stated; λ, because it falls when the PCM commands rich (${what})`, resolved: true };
      if (mr > ms * 1.01) return { scale: "eq", basis: `no unit stated; EQ, because it rises when the PCM commands rich (${what})`, resolved: true };
    }
  }
  return s;
}

export function resolveScales(parsed, ch, opts = {}) {
  const sample = i => parsed.rows.map(r => num(r, i)).filter(v => v !== null).slice(0, 400);
  const out = { cmd: null, wb: null };
  if (ch.commandedAfr !== undefined) {
    out.cmd = opts.commandedScale ? { scale: opts.commandedScale, basis: "set manually" }
      : detectScale(parsed.headers[ch.commandedAfr], sample(ch.commandedAfr));
    if (out.cmd.scale === "ratio-ambiguous") out.cmd = resolveCommandedRatio(parsed, ch, out.cmd);
  }
  if (ch.widebandAfr !== undefined) {
    out.wb = opts.widebandScale ? { scale: opts.widebandScale, basis: "set manually" }
      : detectScale(parsed.headers[ch.widebandAfr], sample(ch.widebandAfr));
    if (out.wb.scale === "ratio-ambiguous") out.wb = resolveWidebandRatio(parsed, ch, out.wb, out.cmd, opts);
  }
  return out;
}

export function analyzeWideband(parsed, ch, channelUnits, opts = {}) {
  const wbIdx = ch.widebandAfr, cmdIdx = ch.commandedAfr;
  if (wbIdx === undefined) return { present: false, reason: "no wideband channel found in this log" };

  const fuel = FUELS[opts.fuel] || FUELS.gasoline;      // display only
  const stoichs = resolveStoichs(parsed, ch, opts);
  const col = i => parsed.rows.map(r => num(r, i)).filter(v => v !== null);
  const scales = opts.scales || resolveScales(parsed, ch, opts);
  const wbScale = scales.wb;
  const cmdScale = cmdIdx === undefined ? null : scales.cmd;

  // Two lean tests, because one was not enough. The absolute limit only catches
  // "leaner than stoichiometric at WOT", which is already catastrophic: a bin
  // commanding 0.85 and getting 0.95 — 11.8% leaner than asked, and enough to
  // hurt an engine — passed it, and the UI showed a green checkmark. Lean OF
  // TARGET is what matters, so that is the primary test; the absolute limit
  // stays as a backstop for when no commanded channel was logged.
  const leanLimit = opts.wotLeanLambda ?? 1.0;      // absolute backstop, λ
  const leanMargin = opts.wotLeanMarginPct ?? 3;    // % leaner than commanded
  const wotTps = opts.wotTps ?? 80;                 // % throttle counted as WOT

  const wotByRpm = new Map();
  let wotSamples = 0, leanWotSamples = 0, worstWot = null;
  const leanRuns = [];
  const clPairs = [];
  const loop = makeLoopReader(parsed, ch);
  const isWarmup = makeWarmupTest(parsed, ch, channelUnits, opts);
  const wbReader = makeWidebandReader(parsed, ch, wbScale.scale, stoichs.wb.value, opts);
  let warmupExcluded = 0;
  const clProxy = ch.closedLoop === undefined && cmdIdx !== undefined
    && (cmdScale.scale === "lambda" || cmdScale.scale === "eq" || cmdScale.scale === "afr");

  for (const row of parsed.rows) {
    const wb = wbReader.read(row);
    if (wb === null) continue;
    const cmd = cmdIdx === undefined ? null : toLambda(num(row, cmdIdx), cmdScale.scale, stoichs.pcm?.value);
    const tps = num(row, ch.tps);
    const rpm = num(row, ch.rpm);
    const pe = ch.pe !== undefined && isOn(row[ch.pe]);
    const status = loop ? loop(row) : null;
    // With no Fuel System Status channel, commanding stoichiometric IS the
    // closed-loop condition — the PCM only targets λ 1.00 when it is trimming
    // to the narrowband. Reported as an inference, never assumed silently.
    const cl = loop ? (status ? trimsValid(status) : null)
      : (clProxy && cmd !== null ? Math.abs(cmd - 1) <= 0.01 : null);
    // Power enrichment is the region that matters, whatever the throttle says.
    // Requiring TPS >= 80% or a PE flag found ZERO qualifying samples on a real
    // log with no PE channel and a 72.9% throttle peak — while 9 cells ran more
    // than 3% lean of commanded, up to +8.8%. Commanding richer than stoich IS
    // enrichment; used only when there is no real PE flag, and disclosed.
    // Fuel System Status narrows it: rich while closed loop is a transition
    // artefact, and rich in "OL - Not Ready" is warm-up enrichment — 549 rows
    // of one real log were cold start, judged as if they were a WOT pull.
    let enrichCommanded = ch.pe === undefined && cmd !== null && cmd < 0.98;
    if (enrichCommanded && status && (status.closed || isWarmup(status, row))) {
      enrichCommanded = false;
      if (!status.closed) warmupExcluded++;
    }
    const atWot = pe || (tps !== null && tps >= wotTps) || enrichCommanded;

    if (atWot && rpm !== null) {
      // This is the region trims can't see and where lean actually hurts.
      const key = Math.floor(rpm / 500) * 500;
      if (!wotByRpm.has(key)) wotByRpm.set(key, { from: key, to: key + 500, n: 0, sumWb: 0,
                                                   pairN: 0, pairWb: 0, pairCmd: 0, leanest: null });
      const b = wotByRpm.get(key);
      b.n++; b.sumWb += wb;
      // The error must come from PAIRED samples. Averaging every wideband row
      // against only the rows that also carried commanded compared two
      // different populations, and inflated an on-target bin to 14.7% lean.
      if (cmd !== null) { b.pairN++; b.pairWb += wb; b.pairCmd += cmd; }
      if (b.leanest === null || wb > b.leanest) b.leanest = wb;
      wotSamples++;
      if (wb > leanLimit || (cmd !== null && wb > cmd * (1 + leanMargin / 100))) {
        leanWotSamples++;
        // contiguous lean samples (gaps under 1 s) form one run, for the timeline
        const t = num(row, ch.time ?? parsed.timeIdx);
        const last = leanRuns.at(-1);
        if (t !== null && last && t - last.tEnd <= 1) {
          last.tEnd = t; last.samples++;
          if (wb > last.worstLambda) Object.assign(last, { worstLambda: +wb.toFixed(3), commanded: cmd === null ? null : +cmd.toFixed(3), rpm });
        } else if (t !== null) leanRuns.push({ t, tEnd: t, samples: 1, worstLambda: +wb.toFixed(3), commanded: cmd === null ? null : +cmd.toFixed(3), rpm });
      }
      if (!worstWot || wb > worstWot.lambda) worstWot = { lambda: +wb.toFixed(3), rpm, tps, commanded: cmd === null ? null : +cmd.toFixed(3) };
    }
    if (cl === true && !pe && cmd !== null) clPairs.push({ wb, cmd });
  }

  const asAfr = l => +(l * fuel.stoich).toFixed(2);
  const wot = [...wotByRpm.values()].sort((a, b) => a.from - b.from).map(b => {
    const errorPct = b.pairN ? +((b.pairWb / b.pairCmd - 1) * 100).toFixed(1) : null;
    const avg = b.sumWb / b.n;
    return {
      from: b.from, to: b.to, n: b.n, pairedSamples: b.pairN,
      avgLambda: +avg.toFixed(3),
      avgAfr: asAfr(avg),
      commandedLambda: b.pairN ? +(b.pairCmd / b.pairN).toFixed(3) : null,
      commandedAfr: b.pairN ? asAfr(b.pairCmd / b.pairN) : null,
      errorPct,
      leanestLambda: +b.leanest.toFixed(3),
      leanOfTarget: errorPct !== null && errorPct > leanMargin,
      lean: avg > leanLimit || (errorPct !== null && errorPct > leanMargin),
    };
  });

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
    stoichs,
    wotDefinition: { pePreferred: ch.pe !== undefined, tpsThresholdPct: wotTps,
                     leanLimitLambda: leanLimit, leanMarginPct: leanMargin,
                     enrichmentProxy: ch.pe === undefined && cmdIdx !== undefined
                       ? (loop ? "commanded mixture richer than λ 0.98 while Fuel System Status reports open loop, excluding warm-up — no PE channel was logged"
                               : "commanded mixture richer than λ 0.98 — no PE channel was logged") : null,
                     warmupExcluded },
    wotSamples, leanWotSamples,
    worstWot,
    leanRuns,
    sensorInvalid: wbReader.stats,
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
  // GM knock retard is applied instantly and then DECAYS back toward zero.
  // Only a rise is knock; an equal value is a held sample and a falling one is
  // recovery. Attributing every non-zero value smeared one real event across
  // every cell the engine passed through while retard recovered: on a real log,
  // knock in 2 cells was reported in 6, and the grid would have pulled timing
  // from four cells that never knocked.
  let prevKr = 0;
  const RISE = 0.04;   // GM retard moves in ~0.088° steps; anything above noise

  // GM logs retard as a positive number. A tool that logs it negative (as a
  // timing correction) would have had every event ignored — only values at or
  // above +0.1° counted. All-negative is read as magnitude; mixed signs are
  // read as logged and flagged, because positive may then mean advance.
  let krSign = 1, krSignNote = null;
  if (krIdx !== undefined) {
    let lo = Infinity, hi = -Infinity;
    for (const r of parsed.rows) { const v = num(r, krIdx); if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (hi <= RISE && lo <= -krThreshold) {
      krSign = -1;
      krSignNote = `is logged as negative numbers (down to ${+lo.toFixed(2)}°), so its magnitude was read as knock retard. Confirm that negative means retard for this channel.`;
    } else if (lo <= -krThreshold && hi >= krThreshold) {
      krSignNote = `has both positive (up to ${+hi.toFixed(2)}°) and negative (down to ${+lo.toFixed(2)}°) values. Positive values were read as knock retard — if this channel logs retard as negative, knock has been missed. Check its sign convention.`;
    }
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const rpm = num(row, ch.rpm);
    if (rpm !== null && rpm < 500) { if (cur) { events.push(cur); cur = null; } prevKr = 0; continue; }
    running++;
    let y = yRole ? num(row, ch[yRole]) : null;
    if (y !== null && yScale) y = yScale(y);
    const krRaw = krIdx === undefined ? null : num(row, krIdx);
    const kr = krRaw === null ? null : krRaw * krSign;
    const adv = ch.spark === undefined ? null : num(row, ch.spark);
    const iat = num(row, ch.iat), ect = num(row, ch.ect), tps = num(row, ch.tps);

    if (rpm !== null && y !== null) {
      const key = `${Math.floor(rpm / rpmBin) * rpmBin}|${Math.floor(y / loadBin) * loadBin}`;
      if (kr !== null) {
        const c = krCells.get(key) || { x: Math.floor(rpm / rpmBin) * rpmBin, y: Math.floor(y / loadBin) * loadBin, n: 0, max: 0, hits: 0, iatSum: 0, iatN: 0 };
        c.n++;
        // Credit the cell only where retard ROSE above its previous value.
        if (kr >= krThreshold && kr > prevKr + RISE) {
          if (kr > c.max) c.max = kr;
          c.hits++;
          if (iat !== null) { c.iatSum += iat; c.iatN++; }   // IAT at the moment of knock
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
      if (!cur) cur = { startRow: i, peakRow: i, samples: 0, peakKr: 0, rpmAt: rpm, rpmMin: rpm, rpmMax: rpm, load: y, iat, ect, tps, spark: adv };
      cur.samples++;
      if (kr > cur.peakKr) { cur.peakKr = kr; cur.peakRow = i; cur.rpmAt = rpm; cur.load = y; cur.iat = iat; cur.spark = adv; }
      if (rpm !== null) { cur.rpmMin = Math.min(cur.rpmMin ?? rpm, rpm); cur.rpmMax = Math.max(cur.rpmMax ?? rpm, rpm); }
      if (!worst || kr > worst.kr) worst = { kr: +kr.toFixed(2), rpm, load: y, iat, spark: adv, tps };
    } else if (cur) { events.push(cur); cur = null; }
    if (kr !== null) prevKr = kr;
  }
  if (cur) events.push(cur);

  const round = (v, d = 2) => (v == null ? null : +v.toFixed(d));
  const evs = events.map(e => ({
    samples: e.samples, peakKr: round(e.peakKr), rpm: e.rpmAt,
    t: num(parsed.rows[e.peakRow], ch.time ?? parsed.timeIdx),
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
    krSignNote, krSign,
    iatUnit,
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

// ---------- which column plays which role ----------
// Roles were assigned by column order alone, which picked a channel because of
// where it sat rather than what it was. Two consequences that could hide
// exactly what this app exists to catch:
//   - "Air-Fuel Ratio Commanded [AFR]" matched the wideband pattern on its
//     unit, so commanded was compared with ITSELF: a constant −3.9% (the ratio
//     of the two stoichs) whatever the engine did, and lean never reported.
//   - "Throttle Position Sensor [V]" sat before "Throttle Position (SAE) [%]",
//     so throttle was read in volts: never ≥ 80% (no WOT), always < 25% (every
//     knock event labelled possible false knock), and transients let through.
// A candidate whose declared unit does not fit the role is now refused, a
// commanded/target channel can never be the measurement, and one column can
// never fill both mixture roles.
export const ROLE_UNITS = {
  tps: ["%"], ltft: ["%"], stft: ["%"], knockRetard: ["°"], spark: ["°"],
  mafHz: ["Hz"], rpm: ["RPM"], moduleVoltage: ["V"], injectorPw: ["ms"],
  map: "pressure", ect: "temperature", iat: "temperature", mafGs: "airflow", dynAir: "airflow",
  commandedAfr: ["λ", "AFR", "EQ", "eq"], widebandAfr: ["λ", "AFR", "EQ", "eq"],
};
const COMMANDED_WORDS = /command|\bcmd\b|target|desired|request/i;

export function unitFits(role, header) {
  const want = ROLE_UNITS[role];
  const u = detectUnit(header);
  // bracketed text that is not a recognised unit ("(wideband)", "(SAE)") is
  // part of the name, so it neither qualifies nor disqualifies a channel
  if (!want || !u || !u.unit || !u.known) return { fits: true, declared: false, unit: null };
  const fits = Array.isArray(want) ? want.some(w => w.toLowerCase() === u.unit.toLowerCase()) : u.quantity === want
    // psig is a pressure, but refused later with its own reason
    || (want === "pressure" && u.unit === "psig");
  return { fits, declared: true, unit: u.unit };
}

// Trims logged as multipliers (1.05 = +5%) would be summed as if they were
// percent. A % trim goes negative somewhere in any real log; a multiplier
// never does, and sits near 1.
function looksLikeMultiplier(parsed, idx) {
  let n = 0, inBand = 0;
  for (const r of parsed.rows) {
    const v = num(r, idx);
    if (v === null) continue;
    n++;
    if (v <= 0) return false;
    if (v > 0.7 && v < 1.3) inBand++;
  }
  return n >= 20 && inBand === n;
}

function rankPool(role, pool, parsed, taken) {
  const refused = [];
  const ok = [];
  for (const i of pool) {
    const h = parsed.headers[i];
    if (role === "widebandAfr" && (COMMANDED_WORDS.test(h) || taken.has(i))) {
      refused.push({ column: h, why: "it is a commanded or target value, not a measurement" });
      continue;
    }
    const f = unitFits(role, h);
    if (!f.fits) { refused.push({ column: h, why: `its unit is ${f.unit}, and ${role} needs ${[].concat(ROLE_UNITS[role]).join(" or ")}` }); continue; }
    if ((role === "ltft" || role === "stft") && !f.declared && looksLikeMultiplier(parsed, i)) {
      refused.push({ column: h, why: "it states no unit and every value sits between 0.7 and 1.3 with none negative — it looks like a multiplier, not a percentage" });
      continue;
    }
    ok.push({ i, declared: f.declared, unit: f.unit });
  }
  // declared-and-fitting before unstated; for commanded, a ratio channel
  // before an AFR one, because AFR needs the PCM's stoich and a ratio does not
  const rank = c => (c.declared ? 0 : 2) + (role === "commandedAfr" && /^afr$/i.test(c.unit || "") ? 1 : 0);
  ok.sort((a, b) => rank(a) - rank(b));
  return { pool: ok.map(c => c.i), refused };
}

export function analyze(text, opts = {}) {
  const raw = parseCsv(text);
  if (!raw.headers.length) return { error: "no data rows in this CSV" };
  // Interval-logged files have no row where all the needed channels coexist,
  // so they must be put on a common time base before anything else runs.
  const full = raw.sparse ? densify(raw, { intervalMs: opts.intervalMs || 100 }) : raw;
  let parsed = full;
  const chAll = { ...detectChannels(parsed.headers), ...(opts.channels || {}) };

  // A channel can be present in the header and carry no data at all — the
  // wideband was configured but never reported. Left in place, an empty
  // closed-loop flag reads as "not in closed loop" on every row and silently
  // rejects the entire log. Drop them and say so.
  // State channels report TEXT ("CL - Normal"). Counting only numbers called a
  // live Fuel System Status channel empty and threw away 4,057 samples.
  const STATE_ROLES = new Set(["closedLoop", "pe"]);
  const isSample = (v, textOk) => typeof v === "number" || (textOk && typeof v === "string" && v.trim() !== "");
  const hasDataFor = role => i => i !== undefined && parsed.rows.some(r => isSample(r[i], STATE_ROLES.has(role)));
  const candidates = detectCandidates(parsed.headers);
  const ch = {}, silentChannels = [], refusedChannels = [];
  const taken = new Set();
  for (const [role, idx] of Object.entries(chAll)) {
    const overridden = opts.channels && role in opts.channels;
    if (Array.isArray(idx)) {                       // trims: keep every live bank
      const ranked = overridden ? { pool: idx, refused: [] } : rankPool(role, idx, parsed, taken);
      for (const r of ranked.refused) refusedChannels.push({ role, ...r });
      const live = ranked.pool.filter(hasDataFor(role));
      if (live.length) ch[role] = live;
      else if (ranked.pool.length) silentChannels.push({ role, column: parsed.headers[ranked.pool[0]] });
      continue;
    }
    // Single-column role: prefer the first candidate that actually reported.
    // Three wideband channels were configured on this car and only the analog
    // one carried data — taking the first match would have found nothing.
    const ranked = overridden ? { pool: [idx], refused: [] } : rankPool(role, candidates[role] || [idx], parsed, taken);
    for (const r of ranked.refused) refusedChannels.push({ role, ...r });
    const pool = ranked.pool;
    if (!pool.length) continue;
    const hasData = hasDataFor(role);
    const live = pool.find(hasData);
    if (live !== undefined) {
      ch[role] = live;
      if (role === "commandedAfr") taken.add(live);
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
    // bracketed text that is not a unit we recognise ("(SAE)", "(wideband)") is
    // part of the name — reporting it as the unit told the user something false
    channelUnits[role] = { column: header, unit: u?.known === false ? null : (u?.unit ?? null), quantity: u?.quantity ?? null, convertible: !!u?.convertible };
  }

  // Rows written after the PCM stopped answering are removed before ANY
  // analysis sees them — every section below would otherwise treat them as data.
  const silence = findPcmSilence(full, ch, channelUnits, opts);
  if (silence.rows) parsed = { ...full, rows: full.rows.filter((_, i) => !silence.dead.has(i)) };

  const missing = ["mafHz", "ltft", "stft", "ect", "closedLoop", "pe", "tps", "rpm"].filter(r => ch[r] === undefined);
  // λ or EQ decided once, from the data where possible, and used everywhere
  const scales = resolveScales(parsed, ch, opts);
  const ctx = { ...opts, scales };
  const filtered = filterRows(parsed, ch, opts.filters, channelUnits, scales);
  for (const [s, role] of [[scales.cmd, "commandedAfr"], [scales.wb, "widebandAfr"]])
    if (s?.assumedLambda)
      filtered.warnings.push(`“${parsed.headers[ch[role]]}” states no unit and the log holds no evidence of which way it runs, so it was read as λ (below 1.00 = rich, the SAE convention). If it is EQ (above 1.00 = rich), every lean/rich figure is INVERTED — set its scale in the wideband options.`);
  for (const role of new Set(refusedChannels.map(r => r.role)))
    if (ch[role] === undefined)
      filtered.warnings.push(`No usable ${role} channel: ${refusedChannels.filter(r => r.role === role).map(r => `“${r.column}” was not used because ${r.why}`).join("; ")}.`);
  filtered.rejected = { pcmSilent: silence.rows, ...filtered.rejected };
  if (silence.rows) {
    const parts = [];
    if (silence.voltageRows) parts.push(`“${silence.voltageChannel}” below ${silence.minModuleVolts} V on ${silence.voltageRows.toLocaleString()} (key off or powering down)`);
    if (silence.frozenRuns.length) parts.push(`every channel identical for ${silence.frozenSec} s or more on ${silence.frozenRows.toLocaleString()} (${silence.frozenRuns.map(r => `${r.from.toFixed(1)}–${r.to.toFixed(1)} s`).join(", ")})`);
    filtered.warnings.push(`${silence.rows.toLocaleString()} rows were written after the PCM stopped reporting and were left out of every analysis — ${parts.join("; ")}${parts.length > 1 ? "; the two overlap" : ""}. The logger kept recording without fresh data.`);
  }
  for (const s of silentChannels)
    filtered.warnings.push(s.superseded
      // a dead channel that another live column covers is a note, not a gap
      ? `“${s.column}” was logged but contains no samples — “${s.superseded}” is being used for ${s.role} instead. Worth removing the dead channel from the layout.`
      : `“${s.column}” was logged but contains no samples, so the ${s.role} check was skipped. The channel is in your scanner layout but the device never reported.`);
  const loopCheck = crossCheckLoop(parsed, ch, ctx);
  const wideband = analyzeWideband(parsed, ch, channelUnits, ctx);
  if (wideband.present && wideband.sensorInvalid?.implausible) {
    const v = wideband.sensorInvalid;
    filtered.warnings.push(`“${wideband.channel}” read richer than λ ${v.minLambda} on ${v.implausible.toLocaleString()} samples — the controller was off or still heating, not the engine running that rich. Those samples, and ${v.settleSec} s after each stretch (${v.settling.toLocaleString()} more), were left out of the wideband and VE analysis.`);
  }
  if (loopCheck?.suspect)
    filtered.warnings.push(`“${loopCheck.channel}” and the commanded mixture disagree about closed loop on ${loopCheck.disagreePct}% of ${loopCheck.rows} rows (limit ${loopCheck.limitPct}%). The status channel is being trusted — check it is the right channel and that it logs as often as commanded λ before relying on the closed-/open-loop split.`);
  if (loopCheck?.unreadable)
    filtered.warnings.push(`“${loopCheck.channel}” had ${loopCheck.unreadable} value(s) that are not a recognised fuel system state (${loopCheck.unreadableValues.map(v => `“${v}”`).join(", ")}); those rows were treated as unknown loop state.`);
  const spark = analyzeSpark(parsed, ch, channelUnits, ctx);
  if (spark.krSignNote) filtered.warnings.push(`“${spark.krChannel}” ${spark.krSignNote}`);
  const yRole = ch.map !== undefined ? "map" : "load";
  const timeline = buildEvents(full, parsed, ch, channelUnits, { silence, spark, wideband, scales, opts: ctx });
  const math = opts.formulas ? mathChannels(parsed, ch, channelUnits, opts.formulas,
    { scales, stoichs: resolveStoichs(parsed, ch, opts) }) : null;
  return {
    headers: parsed.headers,
    timeline,
    math,
    channels: Object.fromEntries(Object.entries(ch).map(([k, v]) =>
      [k, Array.isArray(v) ? v.map(i => parsed.headers[i]) : parsed.headers[v]])),
    channelUnits,
    missingChannels: missing,
    format: raw.format,
    resampled: parsed.resampled || null,
    // Shown, not buried: a wrong stoich silently rescales every lambda.
    pcmStoich: resolveStoichs(parsed, ch, opts).pcm,
    widebandStoich: resolveStoichs(parsed, ch, opts).wb,
    silentChannels,
    loopCheck,
    emptyChannels: parsed.headers
      .map((h, i) => (parsed.rows.some(r => isSample(r[i], true)) ? null : h))
      .filter(Boolean),
    rowCount: full.rows.length,
    pcmSilence: silence.rows ? { rows: silence.rows, voltageRows: silence.voltageRows, frozenRows: silence.frozenRows,
                                 frozenRuns: silence.frozenRuns, voltageChannel: silence.voltageChannel } : null,
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
    wideband,
    spark,
    airModels: analyzeAirModels(parsed, ch, channelUnits, opts),
    ve: analyzeVE(parsed, ch, channelUnits, ctx),
    scales,
    refusedChannels,
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

  const fuel = FUELS[opts.fuel || "gasoline"] || FUELS.gasoline;   // display only
  const stoichs = resolveStoichs(parsed, ch, opts);
  const wbScale = wb.scale.scale, cmdScale = wb.commandedScale?.scale;
  if (cmdScale === "afr" && !stoichs.pcm)
    return { present: false,
             reason: "commanded mixture is in AFR and the PCM's stoichiometric ratio could not be established from this log, so commanded lambda — and therefore open loop — cannot be determined without guessing" };
  const wbIdx = ch.widebandAfr, cmdIdx = ch.commandedAfr;
  const wbReader = makeWidebandReader(parsed, ch, wbScale, stoichs.wb.value, opts);

  const rpmBin = opts.veRpmBin || 500, loadBin = opts.veLoadBin || 10;
  const minSamples = opts.minSamples || 20;
  const cells = new Map();
  let openLoop = 0, closedLoopSkipped = 0, warmupSkipped = 0, decelSkipped = 0, faultSkipped = 0;
  const loop = makeLoopReader(parsed, ch);
  const isWarmup = makeWarmupTest(parsed, ch, channelUnits, opts);

  for (const row of parsed.rows) {
    const rpm = num(row, ch.rpm), rawMap = num(row, ch.map);
    const meas = wbReader.read(row);
    const cmd = toLambda(num(row, cmdIdx), cmdScale, stoichs.pcm?.value);
    if (rpm === null || rawMap === null || meas === null || cmd === null || rpm < 500) continue;

    // Open loop = the PCM is not trimming to the narrowband. Without Fuel
    // System Status, a commanded mixture away from stoichiometric marks it.
    // With it, the status decides — so a warm session with closed loop
    // disabled counts even at λ 1.00 — and adds vetoes: "OL - Accel/Decel" at
    // λ 1.00 is decel fuel cut (the wideband reads air, and the cell would be
    // "corrected" by 50%), and warm-up open loop is wall-wetting, not VE.
    const status = loop ? loop(row) : null;
    const nearStoich = Math.abs(cmd - 1) <= 0.02;
    if (status ? status.closed : nearStoich) { closedLoopSkipped++; continue; }
    if (status?.reason === "fault") { faultSkipped++; continue; }
    if (isWarmup(status, row)) { warmupSkipped++; continue; }
    if (status?.reason === "accelDecel" && nearStoich) { decelSkipped++; continue; }
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
    openLoopSamples: openLoop, closedLoopSkipped, warmupSkipped, decelSkipped, faultSkipped,
    openLoopBasis: ch.closedLoop !== undefined
      ? `the Fuel System Status channel (${parsed.headers[ch.closedLoop]}), excluding warm-up and decel fuel cut`
      : "commanded mixture more than 2% from stoichiometric — no Fuel System Status channel was logged, so this is an inference",
    rpmBin, loadBin, minSamples,
    cells: list,
    xs: [...new Set(list.map(c => c.x))].sort((a, b) => a - b),
    ys: [...new Set(list.map(c => c.y))].sort((a, b) => b - a),
    units: { load: "kPa", rpm: "RPM", multiplier: "dimensionless ratio", change: "%" },
    note: "Multiply the VE cell by the multiplier — measured richer than commanded means VE is over-estimating air and must come down. Cells below the sample threshold are shown but should not be applied. Draft readings: confirm the wideband's scale and your fuel before touching a table, and change one region at a time.",
  };
}

// ---------- event timeline ----------
// Where in the log things happened, as markers a person can click. Borrowed
// from log viewers (Datazap, NorCal's LogApp): an event is only useful if you
// can see every channel at that instant, so each carries a snapshot.
// Built from what the analysis already found — nothing new is inferred here.
export const EVENT_TYPES = {
  knock:   { label: "Knock retard",                   short: "Knock",        severity: 3 },
  lean:    { label: "Lean of commanded (enrichment)", short: "Lean",         severity: 3 },
  silent:  { label: "PCM not reporting",              short: "PCM silent",   severity: 1 },
  warmup:  { label: "Warm-up / O2 sensors not ready", short: "Warm-up",      severity: 1 },
  dfco:    { label: "Decel fuel cut",                 short: "Decel cut",    severity: 0 },
  wbOff:   { label: "Wideband off or heating",        short: "Wideband off", severity: 1 },
  session: { label: "New logging session",            short: "Session",      severity: 0 },
};
const MAX_EVENTS = 150;

export function buildEvents(full, parsed, ch, channelUnits, { silence, spark, wideband, scales, opts = {} } = {}) {
  const ti = ch.time ?? parsed.timeIdx;
  if (ti === undefined || ti < 0) return { events: [], types: EVENT_TYPES, durationSec: null };
  const times = parsed.rows.map(r => num(r, ti));
  const fullTimes = full.rows.map(r => num(r, ti));
  const t0 = fullTimes.find(t => t !== null) ?? 0;
  const tLast = [...fullTimes].reverse().find(t => t !== null) ?? t0;
  const nearest = t => {
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((times[mid] ?? -Infinity) < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs((times[lo - 1] ?? Infinity) - t) < Math.abs((times[lo] ?? Infinity) - t)) lo--;
    return parsed.rows[lo];
  };
  const snapshot = t => {
    const row = nearest(t);
    if (!row) return [];
    return parsed.headers.map((h, i) => ({ channel: h, value: row[i] }))
      .filter(x => x.value !== null && x.value !== undefined && x.value !== "")
      .map(x => ({ ...x, value: typeof x.value === "number" ? +x.value.toFixed(3) : x.value }));
  };
  const ev = (type, t, tEnd, detail, weight = 0) => ({ type, t: +t.toFixed(2), tEnd: tEnd != null ? +tEnd.toFixed(2) : null,
    label: EVENT_TYPES[type].label, severity: EVENT_TYPES[type].severity, detail, weight });
  const out = [];

  for (const e of spark?.events || []) if (e.t != null)
    out.push(ev("knock", e.t, null, `${e.peakKr}° retard at ${e.rpm} RPM${e.load != null ? `, ${e.load} ${spark.yUnit || ""}` : ""}`, e.peakKr));
  for (const r of wideband?.leanRuns || [])
    out.push(ev("lean", r.t, r.tEnd > r.t ? r.tEnd : null, `λ ${r.worstLambda}${r.commanded != null ? ` against λ ${r.commanded} commanded` : ""} at ${Math.round(r.rpm)} RPM, ${r.samples} sample(s)`,
      r.commanded ? r.worstLambda / r.commanded : r.worstLambda));
  for (const r of wideband?.sensorInvalid?.runs || [])
    out.push(ev("wbOff", r.t, r.tEnd > r.t ? r.tEnd : null, "readings richer than λ 0.60 — the controller, not the engine", r.tEnd - r.t));

  // PCM-silent stretches, from the rows removed before analysis
  if (silence?.dead?.size) {
    let start = null, prev = null;
    const close = () => { if (start !== null) out.push(ev("silent", start, prev > start ? prev : null, `no fresh data from ${start.toFixed(1)} s to ${prev.toFixed(1)} s`, prev - start)); start = null; };
    full.rows.forEach((r, i) => {
      const t = fullTimes[i];
      if (t === null) return;
      if (silence.dead.has(i)) { if (start === null) start = t; prev = t; } else close();
    });
    close();
  }

  // warm-up and decel-cut periods, from the loop status where it was logged
  const loop = makeLoopReader(parsed, ch);
  if (loop) {
    const isWarmup = makeWarmupTest(parsed, ch, channelUnits, opts);
    const cmdScale = scales?.cmd?.scale;
    const pcm = cmdScale === "afr" ? resolveStoichs(parsed, ch, opts).pcm?.value : null;
    const open = { warmup: null, dfco: null };
    const flush = (type, tEnd) => {
      const o = open[type]; if (!o) return;
      if (tEnd - o >= 1) out.push(ev(type, o, tEnd, `${(tEnd - o).toFixed(1)} s`, tEnd - o));
      open[type] = null;
    };
    parsed.rows.forEach((row, i) => {
      const t = times[i]; if (t === null) return;
      const s = loop(row);
      const cmd = ch.commandedAfr !== undefined ? toLambda(num(row, ch.commandedAfr), cmdScale, pcm) : null;
      const states = {
        warmup: !!s && isWarmup(s, row),
        dfco: !!s && !s.closed && s.reason === "accelDecel" && cmd !== null && Math.abs(cmd - 1) <= 0.02,
      };
      for (const type of ["warmup", "dfco"]) {
        if (states[type] && open[type] === null) open[type] = t;
        else if (!states[type] && open[type] !== null) flush(type, t);
      }
    });
    for (const type of ["warmup", "dfco"]) flush(type, times.filter(t => t !== null).at(-1) ?? 0);
  }

  for (const b of parsed.resampled?.sessionBoundaries || [])
    out.push(ev("session", b, null, "the logger restarted; time continues from the previous session", 0));

  // keep the most important of each type within the cap, then order by time
  const byType = {};
  for (const e of out) (byType[e.type] ??= []).push(e);
  const share = Math.max(10, Math.floor(MAX_EVENTS / Math.max(1, Object.keys(byType).length)));
  const kept = Object.values(byType).flatMap(list => list.sort((a, b) => b.weight - a.weight).slice(0, share));
  const dropped = out.length - kept.length;
  kept.sort((a, b) => a.t - b.t);
  for (const e of kept) { e.snapshot = snapshot(e.t); delete e.weight; }
  return { events: kept, dropped, types: EVENT_TYPES, startSec: +t0.toFixed(2), durationSec: +(tLast - t0).toFixed(2) };
}

// ---------- before / after: two logs compared ----------
// "Did v002 fix it?" — the question every revision exists to answer, and one
// only this app can ask directly, because every log here names its revision.
// Only like is compared with like: a MAF bin, a WOT RPM band, a knock count.
// Anything one log covers and the other does not is reported, not compared.
const revOf = file => String(file || "").match(/_(v\d{3})_/)?.[1] || null;

export function compareAnalyses(a, b, { fileA = "", fileB = "" } = {}) {
  const round = (v, d = 2) => (v == null ? null : +v.toFixed(d));
  const warnings = [];
  const binsA = new Map((a.mafBins?.bins || []).filter(x => x.enoughData).map(x => [x.from, x]));
  const binsB = new Map((b.mafBins?.bins || []).filter(x => x.enoughData).map(x => [x.from, x]));
  const maf = [...new Set([...binsA.keys(), ...binsB.keys()])].sort((x, y) => x - y).map(from => {
    const x = binsA.get(from), y = binsB.get(from);
    return { from, to: (x || y).to, nA: x?.n ?? null, nB: y?.n ?? null,
             trimA: x?.avgTotal ?? null, trimB: y?.avgTotal ?? null,
             delta: x && y ? round(y.avgTotal - x.avgTotal) : null,
             // closer to zero is better: the PCM is correcting less
             better: x && y ? Math.abs(y.avgTotal) < Math.abs(x.avgTotal) : null };
  });
  const onlyOne = maf.filter(m => m.delta === null).length;
  if (onlyOne) warnings.push(`${onlyOne} MAF bin(s) have enough samples in only one of the two logs — shown, not compared. The logs covered different conditions there.`);

  const wotA = new Map((a.wideband?.wot || []).map(x => [x.from, x]));
  const wotB = new Map((b.wideband?.wot || []).map(x => [x.from, x]));
  const wot = [...new Set([...wotA.keys(), ...wotB.keys()])].sort((x, y) => x - y).map(from => {
    const x = wotA.get(from), y = wotB.get(from);
    return { from, to: (x || y).to, nA: x?.n ?? null, nB: y?.n ?? null,
             errorA: x?.errorPct ?? null, errorB: y?.errorPct ?? null,
             leanA: x?.lean ?? null, leanB: y?.lean ?? null,
             delta: x?.errorPct != null && y?.errorPct != null ? round(y.errorPct - x.errorPct, 1) : null };
  });
  if (!a.wideband?.present || !b.wideband?.present) warnings.push("Only one of the logs has a wideband, so enrichment cannot be compared.");

  const knock = s => ({ samples: s?.krSamples ?? null, events: s?.eventCount ?? null, worst: s?.worst?.kr ?? null, present: !!s?.hasKnockChannel });
  const cl = w => w?.closedLoopCheck ? { errorPct: w.closedLoopCheck.errorPct, samples: w.closedLoopCheck.samples } : null;

  return {
    a: { file: fileA, rev: revOf(fileA), rows: a.rowCount, usable: a.keptCount },
    b: { file: fileB, rev: revOf(fileB), rows: b.rowCount, usable: b.keptCount },
    maf, wot,
    knock: { a: knock(a.spark), b: knock(b.spark) },
    closedLoop: { a: cl(a.wideband), b: cl(b.wideband) },
    leanSamples: { a: a.wideband?.leanWotSamples ?? null, b: b.wideband?.leanWotSamples ?? null,
                   wotA: a.wideband?.wotSamples ?? null, wotB: b.wideband?.wotSamples ?? null },
    warnings,
    units: { trim: "%", error: "% leaner than commanded (positive = lean)", knock: "° crank", maf: "Hz", rpm: "RPM" },
    note: "Before/after comparison of two logs. A change only shows its effect where both logs covered the same conditions. Draft readings.",
  };
}

// ---------- math channels ----------
// Your User Math formulas, evaluated against a log. Borrowed from MegaLogViewer
// and LibreTune. VCM Scanner references ([50030.92]) resolve through the
// parameter-ID row HP Tuners exports carry; plain names (RPM, LTFT) through the
// channels the analysis already identified. Nothing is guessed: a formula with
// an input this log lacks is listed with the reason, never computed from zeros.
//
// Names that imply a SCALE are converted, never passed raw. The seed formula
// (WB_AFR − Commanded_AFR) / Commanded_AFR × 100 came out at 1376% on a real
// log: commanded was logged in λ (≈1.0) and subtracted from a wideband in AFR
// (≈14.7). Every *_AFR input is now λ × ONE stoich (the wideband's display
// stoich), so two AFRs always compare; *_LAMBDA inputs are plain λ.
const NAME_ROLES = {
  rpm: "rpm", ltft: "ltft", stft: "stft", ect: "ect", iat: "iat", tps: "tps", map: "map",
  maf_hz: "mafHz", maf: "mafGs", kr: "knockRetard", knock: "knockRetard", spark: "spark",
  ipw_ms: "injectorPw", ipw: "injectorPw", dynair: "dynAir", load: "load",
  wb_afr: { role: "widebandAfr", as: "afr" }, wb_lambda: { role: "widebandAfr", as: "lambda" },
  commanded_afr: { role: "commandedAfr", as: "afr" }, commanded_lambda: { role: "commandedAfr", as: "lambda" },
};

export function mathChannels(parsed, ch, channelUnits, formulas, { scales = null, stoichs = null } = {}) {
  const computed = [], skipped = [];
  const ids = parsed.parameterIds || [];
  for (const f of formulas || []) {
    const base = { id: f.id, name: f.name, expression: f.expression, unit: f.units || "" };
    const platform = f.platform || "any";
    if (platform !== "any") { skipped.push({ ...base, reason: `tagged for ${platform} — retag it as “any” once it is verified on this vehicle` }); continue; }
    const c = compile(f.expression);
    if (!c.ok) { skipped.push({ ...base, reason: `the formula ${c.error}` }); continue; }
    if (!c.vars.length && !c.refs.length) { skipped.push({ ...base, reason: "has no inputs" }); continue; }

    // resolve every input to a column (or the bank average for trims)
    const inputs = {}, caveats = [], missing = [];
    for (const r of c.refs) {
      const col = ids.indexOf(r.parameterID);
      if (col < 0) { missing.push(r.token); continue; }
      inputs[r.token] = [col];
      if (r.unitId) caveats.push(`${r.token}: unit code ${r.unitId} cannot be checked against the log's unit (${detectUnit(parsed.headers[col])?.unit || "not stated"})`);
    }
    const convertFor = {};
    for (const v of c.vars) {
      const spec = NAME_ROLES[v.toLowerCase()] || (ch[v] !== undefined ? v : null);
      const role = typeof spec === "object" && spec ? spec.role : spec;
      const idx = role ? ch[role] : undefined;
      if (idx === undefined) { missing.push(v); continue; }
      inputs[v] = [].concat(idx);
      if (spec?.as) {
        const sc = role === "widebandAfr" ? scales?.wb : scales?.cmd;
        const stoich = role === "widebandAfr" ? stoichs?.wb?.value : stoichs?.pcm?.value;
        const basis = stoichs?.wb?.value;
        if (!sc || !["lambda", "eq", "afr", "ratio-ambiguous"].includes(sc.scale) || (sc.scale === "afr" && !stoich) || (spec.as === "afr" && !basis)) {
          missing.push(`${v} (its scale or stoich could not be established)`); continue;
        }
        convertFor[v] = raw => { const l = toLambda(raw, sc.scale, stoich); return l === null ? null : spec.as === "afr" ? l * basis : l; };
        if (spec.as === "afr") caveats.push(`${v} expressed as λ × ${basis} (the wideband's display stoich), so every AFR in the formula is on one basis`);
      }
    }
    if (missing.length) { skipped.push({ ...base, reason: `needs ${missing.join(", ")}, which this log does not have` }); continue; }

    let n = 0, sum = 0, min = Infinity, max = -Infinity;
    for (const row of parsed.rows) {
      const env = {};
      for (const [k, cols] of Object.entries(inputs)) {
        const vals = cols.map(i => num(row, i)).filter(x => x !== null);
        let v = vals.length === cols.length && vals.length ? vals.reduce((p, q) => p + q, 0) / vals.length : null;
        if (v !== null && convertFor[k]) v = convertFor[k](v);
        env[k] = v;
      }
      const v = c.eval(env);
      if (!Number.isFinite(v)) continue;
      n++; sum += v; if (v < min) min = v; if (v > max) max = v;
    }
    if (!n) { skipped.push({ ...base, reason: "its inputs never appear together on one row of this log" }); continue; }
    computed.push({ ...base, samples: n, min: +min.toFixed(3), avg: +(sum / n).toFixed(3), max: +max.toFixed(3),
                    inputs: Object.fromEntries(Object.entries(inputs).map(([k, cols]) => [k, cols.map(i => parsed.headers[i]).join(" + ")])),
                    status: f.status || "unverified", caveats });
  }
  return { computed, skipped, note: "Computed from your formulas on this log's rows. Unverified formulas stay unverified — check one against a known value before trusting it." };
}
