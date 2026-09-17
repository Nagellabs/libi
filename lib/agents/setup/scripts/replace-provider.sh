#!/bin/sh
# replace-provider.sh: replaces a provider entry, such as one whose key is
# missing, in Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there.
#
#   sh replace-provider.sh <provider> <agent> <cli> <entry> [<scope>]
#
#   provider  fal, higgsfield or elevenlabs
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#   entry     the name the provider's MCP server has in the agent's config now
#   scope     Claude Code only: the settings scope that entry is in
#             (user, local or project)
#
# What it does:
#   1. Runs the agent's own `mcp remove` for the entry you have now.
#   2. Only when that worked, runs add-provider.sh from this same folder, which
#      adds the provider again: it asks for your key, or for Higgsfield, starts
#      the sign-in with your Higgsfield account.
#
# A FAL_KEY line libi saved for Codex is left alone in step 1, because step 2
# replaces it. The entry's name goes after `--`, so a name that starts with `-`
# is never read as an option.

provider=$1
agent=$2
cli=$3
entry=$4
scope=$5

# Checked before anything is removed, so an add that could not run never
# follows a remove. A libi test keeps this list the same as the providers
# add-provider.sh knows.
case $provider in
  fal | higgsfield | elevenlabs) ;;
  *) echo "replace-provider.sh: unknown provider '$provider'" >&2; exit 2 ;;
esac
case $agent in
  claude | codex) ;;
  *) echo "replace-provider.sh: unknown agent '$agent'" >&2; exit 2 ;;
esac
if [ -z "$cli" ] || [ -z "$entry" ] || { [ "$agent" = claude ] && [ -z "$scope" ]; }; then
  echo 'usage: sh replace-provider.sh <provider> <agent> <cli> <entry> [<scope>]' >&2
  exit 2
fi
case $scope in
  '' | user | local | project) ;;
  *) echo "replace-provider.sh: unknown scope '$scope' (user, local or project)" >&2; exit 2 ;;
esac

# An empty ZDOTDIR from libi means your shell had none, so the agent's CLI gets
# none either.
[ -n "${ZDOTDIR-}" ] || unset ZDOTDIR

# 1. The agent's own remove. When it fails, stop with its exit code.
if [ "$agent" = claude ]; then
  "$cli" mcp remove --scope "$scope" -- "$entry" || exit
else
  "$cli" mcp remove -- "$entry" || exit
fi

# 2. The add, from the folder this script is in.
exec sh "${0%/*}/add-provider.sh" "$provider" "$agent" "$cli"
