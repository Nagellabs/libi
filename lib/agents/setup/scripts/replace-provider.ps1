# replace-provider.ps1: replaces a provider entry, such as one whose key is
# missing, in Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there. The call runs this file's text in
# a new PowerShell process, and names the folder add-provider.ps1 is in:
#
#   powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('<folder>\replace-provider.ps1'))) '<provider>' '<agent>' '<cli>' '<entry>' ['<scope>'] -ScriptsDir '<folder>'"
#
# It runs the text, not the file, because an execution policy set by Group
# Policy can refuse script files. In its own process, the script's `exit`
# never closes your terminal.
#
#   provider    fal, higgsfield or elevenlabs
#   agent       claude or codex
#   cli         the full path of that agent's command-line tool
#   entry       the name the provider's MCP server has in the agent's config now
#   scope       Claude Code only: the settings scope that entry is in
#               (user, local or project)
#   ScriptsDir  the folder add-provider.ps1 is in. Text run this way has no
#               folder of its own. Run as a file, this script's own folder is
#               used when ScriptsDir is left out.
#
# What it does:
#   1. Runs the agent's own `mcp remove` for the entry you have now.
#   2. Only when that worked, runs add-provider.ps1's text from that folder the
#      same way, which adds the provider again: it asks for your key, or for
#      Higgsfield, starts the sign-in with your Higgsfield account.
#
# A FAL_KEY libi saved for Codex is left alone in step 1, because step 2
# replaces it. The entry's name goes after `--`, so a name that starts with `-`
# is never read as an option.

param([string]$Provider, [string]$Agent, [string]$Cli, [string]$Entry, [string]$Scope, [string]$ScriptsDir)

# Checked before anything is removed, so an add that could not run never
# follows a remove. A libi test keeps this list the same as the providers
# add-provider.ps1 knows.
if ($Provider -cnotin @('fal', 'higgsfield', 'elevenlabs')) {
  [Console]::Error.WriteLine("replace-provider.ps1: unknown provider '$Provider'")
  exit 2
}
switch -CaseSensitive ($Agent) {
  'claude' { $removeArgs = @('mcp', 'remove', '--scope', $Scope, '--', $Entry) }
  'codex'  { $removeArgs = @('mcp', 'remove', '--', $Entry) }
  default  { [Console]::Error.WriteLine("replace-provider.ps1: unknown agent '$Agent'"); exit 2 }
}
if (-not $Cli -or -not $Entry -or ($Agent -ceq 'claude' -and -not $Scope)) {
  [Console]::Error.WriteLine('usage: replace-provider.ps1 <provider> <agent> <cli> <entry> [<scope>] [-ScriptsDir <folder>]')
  exit 2
}
if ($Scope -and $Scope -cnotin @('user', 'local', 'project')) {
  [Console]::Error.WriteLine("replace-provider.ps1: unknown scope '$Scope' (user, local or project)")
  exit 2
}
if (-not $ScriptsDir) { $ScriptsDir = $PSScriptRoot }
$addScript = if ($ScriptsDir) { [IO.Path]::Combine($ScriptsDir, 'add-provider.ps1') } else { '' }
if (-not $addScript -or -not (Test-Path -LiteralPath $addScript -PathType Leaf)) {
  [Console]::Error.WriteLine('replace-provider.ps1: add-provider.ps1 not found; pass the folder it is in as -ScriptsDir')
  exit 2
}

# 1. The agent's own remove. When it fails, stop with its exit code.
& $Cli @removeArgs
if (-not $?) {
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  exit 1
}

# 2. The add, run from its text like this script. Its `exit` ends this script
#    too, with the add's own code. An error that stops it instead is a failure.
try {
  & ([scriptblock]::Create([IO.File]::ReadAllText($addScript))) $Provider $Agent $Cli
} catch {
  [Console]::Error.WriteLine("replace-provider.ps1: add-provider.ps1 stopped: $($_.Exception.Message)")
  exit 1
}
# add-provider.ps1 always ends with `exit`, so reaching this point is never
# success.
exit 1
