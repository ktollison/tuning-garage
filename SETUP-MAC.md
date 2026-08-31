# macOS Setup — Tuning Garage

One-time setup to run the tuning repo + app on a Mac. About ten minutes, most
of it waiting on Homebrew.

Read **[DISCLAIMER.md](DISCLAIMER.md)** before you use any of this on a vehicle.

> **Note on what a Mac is good for here.** HP Tuners VCM Suite, PCMHammer and
> UniversalPatcher are Windows software, and **writing to a control module
> happens on Windows**. A Mac runs the app, the analysis and the repository
> perfectly well — research, reading logs, planning a revision — but it is not
> where the flash happens. Many people run exactly this split.

---

## 1. Install three tools

**Git**, **Node.js (LTS)** and the **GitHub CLI**. If you do not have
[Homebrew](https://brew.sh), install it first — the site gives you the one
command to paste.

```bash
brew install git node gh
```

macOS ships an old git that is fine for this, but Homebrew's is newer and it
keeps everything in one place.

### Check they all installed

Open a new Terminal window so it picks up the new tools, then:

```bash
git --version && node --version && gh --version
```

Node must be **18 or newer** — the app uses modern JavaScript and has zero
dependencies, so nothing else needs installing.

---

## 2. Sign in to GitHub

```bash
gh auth login
```

Answer:

- **What account?** → `GitHub.com`
- **Preferred protocol?** → `HTTPS`
- **Authenticate Git with your GitHub credentials?** → **`Yes`** *(important —
  this is what lets pushes work without prompting)*
- **How would you like to authenticate?** → `Login with a web browser`, then
  paste the one-time code

---

## 3. Set your commit identity

```bash
git config --global user.name "Your Name"
```

```bash
git config --global user.email "you@example.com"
```

Use the same email as your GitHub account so commits are attributed to you.

Skipping this is the classic silent failure: commits appear to succeed, the
push reports "up to date", and nothing has actually been saved.

---

## 4. Make your own **private** repository

> **This repository must be private.** It will hold your calibration files,
> which contain **your VIN**, along with your datalogs and notes. A public
> repository publishes all of it, and git keeps the history — deleting a file
> later does not take it back. Set it private now; do not plan to fix it later.

**Already have the repo?** (Setting up a second machine.) Skip to
[step 5](#5-clone-your-repo).

> **Do not put this in `~/Documents` or on the Desktop.** If iCloud Drive syncs
> those folders — the "Desktop & Documents Folders" option, which is on by
> default — macOS will evict the *contents* of files it thinks you are not
> using, leaving the name and size behind with nothing under them. A background
> agent reading one of those gets an error where a normal app would quietly
> download it, so your stock read can appear to vanish from the app while being
> perfectly safe in iCloud. This happened during development, to the datalogs,
> the donor bin and 275 git objects. `~/Tuning` is outside the synced area and
> avoids it entirely.

### The easy way — in your browser

1. Go to **<https://github.com/ktollison/tuning-garage>**
2. Click the green **`Use this template`** button → **`Create a new repository`**
3. Name it `Tuning`
4. **Select `Private`.** ← the important one
5. Click **`Create repository`**

That is it. You now own a private copy with none of the starter kit's history
attached to it. Then bring it down to your Mac:

```bash
cd ~ && gh repo clone YOUR-USERNAME/Tuning Tuning
```

Replace `YOUR-USERNAME` with your GitHub username.

### The one-command way

Same result, if you would rather stay in the Terminal:

```bash
cd ~ && gh repo create Tuning --private --template ktollison/tuning-garage --clone
```

### Check it really is private

Worth ten seconds, because this is the one mistake you cannot take back:

```bash
cd ~/Tuning && gh repo view --json isPrivate,nameWithOwner
```

You want `"isPrivate": true`. If it says `false`, fix it **before** you add a
single tune file:

```bash
gh repo edit --visibility private --accept-visibility-change-consequences
```

## 5. Clone your repo

Only needed on a **second** machine — the first already has it from step 4.

```bash
cd ~ && gh repo clone YOUR-USERNAME/Tuning Tuning
```

---

## 6. Run it

```bash
cd ~/Tuning && ./start-tuning.sh
```

It pulls the latest, starts the app, waits for the server to actually respond,
then opens <http://localhost:4590>.

If the script is not executable yet:

```bash
chmod +x start-tuning.sh
```

### Keep it running

Rather than starting it by hand every time, install the launchd agent — it
starts the app at login and relaunches it if it ever exits:

```bash
sh scripts/autostart-macos.sh install
```

```bash
sh scripts/autostart-macos.sh status
```

`status` reports two separate things: whether launchd has the agent loaded, and
whether the port actually answers. The useful failure is when those disagree.

`restart` reloads it after pulling changes, `uninstall` removes it. Logs are in
`logs/`, which is gitignored.

**One thing worth knowing:** the agent keeps a single process alive, and pulling
new code does not touch it — so the app can carry on serving the previous build
indefinitely. `status` now checks for this and says so:

```
STALE: serving v0.31.0, but the code on disk is v0.31.3.
  fix:  sh scripts/autostart-macos.sh restart
```

`./start-tuning.sh` handles it for you: it compares the running version against
the code on disk and restarts the agent if they differ, so the launcher is
always safe to run.

The app binds to **127.0.0.1 only** — nothing is exposed to your network — and
has zero dependencies.

### Setting up the public repository (maintainers only)

Issue forms can only apply labels that **already exist**. If they do not, the
form still works and the issue is still created — with no label at all, so the
alert workflow never fires and nothing errors. Create them first:

```bash
node scripts/setup-labels.mjs
```

Safe to re-run: it creates what is missing, corrects a colour or description
that has drifted, and does nothing when everything already matches.
`--check` reports without changing anything, for a fresh box or CI.

### Alerts when someone submits (maintainers only)

Only useful if you run the public project. Two paths, deliberately overlapping:

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

---

## Daily two-machine rhythm

If you tune on Windows and research on the Mac:

- **Start of a session:** the launcher pulls for you. If the app shows
  **⇣ N behind GitHub** in orange, press **Sync**.
- **End of a session:** press **Commit & push** so the other machine sees it.
- Upload files through the app's tabs rather than dragging them into Finder —
  it applies the naming convention and records which revision they belong to.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: brew` | Install [Homebrew](https://brew.sh), then open a new Terminal |
| `command not found: gh` after installing | Open a **new** Terminal window — `PATH` is read at launch |
| Push rejected, or it keeps asking for a password | Re-run `gh auth login` and answer **Yes** to "Authenticate Git with your GitHub credentials" |
| Commit says it worked but nothing changed | `git config --global user.email` is unset — see step 3 |
| Port 4590 already in use | Something else is on it: `lsof -nP -iTCP:4590 -sTCP:LISTEN`. Or run on another port: `PORT=4700 node app/server.mjs` |
| App will not start after a pull | `node --version` — must be 18+ |
| App is running old code after a pull | `./start-tuning.sh` — it detects the mismatch and restarts. Or `sh scripts/autostart-macos.sh restart` |
| Files listed but unreadable, or `Unknown system error -11` | iCloud evicted their contents. `brctl download <path>` restores them; move the repo out of `~/Documents` so it stops happening |
| Agent loaded but the port does not answer | Read `logs/app.err.log`; launchd runs with a minimal `PATH`, so re-run `install` if you changed how Node is installed |

## If both machines edited without syncing

Git will refuse the push. On the machine that is behind:

```bash
git pull --rebase
```

Binary tune files cannot be merged — if the same `.bin` changed on both sides,
keep one and re-upload the other under a new revision name. Text files
(changelogs, session notes) merge cleanly.
