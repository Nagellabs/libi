# The Azure QA lab — raise a machine, prove a thing, put it away

Two disposable boxes for the tests that cannot run on a Mac: a **Windows 11**
VM and an **Ubuntu 24.04** VM. Not a permanent environment — the whole point is
that they exist for an afternoon and then stop costing money.

```bash
cp qa/cloud/azure/azure.local.sh.example qa/cloud/azure/azure.local.sh   # once
qa/cloud/azure/lab.sh doctor        # preflight, costs nothing
qa/cloud/azure/lab.sh up win        # ~5 min
qa/cloud/azure/lab.sh connect win
#   … do the work …
qa/cloud/azure/lab.sh stop win      # between sessions: compute billing stops
qa/cloud/azure/lab.sh down          # when finished: deletes everything
```

## The two rules that matter more than anything else here

**1. No credential ever goes on these machines.** Not `gh auth`, not an npm
token, not a cloud login, not `FAL_KEY` / `ELEVENLABS_API_KEY` /
`ANTHROPIC_API_KEY`. The VM builds; artifacts come back here; anything that
needs a token runs where the token already lives. This is why
`scripts/release-electron-platform.js` splits `--build` (on the target) from
`--attach` (here). Inherited from the retired GCE rig, and not negotiable.

**2. `stop` is not `down`, and neither is as safe as GCE's was.** The GCE rig
had the cloud itself delete a forgotten VM (`--max-run-duration` +
`--instance-termination-action=DELETE`). **Azure has no equivalent.** What we
have instead:

| Command | What it does | What it still costs |
|---|---|---|
| `stop <plat>` | **Deallocates** — compute billing stops | the OS disk (single-digit $/month) |
| `down` | Deletes the whole resource group | nothing |
| *(nothing)* | daily auto-shutdown deallocates it for you | the disk |

So the worst realistic outcome of forgetting is a disk bill, not a running-VM
bill. That is a bounded leak — but it is a real one, so `lab.sh status` prints
disks and unattached public IPs, which are the two things that bill silently.
Run it when you are not sure.

## Access

Inbound is opened to **your current public IP only**, never `0.0.0.0/0`. The
GCE rig used IAP tunnelling for this; Azure Bastion costs more per hour than
these VMs do, so a single-source NSG rule is the equivalent. If your network
changes (new office, VPN on/off) you will simply be unable to connect — that is
the rule doing its job. Fix it with:

```bash
qa/cloud/azure/lab.sh allow-my-ip
```

The Windows admin password is prompted for by `az vm create` and goes straight
to Azure. It is deliberately never generated, echoed, or written by these
scripts, so it cannot end up in shell history or an agent transcript.

## Windows 11 vs Windows Server — a real decision, not a detail

`doctor` validates whether this subscription may deploy the **Windows 11
client** image. Azure gates `MicrosoftWindowsDesktop` images behind
subscription eligibility and enforces it at *deploy* time, so seeing it in
`az vm image list` proves nothing — hence a real `--validate` probe.

It matters which you get:

- **Windows 11 Pro** — what real users run. The only place SmartScreen
  behaviour on an unsigned installer, and the actual installer UX, can be
  observed.
- **Windows Server 2022** — what CI already builds on. Fine for build and most
  runtime checks, useless for the two questions above.

Confirmed available on this subscription 2026-08-21: `win11-24h2-pro`.

## What to run once the box is up

### Windows — the gate on ever shipping a Windows build

libi has **never been launched on Windows by a human.** CI proves it compiles;
nothing more. Work in this order, because each step gates the next:

1. **Install and launch.** Copy over `Libi Setup <v>.exe`, install, run it.
   Watch **Category A** complete. This is the first real test of the 0.1.2
   yt-dlp boot fixes, which were written blind — before them libi could not
   boot on Windows at all (a tier-1 dep failure is fatal). If Category A dies
   here, stop and read `%USERPROFILE%\.libi\logs\libi.log`.
2. **Terminal panel.** It should open a `powershell.exe` session
   (`lib/terminal/pty.ts:58`). ConPTY has never been exercised.
3. **A bundled npm MCP probes UP.** Proves the `.bin` cmd-shim fix
   (`23b23320`) — npm writes three files per bin on Windows and only the
   `.cmd` is spawnable.
4. **Export a video with a text overlay.** Proves gyan.dev's ffmpeg actually
   has `drawtext` in the product, not just in CI's isolated probe. This is the
   exact defect that broke Linux (F5).
5. **SmartScreen.** Note precisely what it says on the unsigned installer, so
   the "experimental" warning we ship is accurate rather than guessed.
6. Then the deferred Windows findings in
   `docs-local/release/2026-08-21-post-0.1.2-followups.md` Part D2 — **confirm
   each reproduces before changing anything**; three of the four are inferred
   from reading code, not observed.

### Linux — build and verify

```bash
# on the box
node scripts/release-electron-platform.js --build
# back on the Mac, where gh is authenticated
node scripts/release-electron-platform.js --attach linux ./release-linux
```

`--attach` refuses to upload without that platform's update-feed file
(`latest-linux.yml`), so the F2 defect — an AppImage that can never find an
update — cannot recur by forgetting.

Then: AppImage boots and serves the studio, the `.deb` installs, and an export
with a text overlay passes (regression check on F5).

## Cost

Record real numbers here after the first full cycle, so "leave it up over
lunch" becomes a decision with a figure attached rather than a shrug.

| | rate | notes |
|---|---|---|
| `Standard_D4s_v5` running | _tbd_ | 4 vCPU / 16 GB |
| 128 GB premium SSD, deallocated | _tbd_ | the cost of forgetting |
| one full Windows QA cycle | _tbd_ | create → QA → down |
