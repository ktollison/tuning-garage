// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Gen III GM PCM (P01/P59) bin analyzer — verify-only, never modifies a file.
//
// Format knowledge ported from open-source implementations by Jouko Kylmäoja:
// PCMBinBuilder (github.com/joukoy/PCMBinBuilder, Source/PCmFunctions.cs) and
// UniversalPatcher (github.com/joukoy/UniversalPatcher). Layout summary:
//   0x500  uint16 BE  stored OS checksum
//   0x503  byte       must be 1 (OS segment 1 valid)
//   0x504  uint32 BE  OS ID (decimal part number)
//   0x508  2 ASCII    OS version code
//   0x514  7 pairs of uint32 BE {start, end} for segments 2..8
//   seg+0  uint16 BE  stored segment checksum
//   seg+4  uint32 BE  segment part number (cal ID)
//   seg+8  2 ASCII    segment version code
//   0x20000 bytes 'N','V' — OS segment 2 marker
//   0x4000 EEPROM data block; check word 0xA0A5 (LE) at +0x88 (2001-style)
//          or +0x56 (1999-style), possibly shifted +0x2000; VIN at +33 (17 ASCII)
// Checksums: 16-bit two's complement of the big-endian word sum.

import crypto from "node:crypto";

export const id = "gm-gen3";
export const name = "GM Gen III (P01 / P59)";

const SIZE_P01 = 512 * 1024;
const SIZE_P59 = 1024 * 1024;
const SEGMENT_NAMES = ["EngineCal", "EngineDiag", "TransCal", "TransDiag", "Fuel", "System", "Speedo"];

const be16 = (buf, o) => (buf[o] << 8) | buf[o + 1];
const be32 = (buf, o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
const le16 = (buf, o) => buf[o] | (buf[o + 1] << 8);
const ascii = (buf, o, n) => buf.subarray(o, o + n).toString("ascii").replace(/[^a-zA-Z0-9]/g, "");

function wordSum(buf, start, endExclusive) {
  let sum = 0;
  for (let i = start; i < endExclusive; i += 2) sum = (sum + be16(buf, i)) & 0xffffffff;
  return (65536 - (sum & 0xffff)) & 0xffff;
}

export function detect(buf) {
  return (buf.length === SIZE_P01 || buf.length === SIZE_P59) && buf[0x503] === 1;
}

// EEPROM block location per GetVINAddr; returns offset or null
function eepromAddr(buf) {
  const base = 0x4000;
  if (le16(buf, base + 0x88) === 0xa0a5) return { addr: base, style: 2001 };
  if (le16(buf, base + 0x56) === 0xa0a5) return { addr: base, style: 1999 };
  if (le16(buf, base + 0x2088) === 0xa0a5) return { addr: base + 0x2000, style: 2001 };
  if (le16(buf, base + 0x2056) === 0xa0a5) return { addr: base + 0x2000, style: 1999 };
  return null;
}

export function analyze(buf) {
  const warnings = [];
  const out = {
    platform: id,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    sizeBytes: buf.length,
    warnings,
    // Algorithm faithfully ported from PCMBinBuilder but not yet validated
    // against this user's real reads — treat results as draft readings.
    note: "Extracted values are draft readings — verify against your tools. Checksum math ported from PCMBinBuilder; pending validation against a real stock read.",
  };

  if (buf.length !== SIZE_P01 && buf.length !== SIZE_P59) {
    warnings.push(`unexpected size ${buf.length} bytes — a P01 full read is exactly 524288, a P59 is 1048576`);
    return out;
  }
  out.pcm = buf.length === SIZE_P59 ? "P59" : "P01";

  if (buf[0x503] !== 1) {
    warnings.push("byte 0x503 is not 1 — OS segment 1 header invalid (bad or partial read?)");
    return out;
  }

  out.osId = be32(buf, 0x504);
  out.osVersion = ascii(buf, 0x508, 2);

  if (out.pcm === "P01") {
    const ee = eepromAddr(buf);
    out.model = ee ? (ee.style === 1999 ? "P01 (99-00 style EEPROM)" : "P01 (01-03 style EEPROM)") : "P01";
    if (!ee) warnings.push("EEPROM check word 0xA0A5 not found — VIN/serial block unreadable");
  }

  if (buf[0x20000] !== 0x4e || buf[0x20001] !== 0x56) {
    warnings.push("OS segment 2 marker 'NV' missing at 0x20000 — file may be corrupt");
  }

  // OS checksum: [0,0x4FF) + [0x502,0x3FFF) + OS2 segment
  const os2len = out.pcm === "P59" ? 0xdfffe : 0x5fffe;
  let osSum = 0;
  for (let i = 0; i < 0x4ff; i += 2) osSum += be16(buf, i);
  for (let i = 0x502; i < 0x3fff; i += 2) osSum += be16(buf, i);
  for (let i = 0x20000; i < 0x20000 + os2len - 1; i += 2) osSum += be16(buf, i);
  const osCalc = (65536 - (osSum & 0xffff)) & 0xffff;
  const osStored = be16(buf, 0x500);
  out.osChecksum = { stored: osStored, calculated: osCalc, ok: osStored === osCalc };

  // segments 2..8 from the address table at 0x514
  out.segments = [];
  let off = 0x514;
  for (let s = 0; s < 7; s++) {
    const start = be32(buf, off); off += 4;
    const end = be32(buf, off); off += 4;
    const length = end - start + 1;
    const seg = { name: SEGMENT_NAMES[s], start, length };
    if (start >= buf.length || end >= buf.length || end <= start) {
      seg.error = "address out of range — corrupted segment table";
      warnings.push(`${seg.name}: segment table entry out of range`);
      out.segments.push(seg);
      continue;
    }
    seg.calId = be32(buf, start + 4);
    seg.version = ascii(buf, start + 8, 2);
    const stored = be16(buf, start);
    const calc = wordSum(buf, start + 2, start + length - 1);
    seg.checksum = { stored, calculated: calc, ok: stored === calc };
    out.segments.push(seg);
  }

  // EEPROM block: VIN / serial / broadcast code (draft readings)
  const ee = eepromAddr(buf);
  if (ee) {
    out.eeprom = {
      vin: ascii(buf, ee.addr + 33, 17),
      serial: ascii(buf, ee.addr + 8, 12),
      broadcastCode: ascii(buf, ee.addr + 28, 4),
      hardwareId: be32(buf, ee.addr + 4),
    };
    if (out.eeprom.vin.length !== 17) warnings.push("VIN did not decode to 17 characters");
  }

  const bad = (out.segments || []).filter(s => s.checksum && !s.checksum.ok).length + (out.osChecksum?.ok ? 0 : 1);
  out.checksumSummary = bad === 0 ? "all checksums OK" : `${bad} checksum(s) FAILED — do not flash this file`;
  return out;
}
