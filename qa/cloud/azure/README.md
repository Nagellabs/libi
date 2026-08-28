# The Azure QA lab — raise a machine, prove a thing, put it away

Two disposable boxes for the tests that cannot run on a Mac: a **Windows 11**
VM and an **Ubuntu 24.04** VM. Not a permanent environment — the whole point is
that they exist for an afternoon and then stop costing money.

The lab's lifecycle is **snapshot-and-restore**: at the end of *every* session
the VMs are deleted and a snapshot kept, and the next session starts from that
snapshot in minutes instead of re-provisioning for an hour. That is the happy
path, not an optimisation — the cost table below shows why the cheapest option
and the fastest option are the same one.

```bash
cp qa/cloud/azure/azure.local.sh.example qa/cloud/azure/azure.local.sh   # once
qa/cloud/azure/lab.sh doctor        # preflight, costs nothing

# FIRST session only — a full build (~5 min create + ~1 h provisioning):
qa/cloud/azure/lab.sh up win
qa/cloud/azure/lab.sh connect win
#   … do the work …   (a break WITHIN a session: lab.sh stop win)

# END OF EVERY SESSION — snapshot, then delete the VMs. This pair is the
# normal way to put the lab away, not an advanced option:
qa/cloud/azure/lab.sh snapshot win
qa/cloud/azure/lab.sh down --keep-snapshots

# EVERY LATER session — minutes, skips provisioning entirely:
qa/cloud/azure/lab.sh restore win
qa/cloud/azure/lab.sh allow-my-ip   # a restored box gets a NEW public IP

qa/cloud/azure/lab.sh down          # only when the lab is finished for good
```

## Which region — four bars, and all four are load-bearing

The lab runs in **`swedencentral`** (`LIBI_AZ_LOCATION`). That default was not
a preference: a region is only usable if it clears **all four** of these, and
each one eliminated a real candidate on 2026-08-22:

1. **Accepts new customers.** Azure closes popular regions to subscriptions
   without prior footprint. `westeurope` — the original default — refuses new
   customers entirely.
2. **Offers the chosen VM size.** `northeurope` has no `Standard_D4s_v5`.
3. **Hosts the Windows 11 client image**, which is the entire point of the
   Windows box (`doctor` probes this with a validate-only deployment).
4. **Offers `Microsoft.DevTestLab/schedules`** — the resource type behind
   `az vm auto-shutdown`, i.e. the lab's *only* safety net against a forgotten
   VM billing for a month. `israelcentral` cleared bars 1–3, passed every check
   the tooling then had, and failed *here* — `LocationNotAvailableForResourceType`,
   thrown only **after** the VM existed (the EXIT trap caught it and
   deallocated; nothing leaked). In such a region the lab's core safety
   guarantee cannot exist at all.

`swedencentral` clears all four and was also the cheapest of the candidates
tested ($0.388/hr Windows `D4s_v5` vs $0.408 in israelcentral).

Bar 4 is now a hard precondition: `doctor` reports it as a line under "lab
preconditions", and `scaffold`/`up`/`restore` refuse **before creating
anything** — even the free scaffold, since a scaffold in such a region silently
sets up a lab that can never be safe. The supported-region list is read from
Azure each run (`az provider show -n Microsoft.DevTestLab`), not hardcoded,
because the footprint drifts. Note the trap the check exists to name:
*registering* the DevTestLab provider (subscription-wide) is not the same as
the provider *offering* `schedules` in your region (per-region footprint).

**Changing region later:** a resource group's location is fixed at creation,
so editing `LIBI_AZ_LOCATION` with a group already present does **not** move
the lab — it used to just keep building in the old region silently. The
tooling now detects the mismatch (`doctor`, `status`, and any create path) and
stops: either set `LIBI_AZ_LOCATION` back to the group's region, or `lab.sh
down` the old lab first. Snapshots are regional and do not move with you.

## What it costs, and why the lab is deleted rather than kept

Every number below came from the Azure retail price API (`prices.azure.com`)
for **westeurope on 2026-08-21**. Re-check before quoting them; Azure moves.
(The lab has since moved to `swedencentral` — the one rate re-checked there,
Windows `D4s_v5`, was slightly *cheaper* at $0.388/hr vs 0.414. The tables
keep the westeurope figures as sampled.)

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

One number you do not get to choose: the Windows 11 client image itself ships a
**127 GiB** OS disk, and Azure can only *grow* an image's disk, never shrink it
— so the Windows box always lands at 127 GB (E10, **$9.60/mo** idle) no matter
what `LIBI_AZ_DISK_GB` asks for. `lab.sh up` clamps the request to that floor
and prints the size actually provisioned, because that is the number the disk
bills on. The 64 GB default applies in practice to the Ubuntu box only (its
image is 30 GiB, so 64 is a genuine grow). This is one more reason
snapshot-and-restore is the default: an idle 127 GB disk is the exact cost the
end-of-session pair above deletes.

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

### The Windows admin password — where it lives, and why not here

`az vm create` prompts for it and it goes straight to Azure. These scripts
deliberately never generate, echo, or write it, so it cannot end up in shell
history, in this repo, or in an agent transcript. That is the point, and it
has a consequence worth stating plainly: **nothing here remembers it for you.**

You invent it at `lab.sh up win` — it is not an Azure credential, it is the
local Windows Administrator account on the VM being created. The username is
already fixed (`LIBI_AZ_ADMIN`, default `libiqa`); only the password is yours
to choose. Azure requires 12–123 characters with at least three of lowercase,
uppercase, digit, and symbol, rejects anything containing the username, and
refuses passwords on its common-password list.

Keep it in the macOS Keychain. `-w` with no value makes `security` prompt, so
the password never appears in your shell history either:

```bash
# store, once, right after creating the VM
security add-generic-password -a libiqa -s libi-qa-win-rdp -w

