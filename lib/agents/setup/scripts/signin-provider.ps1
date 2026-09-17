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
#   provider  higgsfield
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#   entry     the name the provider's MCP server has in the agent's config
#
# What it does:
#   Runs the agent's own `mcp login`, which opens your browser to sign in with
#   your account there and waits until you finish. The agent keeps the
#   sign-in; libi never sees it. There is no key, and nothing else changes.
#
# The entry's name goes after `--`, so a name that starts with `-` is never
# read as an option.

param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry)

# Provider details. A libi test keeps this table the same as the providers in
# libi's provider catalog (lib/providers/catalog.ts) that you sign in to with
# an account.
switch -CaseSensitive ($Provider) {
  'higgsfield' { $name = 'Higgsfield' }
  default      { [Console]::Error.WriteLine("signin-provider.ps1: unknown provider '$Provider'"); exit 2 }
}
if ($Agent -cne 'claude' -and $Agent -cne 'codex') {
  [Console]::Error.WriteLine("signin-provider.ps1: unknown agent '$Agent'")
  exit 2
}
if (-not $Cli -or -not $Entry) {
  [Console]::Error.WriteLine('usage: signin-provider.ps1 <provider> <agent> <cli> <entry>')
  exit 2
}

# The agent's own sign-in. The script exits with its exit code.
Write-Host "Opening your browser to sign in with your $name account. This waits here until you finish."
$loginArgs = @('mcp', 'login', '--', $Entry)
& $Cli @loginArgs
if ($?) { exit 0 }
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 1
