# add-provider.ps1: adds a provider's MCP server to Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there. The call runs this file's text in
# a new PowerShell process:
#
#   powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('<folder>\add-provider.ps1'))) '<provider>' '<agent>' '<cli>'"
#
# It runs the text, not the file, because an execution policy set by Group
# Policy can refuse script files. In its own process, the script's `exit`
# never closes your terminal.
#
#   provider  fal, higgsfield, zernio, elevenlabs or playwright
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#   -CliScript  optional, Windows npm installs: the JS file the agent's `.cmd`
#             shim runs. libi passes it with the node the shim would use as
#             `cli`, so the agent runs without cmd.exe, whose Ctrl+C would stop
#             at "Terminate batch job (Y/N)?". Without it, `cli` runs as is.
#
# What it does:
#   1. fal.ai: asks for your provider key without showing it as you type.
#      Higgsfield, Zernio and ElevenLabs have no key: you sign in with your
#      account for that provider in your browser instead. Playwright needs
#      neither: it runs on your computer with npx (Node.js).
#   2. Codex with fal.ai only: saves the key as FAL_KEY in your Windows user
#      environment, because Codex reads that key from its environment when it
#      starts.
#   3. Runs the agent's own `mcp add`, which writes the agent's config. For a
#      provider you sign in to, your browser then opens to sign in and this
#      waits until you finish: Codex's add does that itself, and for Claude
#      Code this runs Claude Code's own `mcp login` once the add worked.
#
# The key is never printed, and it exists only inside this script's process.

param([string]$Provider, [string]$Agent, [string]$Cli, [string]$CliScript)

# Provider details. A libi test keeps this table, and the `mcp add` commands
# below, the same as libi's provider catalog (lib/providers/catalog.ts).
# auth is 'key' for a provider key, 'oauth' for signing in with your account.
switch -CaseSensitive ($Provider) {
  'fal'        { $name = 'fal.ai'; $auth = 'key'; $codexKeyEnv = 'FAL_KEY' }
  'higgsfield' { $name = 'Higgsfield'; $auth = 'oauth'; $codexKeyEnv = '' }
  'zernio'     { $name = 'Zernio'; $auth = 'oauth'; $codexKeyEnv = '' }
  'elevenlabs' { $name = 'ElevenLabs'; $auth = 'oauth'; $codexKeyEnv = '' }
  'playwright' { $name = 'Playwright'; $auth = 'none'; $codexKeyEnv = '' }
  default      { [Console]::Error.WriteLine("add-provider.ps1: unknown provider '$Provider'"); exit 2 }
}
if ($Agent -cne 'claude' -and $Agent -cne 'codex') {
  [Console]::Error.WriteLine("add-provider.ps1: unknown agent '$Agent'")
  exit 2
}
if (-not $Cli) {
  [Console]::Error.WriteLine('usage: add-provider.ps1 <provider> <agent> <cli> [-CliScript <script>]')
  exit 2
}

# The agent's command: `cli`, or node running the agent's own script (-CliScript).
$cliPre = @()
if ($CliScript) { $cliPre = @($CliScript) }

# The key, read as a SecureString so typing is hidden. A provider you sign in
# to with your account has no key, so nothing is asked for.
if ($auth -ceq 'key') {
  $key = [Net.NetworkCredential]::new('', (Read-Host "$name key" -AsSecureString)).Password
}

# Codex with a provider whose key it reads from its environment: save the key
# for your Windows user first. With no key entered, nothing is saved or added.
if ($Agent -ceq 'codex' -and $codexKeyEnv) {
  if (-not $key) {
    Write-Host 'Nothing saved: no key entered.'
    exit 1
  }
  [Environment]::SetEnvironmentVariable($codexKeyEnv, $key, 'User')
  Write-Host "Saved $codexKeyEnv for your Windows user. Restart libi and Codex so they read it."
}

# The agent's own add command for each provider, with the key where it goes.
switch -CaseSensitive ("$Provider/$Agent") {
  'fal/claude'        { $addArgs = @('mcp', 'add', '--scope', 'user', '--transport', 'http', 'fal-ai', 'https://mcp.fal.ai/mcp', '--header', "Authorization: Bearer $key") }
  'fal/codex'         { $addArgs = @('mcp', 'add', 'fal-ai', '--url', 'https://mcp.fal.ai/mcp', '--bearer-token-env-var', 'FAL_KEY') }
  'higgsfield/claude' { $addArgs = @('mcp', 'add', '--transport', 'http', '--scope', 'user', 'higgsfield', 'https://mcp.higgsfield.ai/mcp') }
  'higgsfield/codex'  { $addArgs = @('mcp', 'add', 'higgsfield', '--url', 'https://mcp.higgsfield.ai/mcp') }
  'zernio/claude'     { $addArgs = @('mcp', 'add', '--transport', 'http', '--scope', 'user', 'zernio', 'https://mcp.zernio.com/mcp') }
  'zernio/codex'      { $addArgs = @('mcp', 'add', 'zernio', '--url', 'https://mcp.zernio.com/mcp') }
  'elevenlabs/claude' { $addArgs = @('mcp', 'add', '--transport', 'http', '--scope', 'user', 'elevenlabs', 'https://api.us.elevenlabs.io/v1/mcp') }
  'elevenlabs/codex'  { $addArgs = @('mcp', 'add', 'elevenlabs', '--url', 'https://api.us.elevenlabs.io/v1/mcp') }
  # Claude Code on Windows cannot start npx directly; its docs wrap a local server in `cmd /c`.
  'playwright/claude' { $addArgs = @('mcp', 'add', '--scope', 'user', 'playwright', '--', 'cmd', '/c', 'npx', '@playwright/mcp@latest') }
  'playwright/codex'  { $addArgs = @('mcp', 'add', 'playwright', '--', 'npx', '@playwright/mcp@latest') }
}
# Codex's add starts the browser sign-in itself. Claude Code's add finishes
# before any sign-in, so its own `mcp login` follows, only when the add worked.
# The entry the add creates is named after the provider, as in the catalog.
# For Claude Code, the two [libi sign-in ...] lines tell libi when the sign-in
# starts and when it has ended, however it ended (Ctrl+C included): libi must
# not ask Claude Code about the entry in between, or Claude Code may skip it
# for 15 minutes.
$signsIn = $auth -ceq 'oauth' -and $Agent -ceq 'claude'
if ($auth -ceq 'oauth' -and $Agent -ceq 'codex') {
  Write-Host "Codex adds $name, then opens your browser to sign in with your $name account. This waits here until you finish signing in."
}
if ($signsIn) {
  Write-Host "Claude Code adds $name, then opens your browser to sign in with your $name account. This waits here until you finish signing in."
  Write-Host "[libi sign-in start: $Provider]"
}
$code = 0
try {
  & $Cli @cliPre @addArgs
  if (-not $?) {
    $code = 1
    if ($LASTEXITCODE) { $code = $LASTEXITCODE }
  } elseif ($signsIn) {
    $loginArgs = @('mcp', 'login', '--', $Provider)
    & $Cli @cliPre @loginArgs
    if (-not $?) {
      $code = 1
      if ($LASTEXITCODE) { $code = $LASTEXITCODE }
    }
  }
} finally {
  # [Console], not Write-Host: after Ctrl+C the pipeline is stopping, and Write-Host can throw and print nothing.
  if ($signsIn) { [Console]::WriteLine("[libi sign-in end: $Provider]") }
}
exit $code
