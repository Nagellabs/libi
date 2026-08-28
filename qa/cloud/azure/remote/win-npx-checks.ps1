# Runs ON the Windows QA VM via
#   lab.sh exec win qa/cloud/azure/remote/win-npx-checks.ps1
#
# The second half of the npx playbook. Assumes win-npx-start.ps1 has already
# left a studio running on $Port, and interrogates it.
#
# Split from the launcher for a reason that cost a whole run: `az vm
# run-command` is bounded by the RunCommandWindows extension's PROVISIONING
# timeout, and one script that booted libi and then waited on it blew straight
# through with VMExtensionProvisioningTimeout. The launched process survives
# that timeout perfectly well -- it was still serving /editor afterwards -- so
# the fix is to stop holding the channel open: start detached, return, then
# poll with short calls like this one.
#
# Prints a verdict, not a transcript -- run-command truncates output near 4 KB.

param(
  [int]$Port = 3456,
  # Which install to interrogate. "npx" is the published-package run;
  # "weekly" is a locally-built tarball under test. They keep separate homes
  # so a green run against one can never be mistaken for the other.
  [string]$Root = "npx"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Say($m) { Write-Host "[npx-checks] $m" }

# Run a native command whose stderr is NOISE, not failure.
#
# PowerShell 5.1 turns ANY output on a native command's stderr into a
# TERMINATING error when $ErrorActionPreference is "Stop" -- so `npm warn
# deprecated ...` and ffmpeg's version banner both abort the script despite
# the command succeeding. Judge these by their effects (a file appeared, a
# port answers), never by the absence of stderr.
function Invoke-Noisy {
  param([scriptblock]$Block)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Block 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}


# Locate a file inside the npx-cached libi package. `$suffix` is matched
# against the tail of the full path, so callers say 'registry\bundled.js'
# rather than a bare filename -- the package ships several same-named files
# (lib/fonts/bundled.js vs mcp/registry/bundled.js) and a bare name picks
# whichever the walk reaches first.
function Find-LibiFile($suffix) {
  $leaf = Split-Path $suffix -Leaf
  Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Filter $leaf -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'nagellabs' -and $_.FullName.EndsWith($suffix) } |
    Select-Object -First 1
}

# The node MSI edited the MACHINE PATH after this session's environment was
# captured, so re-read it or `node` is not found. Every run-command session
# starts fresh, so this belongs in each script, not only the launcher.
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH", "User")

$root = "$env:USERPROFILE\qa\$Root"
$libiHome = "$root\home"
$log = "$libiHome\logs\libi.log"

# The PACKAGED app binds an EPHEMERAL port and publishes it to $LIBI_HOME/port
# (LIBI_PORT is dev/npx-only -- electron/main.ts gates it on isDev), so guessing
# 3456 is wrong for an Electron run. Prefer the port file when it exists.
$portFile = Join-Path $libiHome "port"
if (Test-Path $portFile) {
  $fromFile = (Get-Content $portFile -Raw).Trim()
  if ($fromFile -and $fromFile -ne "$Port") {
    Say "using port $fromFile from $portFile (ephemeral -- a packaged build)"
    $Port = [int]$fromFile
  }
}

try {
  $code = (Invoke-WebRequest "http://127.0.0.1:$Port/editor" -UseBasicParsing -TimeoutSec 10).StatusCode
} catch {
  throw "nothing serving /editor on $Port -- start the studio first"
}
Say "studio is up (/editor -> $code)"
$failures = @()

