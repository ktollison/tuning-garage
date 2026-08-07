// Builds a synthetic but format-valid P01 bin in memory and checks the
// analyzer against known-by-construction answers: OS ID, EEPROM style, every
// checksum, VIN decode, corruption detection, and safe handling of garbage.

import { analyze, detect } from "../../app/modules/gm-gen3.mjs";

const SIZE = 512 * 1024;
const buf = Buffer.alloc(SIZE, 0);
const be16w = (v, o) => { buf[o] = (v >> 8) & 0xff; buf[o + 1] = v & 0xff; };
const be32w = (v, o) => { buf[o] = (v >>> 24) & 0xff; buf[o + 1] = (v >>> 16) & 0xff; buf[o + 2] = (v >>> 8) & 0xff; buf[o + 3] = v & 0xff; };
const be16r = o => (buf[o] << 8) | buf[o + 1];
const comp = (from, to) => { let s = 0; for (let i = from; i < to; i += 2) s += be16r(i); return (65536 - (s & 0xffff)) & 0xffff; };

// OS header
buf[0x503] = 1;
be32w(12212156, 0x504);           // OS ID
buf.write("AA", 0x508, "ascii");  // OS version

// OS segment 2 marker
buf[0x20000] = 0x4e; buf[0x20001] = 0x56; // "NV"

// EEPROM block (2001-style): check word 0xA0A5 little-endian at 0x4000+0x88
buf[0x4088] = 0xa5; buf[0x4089] = 0xa0;
buf.write("TESTVIN1234567890", 0x4000 + 33, "ascii");  // 17 chars
buf.write("SERIAL123456", 0x4000 + 8, "ascii");
buf.write("BCC1", 0x4000 + 28, "ascii");
be32w(12200411, 0x4000 + 4); // hardware id

// Seven segments, 0x1000 each, starting at 0x30000
const segs = [];
let start = 0x30000;
for (let s = 0; s < 7; s++) {
  const end = start + 0x1000 - 1;
  be32w(start, 0x514 + s * 8);
  be32w(end, 0x514 + s * 8 + 4);
  be32w(90000000 + s, start + 4);           // cal ID
  buf.write("Z" + s, start + 8, "ascii");   // version
  segs.push({ start, len: 0x1000 });
  start += 0x2000;
}
// per-segment checksums: complement of words in [start+2, start+len-1)
for (const sg of segs) be16w(comp(sg.start + 2, sg.start + sg.len - 1), sg.start);

// OS checksum: [0,0x4FF) + [0x502,0x3FFF) + [0x20000, +0x5FFFE-1)
let osum = 0;
for (let i = 0; i < 0x4ff; i += 2) osum += be16r(i);
for (let i = 0x502; i < 0x3fff; i += 2) osum += be16r(i);
for (let i = 0x20000; i < 0x20000 + 0x5fffe - 1; i += 2) osum += be16r(i);
be16w((65536 - (osum & 0xffff)) & 0xffff, 0x500);


// --- direct module tests ---
const a = analyze(buf);
const t = (cond, msg) => { console.log((cond ? "✓ " : "✗ ") + msg); if (!cond) process.exitCode = 1; };
t(detect(buf), "detect() accepts fixture");
t(a.pcm === "P01", "PCM = P01");
t(a.osId === 12212156, "OS ID = 12212156");
t(a.model?.includes("01-03"), "EEPROM style 2001 detected: " + a.model);
t(a.osChecksum.ok, "OS checksum verifies");
t(a.segments.length === 7 && a.segments.every(s => s.checksum?.ok), "all 7 segment checksums verify");
t(a.segments[0].calId === 90000000 && a.segments[0].name === "EngineCal", "EngineCal cal ID read");
t(a.eeprom?.vin === "TESTVIN1234567890", "VIN draft read: " + a.eeprom?.vin);
t(a.checksumSummary === "all checksums OK", "verdict: " + a.checksumSummary);

// corrupt one byte inside EngineCal → its checksum must fail
buf[0x30000 + 0x100] ^= 0xff;
const b = analyze(buf);
t(!b.segments[0].checksum.ok, "corrupted EngineCal detected as checksum FAIL");
t(/FAILED/.test(b.checksumSummary), "verdict flags failure: " + b.checksumSummary);

// garbage file → analyzable false path (detect fails)
t(!detect(Buffer.alloc(1000)), "truncated garbage rejected by detect()");
const half = Buffer.alloc(SIZE, 7); // right size, bad 0x503
t(!detect(half), "right-size file with bad header rejected");
console.log("fixture tests done");
