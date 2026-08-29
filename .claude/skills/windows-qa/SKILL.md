---
name: windows-qa
description: Build, install and verify a libi desktop build on the Windows QA VM. Use before shipping anything Windows-facing, or whenever a build must be put in front of a real Windows user. Encodes the traps that have each cost hours — npm ci vs npm install, CI=1, processes dying with the SSH session, what "installed" actually means, and the big one — the VM is an elevated administrator, so an elevated pass proves nothing about a real user.
---

# Windows QA — driving a test build onto the VM

Every rule here comes from a failure that happened. Do not relax one without
evidence.

**Connection details, the VM's name and its firewall rules are NOT in this
repo** — they are in `docs-local/release/windows-qa-runbook.md`, which also
carries the fuller narrative. Read that first; this file is the rule list.

**Start with "The VM is an ADMINISTRATOR" below.** It is the newest rule and the only one that has let a broken build reach users.

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

## The VM is an ADMINISTRATOR. Real users are not.

Added 2026-08-28, after this cost a shipped release.

`libiqa` is in `Administrators`, an SSH session on the box is **elevated**, and
its token holds `SeCreateSymbolicLinkPrivilege`. A real user's token does not:
UAC strips it from administrators and ordinary accounts never had it, unless
Developer Mode is on (it is off there, and off by default everywhere).

v0.1.8 shipped a Windows build that **did not start for any ordinary user** and
passed every QA pass on this box, because the whole product's boot depends on
creating a directory symlink and this account is allowed to. The app died
between two log lines with no error: a splash screen that never resolved.

So: **an elevated pass is not evidence for anything privilege-sensitive** —
symlinks, junctions, writes outside the user profile, service registration,
firewall rules. Re-run those under a genuinely unprivileged principal:

```powershell
schtasks /create /tn Probe /tr "C:\path\to\probe.exe" /sc once /st 00:00 ^
  /ru "NT AUTHORITY\LOCAL SERVICE" /f
schtasks /run /tn Probe
schtasks /query /tn Probe /v /fo LIST | findstr "Last Result"
```

LOCAL SERVICE needs no password, so this puts no credential on the box. Give it
a working directory it can actually read — it cannot see `libiqa`'s profile, so
copy any binary it needs to something like `C:\junctest\`.

**Do NOT use `runas /trustlevel:0x20000` for this.** It is a SAFER *restricted*
token, not a UAC-filtered one, and it fails in ways real users never see —
junctions it creates are structurally perfect and permanently unreadable, which
looked exactly like a second product bug and cost an hour to disprove.

The GUI half still needs a screen. Launching over SSH gives an elevated token,
so "it booted over SSH" says nothing about a real first run; do that check at
an RDP session.

## Two ways to hurt yourself on this box

**Never `icacls` a directory you are connected through.** Granting rights on
`%USERPROFILE%` (or its parents) to test something as another principal resets
the SSH session mid-command — sshd runs as that user. It happened on 2026-08-28,
left the ACLs half-applied and the app tree without its farm, and cost two
recovery passes. If you need another principal to reach the install, copy what
it needs to `C:\<something>` instead and grant there.

**Getting a CI artifact onto the box: hand it the signed URL, don't relay it.**
The artifacts API 302s to a signed Azure blob URL, and the VM is itself in
Azure — so it pulls 795 MB in about 25 seconds, against several minutes of
uplink if you download locally and `scp` it up.

```bash
curl -s -o /dev/null -w "%{redirect_url}" \
  -H "Authorization: token $(gh auth token)" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/Nagellabs/libi/actions/artifacts/<id>/zip"
```

Write that URL to a file, `scp` the file (it is a few hundred bytes), and have a
`.ps1` on the box `Invoke-WebRequest` it. The URL is short-lived, so fetch it
immediately before use.

## Two habits that prevent most of the above

1. **Write a `.ps1`, `scp` it, run it with `-File`.** Quoting through
   bash → ssh → PowerShell mangles reliably. Keep those scripts **ASCII-only** —
   one em dash arrives as mojibake and breaks the parser.
2. **Trust the status file, not the SSH exit code.** A wrapper piping to `tail`
   exits 0 while the build inside it failed. Have every script write
   START/OK/FAIL/DONE lines to a status file, and read that.