# --- 4. bundled MCP servers probe UP -------------------------------------
# Probing is asynchronous and starts at boot, so poll rather than sampling
# once: a "starting" row read too early is not a failure.
$mcpDeadline = (Get-Date).AddMinutes(5)
$mcpSummary = "no data"
while ((Get-Date) -lt $mcpDeadline) {
  $servers = (Invoke-WebRequest "http://127.0.0.1:$Port/api/settings/mcp-servers" `
                -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
  # noServer rows (whisper, local-tts, local-music) are libraries libi calls
  # via `uv run`, with no spawnable daemon -- "unknown" is correct for them.
  $probed = $servers.servers | Where-Object { -not $_.noServer }
  $pending = $probed | Where-Object { $_.serverStatus -eq "starting" -or $_.serverStatus -eq "unknown" }
  if (-not $pending) { break }
  Start-Sleep 15
}
# serverStatus is written by Category B's probe-and-persist phase, and Phase 3
# RETURNS EARLY when no preferred agent is installed:
#
#   if (!preferredAgent || !getAgentConfig(preferredAgent)?.installed) return;
#
# So on a fresh install with nobody signed in, every MCP is legitimately
# "unknown" on every platform — probing has not run and is not meant to have.
# Treating that as a failure made a correct install look broken for an entire
# QA session. The probe check is therefore GATED on an agent being configured,
# which is a deliberate manual step (signing into Claude), not something this
# script can arrange.
$agentReady = $false
try {
  $settings = (Invoke-WebRequest "http://127.0.0.1:$Port/api/settings" -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
  $agentReady = [bool]$settings.settings.preferredAgent
} catch { }

$up   = @($probed | Where-Object { $_.serverStatus -eq "up" })
$down = @($probed | Where-Object { $_.serverStatus -ne "up" })
$mcpSummary = "$($up.Count) up / $($probed.Count) probed"
Say "4. MCP servers: $mcpSummary"
# serverStatus is written by Category B's probe-and-persist phase, so an
# all-unknown result is a question about Category B, not about the MCPs.
$cb = Select-String -Path $log -Pattern '"phase":"category-b"' -ErrorAction SilentlyContinue
Say "   category-b log lines: $($cb.Count)"
if ($cb) { Say "   last: $($cb[-1].Line.Substring(0, [Math]::Min(200, $cb[-1].Line.Length)))" }
# prewarmMcp skips any MCP whose deps have not settled to "installed", so an
# unprobed MCP is usually a dependency question rather than a server one.
foreach ($srv in $probed) {
  try {
    $deps = (Invoke-WebRequest "http://127.0.0.1:$Port/api/settings/mcp-servers/$($srv.id)/dependencies" `
               -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
    # runtimeStatus, not status -- the route returns installed/path/source/
    # runtimeStatus, and reading a field that does not exist renders as an
    # empty string rather than an error, which looked like "no data" for
    # every dep on the first run.
    $states = ($deps.dependencies | ForEach-Object { "$($_.binary)=$($_.runtimeStatus)" }) -join " "
    Say "   deps $($srv.id): $states"
  } catch { Say "   deps $($srv.id): unavailable" }
}
foreach ($d in $down) { Say "   DOWN $($d.id): $($d.serverStatus) $($d.serverError)" }
if ($down.Count -gt 0) {
  if ($agentReady) {
    $failures += "mcp:$($down.Count)-down"
  } else {
    Say "   NOT A FAILURE: no preferredAgent is set, so Category B returns"
    Say "   before probe-persist. Sign in to an agent and re-run to test this."
  }
}

