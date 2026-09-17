# remove-provider.ps1: removes a provider's MCP server from Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there. The call runs this file's text in
# a new PowerShell process:
#
#   powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('<folder>\remove-provider.ps1'))) '<provider>' '<agent>' '<cli>' '<entry>' ['<scope>']"
#
# It runs the text, not the file, because an execution policy set by Group
# Policy can refuse script files. In its own process, the script's `exit`
# never closes your terminal.
#
#   provider  fal, higgsfield or elevenlabs
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#   entry     the name the provider's MCP server has in the agent's config
#   scope     Claude Code only: the settings scope the entry is in
#             (user, local or project)
#
# What it does:
#   1. Higgsfield, which you sign in to with your account: runs the agent's own
#      `mcp logout`, which clears the sign-in the agent stored for the entry.
#      It runs before the remove because both agents look that sign-in up
#      through the entry: once the entry is gone they answer "No MCP server
#      named ..." and clear nothing. With no sign-in stored it changes
#      nothing, and a sign-out that fails never stops step 2. If step 2 then
#      fails, the entry stays, signed out, and Sign in signs it in again.
#   2. Runs the agent's own `mcp remove`, which deletes the entry, and any key
#      saved in it, from the agent's config.
#   3. Codex with fal.ai only, and only when step 2 worked: clears FAL_KEY from
#      your Windows user environment, when it is set there.
#
# The entry's name goes after `--`, so a name that starts with `-` is never
# read as an option.

param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry, [string]$Scope)

# Provider details. A libi test keeps this table the same as libi's provider
# catalog (lib/providers/catalog.ts).
# auth is 'key' for a provider key, 'oauth' for signing in with your account.
switch -CaseSensitive ($Provider) {
  'fal'        { $name = 'fal.ai'; $auth = 'key'; $codexKeyEnv = 'FAL_KEY' }
  'higgsfield' { $name = 'Higgsfield'; $auth = 'oauth'; $codexKeyEnv = '' }
  'elevenlabs' { $name = 'ElevenLabs'; $auth = 'key'; $codexKeyEnv = '' }
  default      { [Console]::Error.WriteLine("remove-provider.ps1: unknown provider '$Provider'"); exit 2 }
}
switch -CaseSensitive ($Agent) {
  'claude' { $removeArgs = @('mcp', 'remove', '--scope', $Scope, '--', $Entry) }
  'codex'  { $removeArgs = @('mcp', 'remove', '--', $Entry) }
  default  { [Console]::Error.WriteLine("remove-provider.ps1: unknown agent '$Agent'"); exit 2 }
}
if (-not $Cli -or -not $Entry -or ($Agent -ceq 'claude' -and -not $Scope)) {
  [Console]::Error.WriteLine('usage: remove-provider.ps1 <provider> <agent> <cli> <entry> [<scope>]')
  exit 2
}
if ($Scope -and $Scope -cnotin @('user', 'local', 'project')) {
  [Console]::Error.WriteLine("remove-provider.ps1: unknown scope '$Scope' (user, local or project)")
  exit 2
}

# 1. A provider you sign in to with your account: sign out first, while the
#    agent can still find the sign-in through the entry. Nothing stored is not
#    a failure, and a sign-out that fails still goes on to the remove.
if ($auth -ceq 'oauth') {
  Write-Host "Signing out of $name first, so the sign-in isn't left stored."
  $logoutArgs = @('mcp', 'logout', '--', $Entry)
  & $Cli @logoutArgs
  if (-not $?) { Write-Host "Couldn't sign out of $name; removing it anyway." }
}

# 2. The agent's own remove. When it fails, stop with its exit code and touch
#    nothing else. $LASTEXITCODE is reset first: after a failed sign-out it
#    still holds the sign-out's code, and a remove that cannot start at all
#    (its CLI is gone) never sets it, so that remove would exit with the
#    sign-out's code instead of 1.
$global:LASTEXITCODE = 0
& $Cli @removeArgs
if (-not $?) {
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  exit 1
}

# 3. Only Codex keeps a provider key outside its config.
if ($Agent -ceq 'codex' -and $codexKeyEnv -and $null -ne [Environment]::GetEnvironmentVariable($codexKeyEnv, 'User')) {
  [Environment]::SetEnvironmentVariable($codexKeyEnv, $null, 'User')
  Write-Host "Removed $codexKeyEnv from your Windows user environment. Restart libi and Codex so they stop using it."
}
exit 0
