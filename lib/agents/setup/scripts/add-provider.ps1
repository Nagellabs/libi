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
#   provider  fal, higgsfield or elevenlabs
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#
# What it does:
#   1. fal.ai and ElevenLabs: asks for your provider key without showing it as
#      you type. Higgsfield has no key: you sign in with your Higgsfield
#      account in your browser instead.
#   2. Codex with fal.ai only: saves the key as FAL_KEY in your Windows user
#      environment, because Codex reads that key from its environment when it
#      starts.
#   3. Runs the agent's own `mcp add`, which writes the agent's config. For
#      Higgsfield, Codex then opens your browser to sign in and waits until
#      you finish; for Claude Code, it says how to sign in afterwards.
#
# The key is never printed, and it exists only inside this script's process.

param([string]$Provider, [string]$Agent, [string]$Cli)

# Provider details. A libi test keeps this table, and the `mcp add` commands
# below, the same as libi's provider catalog (lib/providers/catalog.ts).
# auth is 'key' for a provider key, 'oauth' for signing in with your account.
switch -CaseSensitive ($Provider) {
  'fal'        { $name = 'fal.ai'; $auth = 'key'; $codexKeyEnv = 'FAL_KEY' }
  'higgsfield' { $name = 'Higgsfield'; $auth = 'oauth'; $codexKeyEnv = '' }
  'elevenlabs' { $name = 'ElevenLabs'; $auth = 'key'; $codexKeyEnv = '' }
  default      { [Console]::Error.WriteLine("add-provider.ps1: unknown provider '$Provider'"); exit 2 }
}
if ($Agent -cne 'claude' -and $Agent -cne 'codex') {
  [Console]::Error.WriteLine("add-provider.ps1: unknown agent '$Agent'")
  exit 2
}
if (-not $Cli) {
  [Console]::Error.WriteLine('usage: add-provider.ps1 <provider> <agent> <cli>')
  exit 2
}

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
  'elevenlabs/claude' { $addArgs = @('mcp', 'add', '--scope', 'user', 'elevenlabs', '-e', "ELEVENLABS_API_KEY=$key", '--', 'uvx', 'elevenlabs-mcp') }
  'elevenlabs/codex'  { $addArgs = @('mcp', 'add', 'elevenlabs', '--env', "ELEVENLABS_API_KEY=$key", '--', 'uvx', 'elevenlabs-mcp') }
}
# Codex's add starts the browser sign-in itself; Claude Code signs in afterwards.
if ($auth -ceq 'oauth' -and $Agent -ceq 'codex') {
  Write-Host "Codex adds $name, then opens your browser to sign in with your $name account. This waits here until you finish signing in."
}
& $Cli @addArgs
if ($?) {
  if ($auth -ceq 'oauth' -and $Agent -ceq 'claude') {
    Write-Host "Added. Now sign in with your $name account: click Sign in on libi's Providers tab, or open Claude Code, run /mcp, choose $Provider, then Authenticate."
  }
  exit 0
}
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 1
