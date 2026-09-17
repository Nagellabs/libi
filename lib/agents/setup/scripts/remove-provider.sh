#!/bin/sh
# remove-provider.sh: removes a provider's MCP server from Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there.
#
#   sh remove-provider.sh <provider> <agent> <cli> <entry> [<scope>]
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
#   3. Codex with fal.ai only, and only when step 2 worked: deletes the FAL_KEY
#      line libi saved from every login shell profile that has one. Nothing
#      else in them changes.
#
# The entry's name goes after `--`, so a name that starts with `-` is never
# read as an option.
#
# For Codex, libi passes ZDOTDIR from your shell, so a zsh config folder you
# set without `export` is still checked.

provider=$1
agent=$2
cli=$3
entry=$4
scope=$5

# Provider details. A libi test keeps this table the same as libi's provider
# catalog (lib/providers/catalog.ts).
# auth is `key` for a provider key, `oauth` for signing in with your account.
case $provider in
  fal)        name='fal.ai';     auth='key';   codex_key_env='FAL_KEY' ;;
  higgsfield) name='Higgsfield'; auth='oauth'; codex_key_env='' ;;
  elevenlabs) name='ElevenLabs'; auth='key';   codex_key_env='' ;;
  *) echo "remove-provider.sh: unknown provider '$provider'" >&2; exit 2 ;;
esac
case $agent in
  claude | codex) ;;
  *) echo "remove-provider.sh: unknown agent '$agent'" >&2; exit 2 ;;
esac
if [ -z "$cli" ] || [ -z "$entry" ] || { [ "$agent" = claude ] && [ -z "$scope" ]; }; then
  echo 'usage: sh remove-provider.sh <provider> <agent> <cli> <entry> [<scope>]' >&2
  exit 2
fi
case $scope in
  '' | user | local | project) ;;
  *) echo "remove-provider.sh: unknown scope '$scope' (user, local or project)" >&2; exit 2 ;;
esac

# An empty ZDOTDIR from libi means your shell had none, so the agent's CLI gets
# none either.
[ -n "${ZDOTDIR-}" ] || unset ZDOTDIR

# ---- same in add-provider.sh and remove-provider.sh: begin ----
# Deletes libi's saved-key line, the line ending with $marker, from one profile.
# The profile is filtered into a private copy beside it and written back
# through its own path, so a symlinked profile stays a link. Every other byte
# stays as it was, Windows (CRLF) line endings included.
#   returns 0  the line was there and is gone
#           1  there was no such line, and the file was not touched
#           2  the file couldn't be read or written, which is said on stderr
# Tools run as `LC_ALL=C command <tool>`: byte by byte, so a profile holding
# bytes that aren't valid UTF-8 is still read, and never as an alias or shell
# function of the same name.
drop_saved_key_line() {
  profile=$1
  tmp=$profile.libi-tmp
  LC_ALL=C command grep -q "$marker$cr\{0,1\}\$" "$profile" 2>/dev/null
  case $? in
    0) ;;
    1) return 1 ;;
    *)
      [ -e "$profile" ] || return 1
      echo "Couldn't read $profile; it may still hold a $codex_key_env line from libi." >&2
      return 2 ;;
  esac
  command rm -f "$tmp"
  if ! LC_ALL=C command sed "/$marker$cr\{0,1\}\$/d" "$profile" >| "$tmp"; then
    command rm -f "$tmp"
    echo "Could not write $profile." >&2
    return 2
  fi
  if ! command cat "$tmp" >| "$profile"; then
    echo "Could not write $profile. The complete edited copy is in $tmp." >&2
    return 2
  fi
  command rm -f "$tmp"
  return 0
}
# ---- same in add-provider.sh and remove-provider.sh: end ----

# 1. A provider you sign in to with your account: sign out first, while the
#    agent can still find the sign-in through the entry. Nothing stored is not
#    a failure, and a sign-out that fails still goes on to the remove.
if [ "$auth" = oauth ]; then
  echo "Signing out of $name first, so the sign-in isn't left stored."
  "$cli" mcp logout -- "$entry" || echo "Couldn't sign out of $name; removing it anyway."
fi

# 2. The agent's own remove. When it fails, stop with its exit code and touch
#    nothing else.
if [ "$agent" = claude ]; then
  "$cli" mcp remove --scope "$scope" -- "$entry" || exit
else
  "$cli" mcp remove -- "$entry" || exit
fi

# 3. Only Codex keeps a provider key outside its config.
if [ "$agent" != codex ] || [ -z "$codex_key_env" ]; then
  exit 0
fi

# Files made from here on are private to you: the working copy of a profile
# holds that profile's other lines, which may include secrets.
umask 077
marker="# $name key for Codex, added by libi"
# A profile saved with Windows (CRLF) line endings ends libi's line with a
# carriage return.
cr=$(printf '\r')

# Every login profile a shell may read, not only the one yours reads now: that
# may have changed since the key was saved. ZDOTDIR's .zprofile comes first;
# when ZDOTDIR is your home folder that is the same file, checked once.
found=''
failed=''
set -- "${ZDOTDIR:-$HOME}/.zprofile" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"
[ "$1" = "$2" ] && shift
for candidate in "$@"; do
  drop_saved_key_line "$candidate"
  case $? in
    0) echo "Removed $codex_key_env from $candidate. Restart libi and Codex so they stop using it."; found=1 ;;
    2) failed=1 ;;
  esac
done
# A profile that couldn't be checked is never reported as "no line found".
[ -z "$failed" ] || exit 1
[ -n "$found" ] || echo "No $codex_key_env line from libi was found."
