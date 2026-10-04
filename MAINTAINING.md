# Maintaining the public project

Only needed if you run a public copy of this project that accepts
submissions. Using Tuning Garage for your own car needs none of this.

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
