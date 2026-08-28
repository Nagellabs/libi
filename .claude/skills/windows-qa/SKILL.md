---
name: windows-qa
description: Build, install and verify a libi desktop build on the Windows QA VM. Use before shipping anything Windows-facing, or whenever a build must be put in front of a real Windows user. Encodes the traps that have each cost hours — npm ci vs npm install, CI=1, processes dying with the SSH session, and what "installed" actually means.
---

# Windows QA — driving a test build onto the VM

Every rule here comes from a failure that happened. Do not relax one without
evidence.

**Connection details, the VM's name and its firewall rules are NOT in this
repo** — they are in `docs-local/release/windows-qa-runbook.md`, which also
carries the fuller narrative. Read that first; this file is the rule list.

## Getting the code there

The VM has an **extracted tarball at `C:\build\src`, not a clone** — no `.git`,
so no git command works there. Ship with `git archive | gzip` → `scp` → untar.
Roughly 9 MB. No push is involved, so this is fine on any day and does not
touch the weekend-publishing rule.

Always read the provenance line the extract script prints. It is the only thing
between you and confidently building last week's code.

## Building

```powershell
npm ci --no-audit --no-fund
npm run build:electron -- --publish never
```

- **`npm ci`, NEVER `npm install`.** `npm install` rewrites
  `package-lock.json` on Windows, which makes `THIRD-PARTY-NOTICES.md` stale
  against it and correctly fails `prebuild:electron`. The gate is right; the
  install is wrong. Restore the committed lockfile and use `npm ci`.
- **Never set `CI=1`.** electron-builder then tries to publish to GitHub
  Releases and aborts on a missing `GH_TOKEN`, before producing an installer.
  `--publish never` states the intent.
- Budget ~11 min for `npm ci` and ~13 min for `build:electron`. Skip `npm ci`
  on a rebuild whose lockfile has not changed.
- **You usually should not hand-build here at all any more.** Since the release
  workflows were split (2026-08-28), `release-electron.yml` with
  `dry_run: true` builds the real macOS and Windows shells in CI and uploads
  their artifacts **without publishing anything**, on any day of the week. That
  gives you the actual release artifact — the thing users get — rather than a
  local approximation of it, so prefer downloading it from the run over
  building on this box. Hand-building is still the right move when you are
  testing an unpushed branch.
- The `dry_run` escape applies to the CI path only. Run
  `scripts/release-electron.js` **on a machine that configures a local window**
  (`scripts/release-window.local.json`) outside Fri/Sat and
  `assertReleaseWindow()` refuses, by design. Runners carry no such file, which
  is why the workflow's own window job is what enforces the rule there — and
  why a dry run is exempt from it.

## Installing

The silent install takes **~12 minutes**. Everything here follows from that.

- **Launch it as an S4U scheduled task.** A process started with
  `Start-Process` over SSH dies when the SSH session ends — one attempt left
  nothing installed at all because of this.
- **`Start-Process -Wait` hangs the SSH session** on the NSIS installer. Poll
  from separate short calls.
- **Never kill it for looking stuck.** Giving up after 3 minutes and killing it
  left every file copied but no Start-menu shortcut, no desktop shortcut and no
  uninstall registry entry — an app that cannot be launched and reads to the
  user as "it was removed".
- **The completion signal is the INSTALLER PROCESS EXITING — nothing else.**
  The exe, the Start-menu shortcut AND the uninstall registry entry are all
  written EARLY, before the installer extracts the app bundle, which is the
  bulk of the payload. Polling for any of them reports "installed" on a build
  whose packaged `.next` does not exist yet — and a provenance check against
  that comes back all zeros, looking exactly like a bad build.
- **Verify all five together, after the process exits:** no installer running,
  the exe, the shortcut, the registry entry, and `.next` present inside the
  bundle — the last being what the shell actually loads. Report readiness on
  that set, never on any single one.
- **The installer launches the app when it finishes.** It lands in session 0
  with nowhere to render but still creates its data directory, so clear that
  afterwards or the "fresh install" being handed over is not one.

## Proving the build is the code you think it is

Search the INSTALLED tree, at
`<install>\resources\libi-bundle\node_modules\@nagellabs\libi\.next`:

- Use `Get-ChildItem … -Recurse -Filter *.js` piped to `Select-String`. A `**`
  glob handed to `Select-String -Path` matches nothing SILENTLY and reports a
  good build as empty.
- Search **both `static` and `server`**. Client components put their strings in
  `.next/static`; searching only `server` finds zero and looks like a bad build.
- Assert absences too — a testing-only flag that should be gone, and any
  simulation module that must never ship.

## Resetting to a first run

The app keeps everything under `%APPDATA%\Libi` — the database, the persisted
UI state and ~700 MB of downloaded binaries. **The uninstaller leaves it**, so
uninstall + reinstall drops you back into the app you already set up while
looking like a fresh install.

```powershell
# Fast: back at the first screen in seconds, keeps the downloads.
Remove-Item "$env:APPDATA\Libi\libi.sqlite","$env:APPDATA\Libi\Local Storage" -Recurse -Force

# Full: a genuine new user. Uninstall first; first boot re-downloads ~700 MB.
Remove-Item "$env:APPDATA\Libi" -Recurse -Force
```

## Seeing the UI

**You cannot.** Nobody is logged in, so a GUI app launched over SSH lands in
session 0, finds nowhere to render, and exits leaving no window and no logs —
which looks exactly like a crash and is not. RDP is the only way, and it needs
a password, so that step belongs to the operator. Say so plainly rather than
reporting a headless check as if it were a launch.

Server-side paths can be exercised headlessly by running the packaged runtime
without Electron under an S4U task.

## Two habits that prevent most of the above

1. **Write a `.ps1`, `scp` it, run it with `-File`.** Quoting through
   bash → ssh → PowerShell mangles reliably. Keep those scripts **ASCII-only** —
   one em dash arrives as mojibake and breaks the parser.
2. **Trust the status file, not the SSH exit code.** A wrapper piping to `tail`
   exits 0 while the build inside it failed. Have every script write
   START/OK/FAIL/DONE lines to a status file, and read that.
