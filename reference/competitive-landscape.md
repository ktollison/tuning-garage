# Competitive landscape — is Tuning Garage a niche?

**Verdict (researched 2026-08-02): yes, the niche is real.** No open-source
project does OEM-GM tune *file management + session tracking + learning
discipline*. The adjacent projects below are editors and loggers for other
ecosystems — we don't compete with them, we organize around tools like theirs.
But several have features worth borrowing (tagged **→ borrow**).

## LibreTune (github.com/RallyPat/LibreTune)

- Modern open-source tuner for **aftermarket** ECUs (Speeduino, rusEFI, FOME,
  epicEFI, MS2/MS3) — Rust + Tauri desktop app, GPL-2, early but very active.
- The closest philosophical neighbor: **git-based tune versioning, restore
  points, change annotations** — independently validates our core design.
- **→ borrow:** change annotations per table edit; table comparison; math
  channels + alert rules on logs; AI assistant pattern (BYO-LLM proposing
  changes that require explicit review — in our system, the assistant + skill
  already fill this role with the draft-reading rule).

## TunerStudio (tunerstudio.com — commercial, MegaSquirt ecosystem)

- The de-facto standard for DIY EFI: projects, dashboards, datalogging.
- **VE Analyze Live**: statistically filtered auto-recommendations from live
  data (junk filtering, weighted averages), applied or proposed.
- **→ borrow:** the *statistical filtering* idea for a trim-based MAF
  suggestion tool (output always a draft table, never auto-applied); project
  backup/restore discipline.

## RomRaider (github.com/RomRaider/RomRaider)

- Open-source Subaru editor + logger, long-lived and mature.
- **→ borrow:** logger + definitions pairing model; their definition XML
  ecosystem mirrors what XDFs are to us.

## LibreTuner (github.com/LibreTuner/LibreTuner)

- Open-source Mazda platform tuner. Less active. Confirms the pattern:
  open-source tuning organizes per-platform, nobody owns "the garage layer."

## VW/Audi Simos scene (simoswiki.com)

- Strong open-source flashing/unlock work for VW — a model for what a locked
  platform community can achieve (relevant context for Gen 5/Global B hopes).

## Engine-Tune-Repository (github.com/Snoman002/…)

- Community bins/XDFs in a GitHub repo — validates git as tuning storage, no
  tooling on top. Our starter kit is effectively this plus an app and process.

## Commercial context

- **HP Tuners / EFILive** — editors/flashers with file management as an
  afterthought (folders + filenames). No versioning, no session discipline.
- **MegaLogViewer HD** — log analysis only; pairs with us, doesn't overlap.

## Positioning

Tuning Garage = the **process and history layer** for OEM GM tuning:
versioned files, enforced baselines, session logs, learning progression, and
native bin intelligence — sitting on top of HPT + PCMHammer + UniversalPatcher
rather than replacing any of them. Nothing found occupies this spot.
