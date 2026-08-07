## What this changes

<!-- One or two sentences. If it fixes an issue, link it. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) — see [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] `node scripts/test.mjs` passes
- [ ] Anything touching `app/modules/` has tests
- [ ] `CHANGELOG.md` updated if this is a feature or a fix

## If this includes a datalog

- [ ] `node scripts/scrub-log.mjs --check <file>` reports nothing
- [ ] I opened the file and read it, and it contains no VIN, address, or personal note
- [ ] It is a log from **my own vehicle**
- [ ] No `.bin`, `.hpt`, `.hpl` or third-party `.xdf` is included

## If this changes analysis behaviour

- [ ] I have said what the numbers were before and after
- [ ] Draft readings are still labelled as draft readings
