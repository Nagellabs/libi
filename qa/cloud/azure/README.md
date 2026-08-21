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
qa/cloud/azure/lab.sh stop win      # a break WITHIN a session: compute billing stops
qa/cloud/azure/lab.sh snapshot win  # end of session: keep a restorable image
qa/cloud/azure/lab.sh down --keep-snapshots   # …then delete the VMs
qa/cloud/azure/lab.sh restore win   # next session: skip provisioning entirely
qa/cloud/azure/lab.sh down          # when the lab is finished for good
```

## What it costs, and why the lab is deleted rather than kept

Every number below came from the Azure retail price API (`prices.azure.com`)
for **westeurope on 2026-08-21**. Re-check before quoting them; Azure moves.

**Compute is not the problem.** The VMs only bill while running:

| | vCPU / RAM | Linux $/hr | Windows $/hr | 8-hour session |
|---|---|---|---|---|
| `Standard_D4s_v5` *(chosen)* | 4 / 16 GB | 0.230 | 0.414 | $3.31 win, $1.84 linux |
| `Standard_B4ms` *(rejected)* | 4 / 16 GB | 0.192 | 0.208 | burstable — see below |
| `Standard_D2s_v5` | 2 / 8 GB | 0.115 | 0.207 | too small |

`B4ms` is roughly half the Windows rate for identical specs, and it was still
rejected. Local **tracking** is a sustained all-core load for 10–20 minutes,
which is exactly what drains B-series credits. A throttled run does not fail —
it comes back *slow*, and we would have no way to distinguish a real platform
regression from a spent credit balance. On a rig whose only purpose is trusting
the result, $0.21/hr is a cheap way to delete that confound.

**Sizing scope:** local **music** generation (ACE-Step, ~14 GB RAM, 7.7 GB of
weights) is deliberately out of scope — it is the one heavy surface with no
platform-specific risk, being the same Python wheels everywhere. Dropping it is
what keeps this a 16 GB box. Tracking stays in scope precisely because it is a
native/pyenv path, which is the kind that breaks per platform.

**Idle disks are the problem.** A stopped VM still bills for its disk:

| what you keep | monthly |
|---|---|
| 128 GB **Premium** SSD (P10) — *Azure's default for `s` sizes* | **$21.68** |
| 128 GB Standard SSD (E10) | $9.60 |
| 64 GB Standard SSD (E6) | $4.80 |
| **incremental snapshot**, Standard HDD, billed on USED space | **$0.05/GB** |

So the lab now creates disks as `StandardSSD_LRS` explicitly rather than
accepting the Premium default — that alone is the difference between $21.68 and
$9.60 per box per month.

**The decision.** Keeping both disks so you can `stop`/`start` costs about
**$14.40/month**. Keeping only *snapshots* — a Windows box with ~50 GB used
plus a ~15 GB Ubuntu box — costs about **$3.25/month**, and restoring from one
is *faster* than a cold rebuild because it skips Category A, the model
downloads and the tracking pyenv (roughly an hour of setup).

The cheapest option and the fastest option are therefore the same option, so
that is the default workflow:

```bash
lab.sh snapshot win && lab.sh snapshot linux
lab.sh down --keep-snapshots     # VMs, disks, NICs and public IPs all released
```

`down --keep-snapshots` deletes the VMs *and* hunts the orphans Azure leaves
behind — unattached OS disks, NICs, and Standard public IPs, which bill hourly
whether or not anything is attached to them. That orphan trio is the usual
reason a "deleted" cloud lab keeps costing money.

Bare `down` deletes the resource group including the snapshots; it warns you
how many it is about to destroy before asking for confirmation.

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

## How QA is actually driven — two tiers, and the split is not negotiable

The packaged app exposes **no CDP** (`electron/main.ts` gates it on `isDev`), so
it cannot be driven with Playwright the way the dev shell can. That does not
make Windows QA manual — it makes it two-tier.

**Tier 1 — scripted, no screen, no credential.**
`az vm run-command invoke` (wrapped as `lab.sh exec`) runs a script on the box
through the **Azure control plane**: no SSH, no RDP, no open port, and nothing
secret on the machine. It returns stdout here. That is enough to install
silently (NSIS accepts `/S`), launch the app, wait for Category A, and then
interrogate the app's own HTTP server and logs — the port is published to
`$LIBI_HOME/port`, because `LIBI_PORT` is dev-only.

```bash
qa/cloud/azure/lab.sh exec win qa/cloud/azure/remote/win-smoke.ps1
```

**Tier 2 — eyes on a screen.** RDP in. Some findings are irreducibly visual and
pretending otherwise is how you ship a broken first-run:

- what **SmartScreen** actually says on an unsigned installer — the whole point
  of the "experimental" warning we would write;
- whether the **installer UX** is sane;
- whether the **terminal panel** opens a usable `powershell.exe` (ConPTY);
- whether anything simply *looks* wrong.

Linux is the same shape. `provision` installs **xvfb**, which is enough to RUN
the app headless for Tier 1. For Tier 2 on Linux — actually seeing it — run
`lab.sh desktop linux`, which adds xfce + xrdp so you connect with the same RDP
client you use for Windows. It is opt-in because most runs never need it.

| | Tier 1 (scripted) | Tier 2 (eyes) |
|---|---|---|
| Windows | `lab.sh exec win …` | RDP — already available |
| Linux | `xvfb-run` via `lab.sh exec linux …` | `lab.sh desktop linux`, then RDP |

**Do not report a Tier-1 pass as "Windows works."** It proves the app installs,
boots and serves. It says nothing about what a user sees.

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

### Linux — yes, it can actually RUN the app

An Azure Ubuntu VM has **no display**, so "run the app" means headless via
`xvfb`. `lab.sh up linux` provisions that automatically (Node 22, the build
toolchain, `xvfb`, and Electron's runtime libs) by reusing
`qa/cloud/provision/ubuntu.sh` — the same script the GCE rig used, which
contains no cloud-specific calls.

Two details in that script worth not re-deriving: Ubuntu 24.04's 64-bit
`time_t` transition renamed `libasound2` → `libasound2t64`, `libgtk-3-0` →
`libgtk-3-0t64` and friends, so every electron-on-linux guide written before
2024 lists names that no longer resolve. And it deliberately does **not**
install ffmpeg, ffprobe, uv or Chromium — libi provisions those in Category A,
and that provisioning is exactly what the rig exists to test. An apt-installed
ffmpeg on PATH would mask a broken download URL and turn a real finding into a
false pass. That is precisely how the Linux `drawtext` bug (F5) survived.

Build, then run:

```bash
# on the box
node scripts/release-electron-platform.js --build

# boot the built artifact headless, as the GCE rig did
LIBI_HOME=~/qa/home xvfb-run -a ./release/Libi-<v>.AppImage --no-sandbox &
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/editor

# back on the Mac, where gh is authenticated
node scripts/release-electron-platform.js --attach linux ./release-linux
```

**Windows provisioning is manual on purpose.** These client images have no SSH,
and installing a key would put a credential on a QA VM. RDP in and run
`qa/cloud/provision/windows.ps1` yourself; `lab.sh provision win` prints the
command.

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
