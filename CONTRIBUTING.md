# Contributing

Thanks for considering it. This project gets better mainly from **real logs and
real channel names** — the analyser could not read a genuine HP Tuners export
at all until someone tried one, and a 42-channel layout turned out to have 35
parameter IDs nobody had named.

Read [DISCLAIMER.md](DISCLAIMER.md) first if you have not. Everything here
produces draft readings, and a contribution that makes a wrong reading look
confident is worse than no contribution.

---

## What cannot be accepted

Not arbitrary, and not negotiable — please do not attach these to an issue:

| Never | Why |
|---|---|
| `.bin`, `.hpt` calibration files | They contain the manufacturer's copyrighted calibration, and a Gen III bin carries **your VIN** in the EEPROM block. Posting one publishes both. |
| `.hpl` binary scanner logs | Same VIN exposure, and they are not readable by this project anyway. Export to CSV. |
| XDF definitions you did not write | Provenance is usually unclear. If you authored it, say so and it can be discussed. |
| Anything from a vehicle that is not yours | Not yours to publish. |

**If you attach a calibration file it will be deleted and the issue closed.**
That is not hostility — once it is posted it is public, and deleting it does
not fully undo that.

## What is very welcome

- **Datalogs (CSV), scrubbed** — especially from platforms other than Gen III
  GM, or from any log the analyser reads badly
- **Channel names** — parameter ID → label → unit, from your scanner layout
- **Math parameters** — the expression, its units, and what it is for
- **Platform support** — memory layouts, OS IDs, checksum schemes, with the
  public source you got them from
- **Documentation fixes**, and corrections to anything stated wrongly

---

## Scrub your log before you post it

Anything attached to a public issue or PR is public the instant you post it and
cannot be truly withdrawn. Run this first:

```bash
node scripts/scrub-log.mjs --check mylog.csv
```

If it reports findings, redact them:

```bash
node scripts/scrub-log.mjs mylog.csv
```

It removes VIN-shaped values anywhere in the file, clears the free-text `Notes:`
field, and drops GPS/latitude/longitude channels. The output is byte-identical
to your original apart from those redactions, so it still analyses the same.

**It is not a guarantee.** It cannot catch what you typed into a channel name,
a filename, or the issue body. Open the scrubbed file and look at it.

---

## Not sure yet?

[Discussions](https://github.com/ktollison/tuning-garage/discussions) is the
place for "is this reading right?", "why does my log look like this?", or an
idea worth talking through before anyone builds it. An issue is better once
there is something concrete to act on.

## Two ways to submit

### Let the tool do it (easiest)

```bash
node scripts/submit-log.mjs yourlog.csv
```

It scrubs the log and **refuses to go any further if anything identifying
survives**, runs the analyser, writes a bundle, and opens the issue for you when
the GitHub CLI is installed and signed in. Without `gh` it stops after the
bundle and tells you exactly what to paste and attach — you are never stuck.

Add `--dry-run` to build the bundle and send nothing.

The bundle is written **outside this repository**, under
`~/.local/share/tuning-garage/submissions/`, so a submission can never be
committed by accident.

### Open an issue by hand

Use one of the [issue forms](../../issues/new/choose). The log-submission form
takes a `.csv` directly. Good for a one-off — a maintainer picks it up from
there.

### Open a pull request (best if you use git)

Put logs in `submissions/logs/` and edit `data/` files directly. CI will:

- refuse the file types listed above
- run the scrubber in `--check` mode and fail on anything identifying
- run the analyser on your log and post what it found as a comment
- validate JSON contributions against the schema

The analysis comment is the useful part: if the parser mishandles your log, it
shows up there and that is exactly the bug worth having.

---

## Sign your commits off (DCO)

Add a `Signed-off-by:` line to each commit:

```bash
git commit -s -m "Add channel names for Gen IV layout"
```

That certifies you wrote the contribution or otherwise have the right to submit
it under this project's licence — the
[Developer Certificate of Origin](https://developercertificate.org/). There is
no CLA to sign; contributions are simply under GPL-3.0, same as the rest.

## Repository rules

`main` is protected:

- **CI runs on every pull request** — the tests, the no-binaries check and the
  scrub check. Nothing gets merged with red CI.
- **History cannot be rewritten** — no force pushes, no branch deletion. This
  is enforced for everyone, the maintainer included.
- **Conversations must be resolved** before a pull request merges.
- **Commits must be signed off.** The web editor enforces this; from the
  command line use `git commit -s`.

Work on a branch or a fork and open a pull request. Nothing is merged with red
CI, least of all anything touching the analysis maths.

## Licence

This project is **GPL-3.0** — see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md) for why it has to be. Contributions are accepted under
the same terms.

## Running the tests

```bash
node scripts/test.mjs
```

Anything touching `app/modules/` needs tests. The rule the suite exists to
enforce: **a silently wrong number is worse than a crash.** Every assertion in
`scripts/test/` is there because something produced a confident wrong answer.
