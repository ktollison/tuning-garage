# Security policy

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](../../security/advisories/new)**
rather than opening a public issue.

## Scope

The app is a zero-dependency Node server that **binds `127.0.0.1` only** and is
not intended to be exposed to a network. Things worth reporting:

- Path traversal or arbitrary file read/write through any `/api/` endpoint
- Anything that lets page content execute script (the Library markdown renderer
  escapes input first and is tested for this, but say so if you get past it)
- A way to make the exporter leak personal data into a starter kit
- Anything that causes the app to write to a tune file — it is designed never
  to modify one

Out of scope: exposing the server to the internet yourself, and anything
requiring local filesystem access you already have.

## Not a security issue, but tell us anyway

A wrong analysis result. A tuning tool that reports a confident wrong number
can cost someone an engine, which we take as seriously as a vulnerability.
Open a normal issue with the log attached — scrubbed, per
[CONTRIBUTING.md](CONTRIBUTING.md).
