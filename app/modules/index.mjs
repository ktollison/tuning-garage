// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Platform module registry. A platform module exports:
//   id, name          — identifiers
//   detect(buffer)    — true if this module understands the file
//   analyze(buffer)   — read-only analysis object (never modifies files)
// Add future platforms (GM Gen IV, Ford, ...) as siblings and list them here.

import * as gmGen3 from "./gm-gen3.mjs";

export const modules = [gmGen3];

export function analyzeBuffer(buf) {
  for (const m of modules) {
    try {
      if (m.detect(buf)) return m.analyze(buf);
    } catch { /* a module must never take the app down; fall through */ }
  }
  return null;
}