# retrieve, when you need to RDP
security find-generic-password -a libiqa -s libi-qa-win-rdp -w
```

Storing it there buys you a second thing: **`lab.sh up win` becomes
unattended.** When that exact entry exists, `up win` answers `az`'s password
prompt itself — no human at the TTY — and it does so without weakening the
design above. The only argv-free input `az vm create` offers is its
interactive prompt (there is no environment variable, no `@file`, and piped
stdin is refused outright — established against the CLI's own source and
verified with a `--validate` probe; `--admin-password <value>` is off the
table because argv is readable by every local process via `ps`). So the
tooling drives that prompt over a pseudo-terminal: `lib/keychain-pw.expect`
reads the entry with `security` itself and types it straight to `az`. The
value flows **Keychain → expect's memory → az's tty** and touches nothing
else — not the shell (even `bash -x` shows nothing), not argv, not the
environment, not a file, not the terminal (echo is already off), and not any
error message.

The details:

- **Opt-in by existence.** No matching entry — or no macOS `security`, e.g.
  on Linux — and `up win` prompts interactively exactly as before.
- The names are configurable in `azure.local.sh`:
  `LIBI_AZ_WIN_PW_KEYCHAIN_SERVICE` (default `libi-qa-win-rdp`) and
  `LIBI_AZ_WIN_PW_KEYCHAIN_ACCOUNT` (default `$LIBI_AZ_ADMIN`).
- **"Unattended" has one caveat:** reading the secret can raise the macOS
  keychain-access dialog — always on a locked keychain, and on an unlocked
  one until you click "Always Allow". That is the OS asking you to approve
  the read, and it is a feature, not a bug.
- `restore win` never needs the password at all: it rebuilds the VM around
  the existing disk (`--attach-os-disk`), which carries the Administrator
  account — and the password — it already had.
- The scripts still only ever **read** the entry. Nothing here creates,
  writes, or migrates a password.

**An agent should not fetch it for you, and should decline if asked.** Handling
a password in plaintext is exactly what the design above avoids, and routing it
through a transcript undoes the protection in one step. The Keychain path is
precisely the alternative: an agent (or you) runs `lab.sh up win` and the
password still never enters a transcript, a variable, or an argument list. If
you need it for RDP, retrieve it yourself and paste it into your RDP client.

Most QA does not need it at all. `lab.sh exec` drives the box through the Azure
control plane (`az vm run-command`) with no credential on the machine and no
RDP session — so the password is only for the parts a human has to *look* at:
SmartScreen, installer UX, and the app's own window. Reach for `exec` first and
the password stays a rare requirement rather than a daily one.

If it is ever lost, do not rebuild the VM — reset it in place:

```bash
az vm user update -g libi-qa -n libi-qa-win -u libiqa -p '<new password>'
```

That leaves the disk, the provisioned state, and any snapshot untouched. Note
it does put the new password in your shell history; clear that line afterwards,
or change it interactively through the portal instead.

## Windows 11 vs Windows Server — a real decision, not a detail

`doctor` validates whether this subscription may deploy the **Windows 11
client** image. Azure gates `MicrosoftWindowsDesktop` images behind
subscription eligibility and enforces it at *deploy* time, so seeing it in
`az vm image list` proves nothing — hence a real `--validate` probe.

`doctor` checks the lab's preconditions first — resource providers registered,
auto-shutdown capability in the region (see "Which region"), resource group
present and in the *configured* region — and reports each separately. The probe only runs once
they hold, and when it fails it prints Azure's error verbatim: a validate probe
against a half-set-up lab fails for reasons that say nothing about entitlement,
so an `UNAVAILABLE` verdict is only issued when it really means "this
subscription cannot deploy the client image". `doctor` never fixes anything
itself — it costs nothing and changes nothing; `lab.sh up` is what registers
providers and builds the (free) scaffold.

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
