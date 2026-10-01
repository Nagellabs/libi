# signin-provider.ps1: signs Claude Code or Codex in to a provider you sign in
# to with your own account, such as Higgsfield.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there. The call runs this file's text in
# a new PowerShell process:
#
#   powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('<folder>\signin-provider.ps1'))) '<provider>' '<agent>' '<cli>' '<entry>'"
#
# It runs the text, not the file, because an execution policy set by Group
# Policy can refuse script files. In its own process, the script's `exit`
# never closes your terminal.
#
#   provider  higgsfield, zernio or elevenlabs
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#   -CliScript  optional, Windows npm installs: the JS file the agent's `.cmd`
#             shim runs. libi passes it with the node the shim would use as
#             `cli`, so the agent runs without cmd.exe, whose Ctrl+C would stop
#             at "Terminate batch job (Y/N)?". Without it, `cli` runs as is.
#   entry     the name the provider's MCP server has in the agent's config
#
# What it does:
#   Runs the agent's own `mcp login`, which opens your browser to sign in with
#   your account there and waits until you finish. The agent keeps the
#   sign-in; libi never sees it. There is no key, and nothing else changes.
#
# The entry's name goes after `--`, so a name that starts with `-` is never
# read as an option.

param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry, [string]$CliScript)

# Provider details. A libi test keeps this table the same as the providers in
# libi's provider catalog (lib/providers/catalog.ts) that you sign in to with
# an account.
switch -CaseSensitive ($Provider) {
  'higgsfield' { $name = 'Higgsfield' }
  'zernio'     { $name = 'Zernio' }
  'elevenlabs' { $name = 'ElevenLabs' }
  default      { [Console]::Error.WriteLine("signin-provider.ps1: unknown provider '$Provider'"); exit 2 }
}
if ($Agent -cne 'claude' -and $Agent -cne 'codex') {
  [Console]::Error.WriteLine("signin-provider.ps1: unknown agent '$Agent'")
  exit 2
}
if (-not $Cli -or -not $Entry) {
  [Console]::Error.WriteLine('usage: signin-provider.ps1 <provider> <agent> <cli> <entry> [-CliScript <script>]')
  exit 2
}

# The agent's command: `cli`, or node running the agent's own script (-CliScript).
$cliPre = @()
if ($CliScript) { $cliPre = @($CliScript) }

# The agent's own sign-in. The script exits with its exit code. For Claude
# Code, the two [libi sign-in ...] lines tell libi when the sign-in starts and
# when it has ended, however it ended (Ctrl+C included): libi must not ask
# Claude Code about the entry in between, or Claude Code may skip it for 15
# minutes.
Write-Host "Opening your browser to sign in with your $name account. This waits here until you finish."
$marked = $Agent -ceq 'claude'
if ($marked) { Write-Host "[libi sign-in start: $Entry]" }
$code = 0
try {
  $loginArgs = @('mcp', 'login', '--', $Entry)
  & $Cli @cliPre @loginArgs
  if (-not $?) {
    $code = 1
    if ($LASTEXITCODE) { $code = $LASTEXITCODE }
  }
} finally {
  # [Console], not Write-Host: after Ctrl+C the pipeline is stopping, and Write-Host can throw and print nothing.
  if ($marked) { [Console]::WriteLine("[libi sign-in end: $Entry]") }
}
exit $code
