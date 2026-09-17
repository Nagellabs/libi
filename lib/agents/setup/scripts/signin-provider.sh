#!/bin/sh
# signin-provider.sh: signs Claude Code or Codex in to a provider you sign in
# to with your own account, such as Higgsfield.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there.
#
#   sh signin-provider.sh <provider> <agent> <cli> <entry>
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

provider=$1
agent=$2
cli=$3
entry=$4

# Provider details. A libi test keeps this table the same as the providers in
# libi's provider catalog (lib/providers/catalog.ts) that you sign in to with
# an account.
case $provider in
  higgsfield) name='Higgsfield' ;;
  *) echo "signin-provider.sh: unknown provider '$provider'" >&2; exit 2 ;;
esac
case $agent in
  claude | codex) ;;
  *) echo "signin-provider.sh: unknown agent '$agent'" >&2; exit 2 ;;
esac
if [ -z "$cli" ] || [ -z "$entry" ]; then
  echo 'usage: sh signin-provider.sh <provider> <agent> <cli> <entry>' >&2
  exit 2
fi

# An empty ZDOTDIR from libi means your shell had none, so the agent's CLI gets
# none either.
[ -n "${ZDOTDIR-}" ] || unset ZDOTDIR

# The agent's own sign-in. The script exits with its exit code.
echo "Opening your browser to sign in with your $name account. This waits here until you finish."
"$cli" mcp login -- "$entry"
