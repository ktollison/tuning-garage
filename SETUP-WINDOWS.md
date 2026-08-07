# Windows Setup — Tuning Garage

One-time setup to run the tuning repo + app on a Windows machine.
About 15 minutes, most of it waiting on installers.

> **Prefer a version whose links open in new tabs?** Open
> `SETUP-WINDOWS.html` from this folder in your browser — same guide, every
> link opens in a new tab so these instructions stay put. (GitHub strips
> new-tab links from Markdown, which is why the HTML version exists.)
> Reading this on GitHub? **Ctrl+click** each download link to open it in a
> new tab.

---

## 1. Install three tools

Install all three before doing anything else. Defaults are fine **except
where called out below** — those options matter.

### Git for Windows

Download: <https://git-scm.com/download/win> (the 64-bit standalone installer)

The installer asks a lot of questions. What to pick:

| Installer screen | What to choose | Why |
|---|---|---|
| Select Components | Leave defaults | — |
| **Choosing the default editor** | **Notepad** (or VS Code if you have it) | The default is Vim, which is very hard to exit if you've never used it |
| **Initial branch name** | **Override → `main`** | This repo uses `main` |
| **Adjusting your PATH** | **"Git from the command line and also from 3rd-party software"** (the middle, recommended option) | The app runs `git` itself — this is required |
| SSH executable | Bundled OpenSSH | — |
| HTTPS transport | OpenSSL library | — |
| **Line ending conversions** | **"Checkout as-is, commit Unix-style line endings"** | Keeps the Mac launcher script working and avoids noisy whitespace-only diffs between machines |
| Terminal emulator | Either is fine (MinTTY is the default) | — |
| `git pull` behavior | Default (fast-forward or merge) | — |
| **Credential helper** | **Git Credential Manager** (default) | Required so pushes authenticate without typing a password |
| Extra options | Leave defaults (file system caching on) | — |
| Experimental options | Leave **unchecked** | — |

### Node.js (LTS)

Download: <https://nodejs.org> — the **LTS** button, not "Current".

| Installer screen | What to choose | Why |
|---|---|---|
| Destination folder | Default | — |
| Custom Setup | Leave everything enabled — especially **"Add to PATH"** | The launcher runs `node` |
| **"Tools for Native Modules"** checkbox | **Leave it UNCHECKED** | It installs Chocolatey + Visual Studio build tools (long, ~GB). The app has zero dependencies and doesn't need them |

### GitHub CLI

Download: <https://cli.github.com> (the Windows `.msi`) — defaults are fine.

### Check they all installed

Open **Command Prompt** (press Start, type `cmd`, Enter) and run these one at
a time. Each should print a version number:

```bash
git --version
```

```bash
node --version
```

```bash
gh --version
```

If any says "not recognized", the PATH option was missed during that
installer — reinstall it and check the PATH choice above.

---

## 2. Sign in to GitHub

In Command Prompt:

```bash
gh auth login
```

Answer the prompts:

- **What account?** → `GitHub.com`
- **Preferred protocol?** → `HTTPS`
- **Authenticate Git with your GitHub credentials?** → **`Yes`** (important — this is what lets pushes work)
- **How to authenticate?** → `Login with a web browser`, then copy the one-time code into the browser window that opens

## 3. Set your commit identity

Credentials and identity are two different things — without this, commits
fail. Run each line separately (PowerShell doesn't accept `&&`):

```bash
git config --global user.name "Your Name"
```

```bash
git config --global user.email "you@example.com"
```

Use the same email as your GitHub account so commits are attributed to you.

## 4. Make your own **private** repository

> **This repository must be private.** It will hold your calibration files,
> which contain **your VIN**, along with your datalogs and notes. A public
> repository publishes all of it, and git keeps the history — deleting a file
> later does not take it back. Set it private now; do not plan to fix it later.

**Already have the repo?** (Setting up a second machine.) Skip to
[step 5](#5-clone-your-repo).

### The easy way — in your browser

1. Go to **<https://github.com/ktollison/tuning-garage>**
2. Click the green **`Use this template`** button → **`Create a new repository`**
3. Name it `Tuning`
4. **Select `Private`.** ← the important one
5. Click **`Create repository`**

That is it. You now own a private copy with none of the starter kit's history
attached to it. Then bring it down to your PC:

```bash
cd %USERPROFILE%\Documents
```

```bash
gh repo clone YOUR-USERNAME/Tuning Tuning
```

Replace `YOUR-USERNAME` with your GitHub username.

### The one-command way

Same result, if you would rather stay in the Terminal:

```bash
cd %USERPROFILE%\Documents
```

```bash
gh repo create Tuning --private --template ktollison/tuning-garage --clone
```

### Check it really is private

Worth ten seconds, because this is the one mistake you cannot take back:

```bash
cd Tuning
```

```bash
gh repo view --json isPrivate,nameWithOwner
```

You want `"isPrivate": true`. If it says `false`, fix it **before** you add a
single tune file:

```bash
gh repo edit --visibility private --accept-visibility-change-consequences
```

## 5. Clone your repo

Only needed on a **second** machine — the first one already has it from step 4.

```bash
cd %USERPROFILE%\Documents
```

```bash
gh repo clone YOUR-USERNAME/Tuning Tuning
```

That creates `Documents\Tuning` — the same repo as on your other machine.

## 6. Run it

Double-click **`start-tuning.cmd`** in the `Tuning` folder. It pulls the
latest, starts the app, waits for the server to actually respond, then opens
<http://localhost:4590>.

Tip: right-click `start-tuning.cmd` → **Send to → Desktop (create shortcut)**.

Leave the black console window open while you use the app — closing it stops
the server.

---

## Daily two-machine rhythm

The one rule: **finish on a machine = Commit & push. Start on a machine = the
launcher pulls (or hit Sync in the app).**

- The launcher auto-pulls on start; the server also auto-pulls at startup when
  it's unambiguously safe (clean tree, nothing unpushed).
- If a machine is behind, the app shows **⇣ N behind GitHub** in orange and
  warns you — hit **Sync** before doing anything.
- Tuning tools save files wherever they like; use the app's upload forms to
  bring tunes and datalogs into the repo with correct names.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Committed and pushed ✓" but changes stay uncommitted | Old app version. Pull, restart — current versions surface the real error |
| Commit fails: "Author identity unknown" | Step 3 was skipped |
| `'&&' is not a valid statement separator` | You're in PowerShell — run each command on its own line |
| Browser opens to "can't connect" | The launcher now waits for the server; if it still happens, give it a moment and refresh |
| `git`/`node`/`gh` "not recognized" | PATH option missed in that installer — reinstall |
| Push rejected / asks for password repeatedly | Re-run `gh auth login` and answer **Yes** to "Authenticate Git with your GitHub credentials" |

## If both machines edited without syncing

The Sync button only fast-forwards (it never merges), so it will refuse and
tell you. Fix: on the machine with the newer work, Commit & push; on the other
machine run `git pull --rebase` in the repo folder. Binary tune files can't
merge — if the same file ever conflicts, keep both copies under new revision
names.
