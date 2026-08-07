// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// TunerPro XDF definition parser — READ ONLY.
//
// The XDF format is not officially documented. Field semantics below were
// taken from UniversalPatcher's own reader/writer (github.com/joukoy,
// Source/xdf.cs) — the same codebase the Gen3 bin layout came from:
//
//   mmedtypeflags   bit 0 (0x01)    signed
//                   bit 1 (0x02)    LSB first (little-endian); absent = MSB
//                   bit 2 (0x04)    row/column major — SEE THE CAVEAT BELOW
//                   bit 16 (0x10000) floating point
//   mmedaddress     start address (hex)
//   mmedelementsizebits  bits per cell (8/16/32)
//   mmedrowcount / mmedcolcount      geometry
//   mmedmajorstridebits / mmedminorstridebits  strides, in BITS
//   BASEOFFSET offset= subtract=     applied to every address
//
// CAVEAT on bit 2: UniversalPatcher's reader treats the bit as "NOT row major"
// while its writer sets it when the table IS row major — the two disagree.
// Rather than guess, we default to row-major and set `layoutAmbiguous` on any
// table with the bit set, so the UI can warn instead of quietly transposing.

// ---------- minimal XML parser (no dependencies) ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e])
                     .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
                     .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

export function parseXml(text) {
  let i = 0;
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const src = text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (lt > i) {
      const t = src.slice(i, lt).trim();
      if (t) stack[stack.length - 1].text += decode(t);
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt === -1) break;
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith("/")) { if (stack.length > 1) stack.pop(); continue; }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const sp = body.search(/\s/);
    const tag = (sp === -1 ? body : body.slice(0, sp)).trim();
    const attrs = {};
    if (sp !== -1) {
      for (const m of body.slice(sp).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
        attrs[m[1] || m[3]] = decode(m[2] ?? m[4]);
      }
    }
    const node = { tag, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const kid = (n, tag) => n.children.find(c => c.tag.toUpperCase() === tag.toUpperCase());
const kids = (n, tag) => n.children.filter(c => c.tag.toUpperCase() === tag.toUpperCase());
const txt = (n, tag) => kid(n, tag)?.text?.trim() ?? "";
const hex = v => (v == null || v === "" ? null : Number(String(v).trim().startsWith("0x") ? Number(v) : parseInt(v, /^[0-9]+$/.test(String(v).trim()) ? 10 : 16)));

// ---------- safe arithmetic for MATH equations (no eval) ----------
// Handles the shapes XDFs actually use: X*0.0078125, (X-128)*0.5, X/4+10.
export function makeEval(equation) {
  if (!equation) return x => x;
  const tokens = equation.match(/\d*\.?\d+(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|[()+\-*/^]/g);
  if (!tokens) return x => x;
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
  const out = [], ops = [];
  let prev = null;
  for (const t of tokens) {
    if (/^\d|^\./.test(t)) { out.push(parseFloat(t)); }
    else if (/^[A-Za-z_]/.test(t)) { out.push({ v: t.toUpperCase() }); }
    else if (t === "(") ops.push(t);
    else if (t === ")") { while (ops.length && ops.at(-1) !== "(") out.push(ops.pop()); ops.pop(); }
    else {
      // unary minus
      if (t === "-" && (prev === null || prev === "(" || prec[prev])) { out.push(0); }
      while (ops.length && ops.at(-1) !== "(" && prec[ops.at(-1)] >= prec[t]) out.push(ops.pop());
      ops.push(t);
    }
    prev = t;
  }
  while (ops.length) out.push(ops.pop());

  return x => {
    const st = [];
    for (const t of out) {
      if (typeof t === "number") st.push(t);
      else if (typeof t === "object") st.push(x);
      else {
        const b = st.pop(), a = st.pop() ?? 0;
        st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : t === "/" ? (b === 0 ? 0 : a / b) : Math.pow(a, b));
      }
    }
    const r = st.pop();
    return Number.isFinite(r) ? r : 0;
  };
}

// ---------- axis / table extraction ----------
function readAxis(ax, baseOffset, subtract) {
  const ed = kid(ax, "EMBEDDEDDATA");
  const a = ed?.attrs || {};
  const flags = a.mmedtypeflags ? Number(a.mmedtypeflags) : 0;
  const rawAddr = hex(a.mmedaddress);
  const equation = kid(ax, "MATH")?.attrs?.equation || "";
  return {
    id: ax.attrs.id || "",
    address: rawAddr === null ? null : (subtract ? rawAddr - baseOffset : rawAddr + baseOffset),
    rows: Number(a.mmedrowcount || 0) || null,
    cols: Number(a.mmedcolcount || 0) || null,
    bits: Number(a.mmedelementsizebits || 16),
    signed: !!(flags & 0x01),
    lsbFirst: !!(flags & 0x02),
    layoutAmbiguous: !!(flags & 0x04),
    floating: !!(flags & 0x10000),
    majorStrideBytes: a.mmedmajorstridebits ? Number(a.mmedmajorstridebits) / 8 : null,
    minorStrideBytes: a.mmedminorstridebits ? Number(a.mmedminorstridebits) / 8 : null,
    indexCount: Number(txt(ax, "indexcount") || 0) || null,
    units: txt(ax, "units"),
    decimals: Number(txt(ax, "decimalpl") || 2),
    equation,
    // labels for axes defined as static text rather than read from the bin
    labels: kids(ax, "LABEL").map(l => l.attrs.value).filter(Boolean),
  };
}

export function parseXdf(text) {
  const doc = parseXml(text);
  const fmt = kid(doc, "XDFFORMAT") || doc;
  const hdr = kid(fmt, "XDFHEADER");
  const bo = hdr ? kid(hdr, "BASEOFFSET") : null;
  const baseOffset = bo ? (hex(bo.attrs.offset) || 0) : 0;
  const subtract = bo ? bo.attrs.subtract === "1" : false;

  const categories = {};
  for (const c of hdr ? kids(hdr, "CATEGORY") : []) categories[c.attrs.index] = c.attrs.name;

  const tables = kids(fmt, "XDFTABLE").map(t => {
    const axes = {};
    for (const ax of kids(t, "XDFAXIS")) axes[(ax.attrs.id || "").toLowerCase()] = readAxis(ax, baseOffset, subtract);
    const z = axes.z || {};
    const catRefs = kids(t, "CATEGORYMEM").map(c => categories[String(Number(c.attrs.category) - 1)] || c.attrs.category);
    return {
      id: t.attrs.uniqueid || "",
      title: txt(t, "title"),
      description: txt(t, "description"),
      categories: catRefs.filter(Boolean),
      rows: z.rows || axes.y?.indexCount || 1,
      cols: z.cols || axes.x?.indexCount || 1,
      z, x: axes.x || null, y: axes.y || null,
    };
  });

  const constants = kids(fmt, "XDFCONSTANT").map(c => {
    const ed = kid(c, "EMBEDDEDDATA");
    const flags = ed?.attrs?.mmedtypeflags ? Number(ed.attrs.mmedtypeflags) : 0;
    const rawAddr = hex(ed?.attrs?.mmedaddress);
    return {
      id: c.attrs.uniqueid || "", title: txt(c, "title"), units: txt(c, "units"),
      address: rawAddr === null ? null : (subtract ? rawAddr - baseOffset : rawAddr + baseOffset),
      bits: Number(ed?.attrs?.mmedelementsizebits || 16),
      signed: !!(flags & 0x01), lsbFirst: !!(flags & 0x02),
      equation: kid(c, "MATH")?.attrs?.equation || "",
    };
  });

  return {
    title: hdr ? txt(hdr, "deftitle") : "",
    description: hdr ? txt(hdr, "description") : "",
    baseOffset, subtract,
    tableCount: tables.length, constantCount: constants.length,
    tables, constants,
  };
}

// ---------- reading values out of a bin ----------
function readCell(buf, off, bits, signed, lsbFirst) {
  const bytes = bits / 8;
  if (off < 0 || off + bytes > buf.length) return null;
  let v = 0;
  if (lsbFirst) for (let i = bytes - 1; i >= 0; i--) v = (v << 8) | buf[off + i];
  else for (let i = 0; i < bytes; i++) v = (v << 8) | buf[off + i];
  v = v >>> 0;
  if (signed) { const half = 2 ** (bits - 1); if (v >= half) v -= 2 ** bits; }
  return v;
}

export function readTable(buf, table) {
  const z = table.z;
  if (!z || z.address == null) return { error: "table has no z-axis address" };
  const bytes = z.bits / 8;
  const rows = table.rows || 1, cols = table.cols || 1;
  const rowStride = z.majorStrideBytes || cols * bytes;
  const colStride = z.minorStrideBytes || bytes;
  const f = makeEval(z.equation);
  const values = [], raws = [];
  for (let r = 0; r < rows; r++) {
    const vr = [], rr = [];
    for (let c = 0; c < cols; c++) {
      const raw = readCell(buf, z.address + r * rowStride + c * colStride, z.bits, z.signed, z.lsbFirst);
      rr.push(raw);
      vr.push(raw === null ? null : +f(raw).toFixed(z.decimals ?? 2));
    }
    values.push(vr); raws.push(rr);
  }
  const axisVals = ax => {
    if (!ax) return null;
    if (ax.labels?.length) return ax.labels;
    if (ax.address == null) return null;
    const n = ax.indexCount || (ax === table.x ? cols : rows);
    const g = makeEval(ax.equation), ab = ax.bits / 8;
    return Array.from({ length: n }, (_, i) => {
      const raw = readCell(buf, ax.address + i * ab, ax.bits, ax.signed, ax.lsbFirst);
      return raw === null ? null : +g(raw).toFixed(ax.decimals ?? 2);
    });
  };
  return {
    title: table.title, rows, cols, values, raws,
    xLabels: axisVals(table.x), yLabels: axisVals(table.y),
    units: z.units, equation: z.equation,
    layoutAmbiguous: z.layoutAmbiguous,
  };
}

// ---------- table-level diff between two bins ----------
export function diffTables(bufA, bufB, xdf, { limit = 200 } = {}) {
  const changed = [], unchanged = [];
  for (const t of xdf.tables) {
    const a = readTable(bufA, t), b = readTable(bufB, t);
    if (a.error || b.error) continue;
    let cells = 0, maxDelta = 0, sumDelta = 0;
    const examples = [];
    for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++) {
      const va = a.values[r][c], vb = b.values[r][c];
      if (va === null || vb === null || va === vb) continue;
      cells++;
      const d = vb - va;
      sumDelta += d;
      if (Math.abs(d) > Math.abs(maxDelta)) maxDelta = d;
      if (examples.length < 5) examples.push({
        row: r, col: c,
        x: a.xLabels?.[c] ?? c, y: a.yLabels?.[r] ?? r,
        from: va, to: vb, delta: +d.toFixed(4),
      });
    }
    const rec = {
      id: t.id, title: t.title, categories: t.categories, units: t.z?.units || "",
      totalCells: a.rows * a.cols, changedCells: cells,
      maxDelta: +maxDelta.toFixed(4),
      avgDelta: cells ? +(sumDelta / cells).toFixed(4) : 0,
      examples, layoutAmbiguous: a.layoutAmbiguous,
    };
    (cells ? changed : unchanged).push(rec);
  }
  changed.sort((x, y) => y.changedCells - x.changedCells);
  return {
    tablesCompared: changed.length + unchanged.length,
    tablesChanged: changed.length,
    changed: changed.slice(0, limit),
    note: "Table-level differences read through the XDF. Values depend on the definition being correct for this OS — a wrong XDF produces confident nonsense. Draft readings.",
  };
}
