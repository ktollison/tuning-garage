// Fixture: a hand-built XDF + two bins with values chosen so every result is
// predictable by hand. Verifies parsing, scaling math, endianness, signedness,
// axis reads, and the table-level diff.
import { parseXdf, readTable, diffTables, makeEval } from "../../app/modules/xdf.mjs";

const t = (cond, msg) => { console.log((cond ? "✓ " : "✗ ") + msg); if (!cond) process.exitCode = 1; };

// --- equation evaluator ---
t(makeEval("X*0.0078125")(128) === 1, "equation X*0.0078125 at 128 -> 1");
t(makeEval("(X-128)*0.5")(138) === 5, "equation (X-128)*0.5 at 138 -> 5");
t(makeEval("X/4+10")(40) === 20, "equation X/4+10 at 40 -> 20");
t(makeEval("-X+5")(2) === 3, "unary minus handled");
t(makeEval("")(42) === 42, "no equation -> identity");

// --- XDF: one 2x3 16-bit MSB table at 0x1000, scaled X*0.1, with axes ---
const xdfText = `<?xml version="1.0" encoding="utf-8"?>
<XDFFORMAT version="1.70">
  <XDFHEADER>
    <deftitle>Test Definition</deftitle>
    <description>fixture</description>
    <BASEOFFSET offset="0" subtract="0" />
    <CATEGORY index="0" name="Fuel" />
  </XDFHEADER>
  <XDFTABLE uniqueid="0x1" flags="0x30">
    <title>MAF Calibration</title>
    <description>airflow vs frequency</description>
    <CATEGORYMEM index="0" category="1" />
    <XDFAXIS id="x" uniqueid="0x0">
      <EMBEDDEDDATA mmedaddress="0x2000" mmedelementsizebits="16" mmedmajorstridebits="0" mmedminorstridebits="0" />
      <indexcount>3</indexcount>
      <units>Hz</units>
      <decimalpl>0</decimalpl>
      <MATH equation="X*10"><VAR id="X" /></MATH>
    </XDFAXIS>
    <XDFAXIS id="y" uniqueid="0x0">
      <indexcount>2</indexcount>
      <LABEL index="0" value="bank1" />
      <LABEL index="1" value="bank2" />
    </XDFAXIS>
    <XDFAXIS id="z">
      <EMBEDDEDDATA mmedaddress="0x1000" mmedelementsizebits="16" mmedrowcount="2" mmedcolcount="3" />
      <units>g/s</units>
      <decimalpl>2</decimalpl>
      <MATH equation="X*0.1"><VAR id="X" /></MATH>
    </XDFAXIS>
  </XDFTABLE>
  <XDFTABLE uniqueid="0x2">
    <title>Untouched Table</title>
    <XDFAXIS id="z">
      <EMBEDDEDDATA mmedaddress="0x3000" mmedelementsizebits="8" mmedrowcount="1" mmedcolcount="4" />
      <MATH equation="X"><VAR id="X" /></MATH>
    </XDFAXIS>
  </XDFTABLE>
  <XDFCONSTANT uniqueid="0x9">
    <title>Rev Limiter</title>
    <EMBEDDEDDATA mmedaddress="0x4000" mmedelementsizebits="16" />
    <units>RPM</units>
    <MATH equation="X"><VAR id="X" /></MATH>
  </XDFCONSTANT>
</XDFFORMAT>`;

const xdf = parseXdf(xdfText);
t(xdf.title === "Test Definition", "header title parsed");
t(xdf.tableCount === 2, "2 tables found (got " + xdf.tableCount + ")");
t(xdf.constantCount === 1, "1 constant found");
const maf = xdf.tables[0];
t(maf.title === "MAF Calibration", "table title");
t(maf.categories[0] === "Fuel", "category resolved to name (got " + maf.categories[0] + ")");
t(maf.rows === 2 && maf.cols === 3, "geometry 2x3");
t(maf.z.address === 0x1000 && maf.z.bits === 16, "z address/size");
t(maf.z.signed === false && maf.z.lsbFirst === false, "defaults: unsigned, MSB-first");
t(maf.y.labels.length === 2, "static y labels read");

// --- bin A: 16-bit MSB values 100,200,300 / 400,500,600 at 0x1000 ---
const A = Buffer.alloc(0x5000);
const put16 = (b, off, v) => { b[off] = (v >> 8) & 0xff; b[off + 1] = v & 0xff; };
[100, 200, 300, 400, 500, 600].forEach((v, i) => put16(A, 0x1000 + i * 2, v));
[10, 20, 30].forEach((v, i) => put16(A, 0x2000 + i * 2, v));      // x axis -> *10 => 100,200,300 Hz
[1, 2, 3, 4].forEach((v, i) => { A[0x3000 + i] = v; });
put16(A, 0x4000, 6200);

const rt = readTable(A, maf);
t(rt.values[0][0] === 10 && rt.values[0][2] === 30, "row 0 scaled: 100->10.00, 300->30.00");
t(rt.values[1][2] === 60, "row 1 last cell 600->60.00");
t(JSON.stringify(rt.xLabels) === "[100,200,300]", "x axis read+scaled from bin (got " + JSON.stringify(rt.xLabels) + ")");
t(JSON.stringify(rt.yLabels) === '["bank1","bank2"]', "y axis uses static labels");

// --- bin B: same, but the MAF table's middle column raised ~4% ---
const B = Buffer.from(A);
put16(B, 0x1000 + 1 * 2, 208);   // 200 -> 208  (+0.8 scaled)
put16(B, 0x1000 + 4 * 2, 520);   // 500 -> 520  (+2.0 scaled)

const d = diffTables(A, B, xdf);
t(d.tablesCompared === 2, "both tables compared");
t(d.tablesChanged === 1, "exactly one table changed (got " + d.tablesChanged + ")");
const ch = d.changed[0];
t(ch.title === "MAF Calibration", "changed table identified");
t(ch.changedCells === 2, "2 cells changed (got " + ch.changedCells + ")");
t(ch.maxDelta === 2, "max delta 2.00 g/s (got " + ch.maxDelta + ")");
t(ch.examples[0].x === 200 && ch.examples[0].from === 20 && ch.examples[0].to === 20.8,
  "example carries real axis label + before/after: " + JSON.stringify(ch.examples[0]));

// --- signed + little-endian variant ---
const sx = parseXdf(xdfText.replace('mmedaddress="0x1000" mmedelementsizebits="16"',
  'mmedaddress="0x1000" mmedelementsizebits="16" mmedtypeflags="0x03"'));
const S = Buffer.alloc(0x2000);
S[0x1000] = 0xff; S[0x1000 + 1] = 0xff;         // LSB-first signed -> -1
const st = readTable(S, sx.tables[0]);
t(st.values[0][0] === -0.1, "signed + LSB-first: 0xFFFF -> -1 raw -> -0.10 scaled (got " + st.values[0][0] + ")");

// --- robustness: truncated bin must not throw ---
const tiny = Buffer.alloc(16);
const rt2 = readTable(tiny, maf);
t(rt2.values[0][0] === null, "out-of-range reads return null instead of throwing");
console.log("\nxdf fixture tests done");