# --- 5. the ffmpeg libi downloaded can render drawtext -------------------
$ff = "$libiHome\bin\ffmpeg.exe"
if (-not (Test-Path $ff)) {
  Say "5. ffmpeg MISSING at $ff"
  $failures += "ffmpeg:missing"
} else {
  $png = "$root\drawtext.png"
  Remove-Item $png -Force -ErrorAction SilentlyContinue
  # Rendering, not just listing. The Linux build advertised
  # --enable-libfreetype in its configuration string while lacking the filter
  # entirely, so presence in -filters is necessary and not sufficient.
  # ffmpeg prints its version banner to stderr even on success -- see
  # Invoke-Noisy. Judged by whether the PNG appeared.
  Invoke-Noisy { & $ff -y -f lavfi -i color=c=black:s=320x120:d=1 `
    -vf "drawtext=text=OK:fontsize=32:fontcolor=white" -frames:v 1 $png }
  if (Test-Path $png) {
    Say "5. drawtext renders ($((Get-Item $png).Length) bytes)"
  } else {
    Say "5. drawtext DOES NOT RENDER -- Windows has the Linux F5 defect"
    $failures += "ffmpeg:no-drawtext"
  }
}

# --- 6. terminal spawns and streams (ConPTY) -----------------------------
# Driven from node, not PowerShell: the transport is a WebSocket, and the ws
# module is already sitting in the package's own node_modules.
$pkgDir = Find-LibiFile 'registry\bundled.js'
if ($pkgDir) {
  $nodeModules = $pkgDir.FullName -replace '\\node_modules\\@nagellabs\\.*$', '\node_modules'
  $driver = "$root\term-check.js"
  @"
const http = require('http');
const WebSocket = require('ws');
const PORT = $Port;
const j = (p, m, b) => new Promise((res, rej) => {
  const data = b ? JSON.stringify(b) : null;
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (r) => { let s = ''; r.on('data', c => s += c); r.on('end', () => res({ code: r.statusCode, body: s })); });
  req.on('error', rej);
  if (data) req.write(data);
  req.end();
});
(async () => {
  const made = await j('/api/terminal/sessions', 'POST', {});
  if (made.code !== 201) { console.log('TERM FAIL create ' + made.code + ' ' + made.body.slice(0, 200)); process.exit(0); }
  const id = JSON.parse(made.body).id;
  const info = await j('/api/terminal/ws-info', 'GET');
  const wsPort = JSON.parse(info.body).port;
  const ws = new WebSocket('ws://127.0.0.1:' + wsPort + '/?session=' + id);
  let got = '';
  const done = (verdict) => { try { ws.close(); } catch (e) {} console.log(verdict); process.exit(0); };
  const timer = setTimeout(() => done('TERM FAIL no output in 30s'), 30000);
  ws.on('error', (e) => { clearTimeout(timer); done('TERM FAIL ws ' + e.message); });
  ws.on('message', (m) => {
    got += m.toString();
    // A live ConPTY prints a prompt unprompted. Anything at all off the pty is
    // the proof; the prompt text itself is not worth asserting.
    if (got.length > 0) { clearTimeout(timer); done('TERM OK ' + JSON.stringify(got.slice(0, 60))); }
  });
})().catch(e => console.log('TERM FAIL ' + e.message));
"@ | Set-Content $driver -Encoding ASCII
  $env:NODE_PATH = $nodeModules
  $termResult = & node $driver 2>&1 | Select-Object -Last 1
  Say "6. terminal: $termResult"
  if ("$termResult" -notmatch '^TERM OK') { $failures += "terminal" }
} else {
  Say "6. terminal: SKIPPED (package dir not found)"
  $failures += "terminal:skipped"
}

# --- log level check + verdict -------------------------------------------
$done_  = Select-String -Path $log -Pattern "Category A complete" -ErrorAction SilentlyContinue | Select-Object -Last 1
$errs = (Select-String -Path $log -Pattern '"level":(50|60)' -ErrorAction SilentlyContinue | Measure-Object).Count
Say "category A: $($done_.Line)"
Say "log entries at level>=50: $errs"
if ($errs -ne 0) {
  $failures += "log:$errs-errors"
  Select-String -Path $log -Pattern '"level":(50|60)' -ErrorAction SilentlyContinue |
    Select-Object -Last 3 | ForEach-Object { Say "   $($_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)))" }
}

# `if` is a statement, not an expression, in PowerShell 5.1 -- which is what
# these images ship. Keep this as a plain branch.
if ($failures.Count -eq 0) {
  # Name what was actually tested. This script runs against both a published
  # npx install and a packaged Electron build, and a verdict that says "npx"
  # after an Electron run is the kind of line that gets quoted later as proof
  # of something it never checked.
  $what = if ($Root -eq "electron") { "the PACKAGED app" } else { "the npx install" }
  Say "VERDICT: PASS for $what (tier 1 -- SmartScreen, installer UX and the"
  Say "         on-screen look still need eyes; agent round-trip needs a sign-in)"
} else {
  Say "VERDICT: INVESTIGATE -- $($failures -join ', ')"
}
