# Maintaining the public project

Only needed if you run a public copy of this project that accepts
submissions. Using Tuning Garage for your own car needs none of this.

## Repository settings

The docs make promises only a GitHub setting can keep: SECURITY.md sends people
to private vulnerability reporting, CONTRIBUTING.md says the web editor enforces
sign-off and that history cannot be rewritten, and the README says "Use this
template". A setting can be switched off without anyone touching a file, and
for weeks SECURITY.md pointed at a feature that was off.

```bash
node scripts/check-repo-settings.mjs
```

It reads the settings and checks each promise, printing the command that fixes
any it finds broken. It needs an administrator's token, so it runs on your
machine (the maintainer's publish script runs it before every release), not in
CI. `--offline` skips quietly when `gh` is not signed in.

## Docs that must match the code

```bash
node scripts/check-kit-docs.mjs
```

Fails when a doc names a file that is not in the repository, a link or an
anchor is broken, the changelog is out of shape, a script or module is named
nowhere, the README's tabs or `reference/api.md` disagree with the app, or the
minimum Node version differs between the server, launchers, docs and CI. It
also needs the User Guide's "Last checked against" stamp to name the current
version, so a release is a prompt to read the guide. `--list` says what it
checks, and CI runs it on every push.

## Labels for the issue forms

Issue forms can only apply labels that **already exist**. If they do not, the
form still works and the issue is still created — with no label at all, so the
alert workflow never fires and nothing errors. Create them first:

```bash
node scripts/setup-labels.mjs
```

Safe to re-run: it creates what is missing, corrects a colour or description
that has drifted, and does nothing when everything already matches.
`--check` reports without changing anything, for a fresh box or CI.

## Alerts when someone submits

Two paths, deliberately overlapping:

```bash
sh scripts/autostart-macos.sh watch-install
```

That polls the public repo every 15 minutes and pushes a notification for
anything new. It catches **fork pull requests**, which the GitHub Actions alert
cannot — GitHub withholds secrets from fork workflows by design, and a fork PR
is exactly how a git-literate contributor submits.

Alerts need a Pushover application token and user key in
`~/.config/tuning-garage/pushover.env`:

```bash
mkdir -p ~/.config/tuning-garage && chmod 700 ~/.config/tuning-garage
```

```bash
printf 'PUSHOVER_TOKEN=your-app-token\nPUSHOVER_USER=your-user-key\n' > ~/.config/tuning-garage/pushover.env
```

```bash
chmod 600 ~/.config/tuning-garage/pushover.env
```

The token never goes in the repository. Without that file the poller still runs
and simply sends nothing, so this is safe to install before setting it up.
Test it with:

```bash
bash scripts/notify-pushover.sh --title "Tuning Garage" --message "alerting works"
```

Remove with `sh scripts/autostart-macos.sh watch-uninstall`.
