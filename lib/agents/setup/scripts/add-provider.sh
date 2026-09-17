#!/bin/sh
# add-provider.sh: adds a provider's MCP server to Claude Code or Codex.
#
# libi's Providers tab types a call to this script into its setup terminal.
# Nothing runs until you press Enter there.
#
#   sh add-provider.sh <provider> <agent> <cli>
#
#   provider  fal, higgsfield or elevenlabs
#   agent     claude or codex
#   cli       the full path of that agent's command-line tool
#
# What it does:
#   1. fal.ai and ElevenLabs: asks for your provider key without showing it as
#      you type. Higgsfield has no key: you sign in with your Higgsfield
#      account in your browser instead.
#   2. Codex with fal.ai only: saves the key as FAL_KEY in your login shell
#      profile, because Codex reads that key from its environment when it
#      starts. A FAL_KEY line libi saved before is replaced, in that profile
#      and in any other login profile. Nothing else in them changes.
#   3. Runs the agent's own `mcp add`, which writes the agent's config. For
#      Higgsfield, Codex then opens your browser to sign in and waits until
#      you finish; for Claude Code, it says how to sign in afterwards.
#
# The key is never printed, and it exists only inside this script's process.
# For Codex, libi passes ZDOTDIR from your shell, so a zsh config folder you
# set without `export` is still the one that gets the key.

provider=$1
agent=$2
cli=$3

# Provider details. A libi test keeps this table, and the `mcp add` commands
# below, the same as libi's provider catalog (lib/providers/catalog.ts).
# auth is `key` for a provider key, `oauth` for signing in with your account.
case $provider in
  fal)        name='fal.ai';     auth='key';   codex_key_env='FAL_KEY' ;;
  higgsfield) name='Higgsfield'; auth='oauth'; codex_key_env='' ;;
  elevenlabs) name='ElevenLabs'; auth='key';   codex_key_env='' ;;
  *) echo "add-provider.sh: unknown provider '$provider'" >&2; exit 2 ;;
esac
case $agent in
  claude | codex) ;;
  *) echo "add-provider.sh: unknown agent '$agent'" >&2; exit 2 ;;
esac
if [ -z "$cli" ]; then
  echo 'usage: sh add-provider.sh <provider> <agent> <cli>' >&2
  exit 2
fi

# An empty ZDOTDIR from libi means your shell had none, so the agent's CLI gets
# none either.
[ -n "${ZDOTDIR-}" ] || unset ZDOTDIR

# The agent's own add command for each provider, with the key where it goes.
add_to_agent() {
  case $provider/$agent in
    fal/claude)
      "$cli" mcp add --scope user --transport http fal-ai https://mcp.fal.ai/mcp --header "Authorization: Bearer $key" ;;
    fal/codex)
      "$cli" mcp add fal-ai --url https://mcp.fal.ai/mcp --bearer-token-env-var FAL_KEY ;;
    higgsfield/claude)
      "$cli" mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp ;;
    higgsfield/codex)
      "$cli" mcp add higgsfield --url https://mcp.higgsfield.ai/mcp ;;
    elevenlabs/claude)
      "$cli" mcp add --scope user elevenlabs -e "ELEVENLABS_API_KEY=$key" -- uvx elevenlabs-mcp ;;
    elevenlabs/codex)
      "$cli" mcp add elevenlabs --env "ELEVENLABS_API_KEY=$key" -- uvx elevenlabs-mcp ;;
  esac
}

# Reads the key into $key with typing hidden. When the terminal's echo was
# turned off, it is turned back on however the script ends, Ctrl-C included.
# Ctrl-C also ends the prompt's line, so your shell's prompt starts a new one.
read_key() {
  printf '%s key: ' "$name"
  tty_state=$(command stty -g 2>/dev/null) || tty_state=''
  if [ -n "$tty_state" ]; then
    trap 'command stty "$tty_state" 2>/dev/null' EXIT
    trap 'echo; exit 130' HUP INT TERM
    command stty -echo 2>/dev/null
  fi
  read -r key
  if [ -n "$tty_state" ]; then
    command stty "$tty_state" 2>/dev/null
    trap - EXIT HUP INT TERM
  fi
  echo
}

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

# A provider you sign in to with your account: no key is asked for. Codex's
# add starts the browser sign-in itself; Claude Code signs in afterwards.
if [ "$auth" = oauth ]; then
  if [ "$agent" = codex ]; then
    echo "Codex adds $name, then opens your browser to sign in with your $name account. This waits here until you finish signing in."
    add_to_agent
    exit
  fi
  add_to_agent || exit
  echo "Added. Now sign in with your $name account: click Sign in on libi's Providers tab, or open Claude Code, run /mcp, choose $provider, then Authenticate."
  exit 0
fi

# Claude Code, and every provider without a saved Codex key: the key goes
# straight to the agent.
if [ "$agent" != codex ] || [ -z "$codex_key_env" ]; then
  read_key
  add_to_agent
  exit
fi

# ---- Codex: save the key in your login shell profile first ----

# Files made from here on are private to you: the working copy of a profile
# holds that profile's other lines, which may include other secrets.
user_umask=$(umask)
umask 077
marker="# $name key for Codex, added by libi"
# A profile saved with Windows (CRLF) line endings ends libi's line with a
# carriage return.
cr=$(printf '\r')

read_key
case $key in
  '' | *"'"*) echo 'Nothing saved: the key is empty or contains a quote.'; exit 1 ;;
esac

# The profile your login shell reads: zsh's .zprofile (in ZDOTDIR when that is
# set), bash's first existing .bash_profile or .bash_login, otherwise .profile.
# SHELL is read as it was passed in: some sh implementations fill a missing one
# in from the user database, and that is not the shell libi's terminal runs.
shell_name=$(command printenv SHELL)
shell_name=${shell_name##*/}
if [ -z "$shell_name" ]; then
  # No SHELL: libi's setup terminal runs zsh on macOS and bash elsewhere.
  if [ "$(command uname -s)" = Darwin ]; then shell_name=zsh; else shell_name=bash; fi
fi
case $shell_name in
  zsh) profile="${ZDOTDIR:-$HOME}/.zprofile" ;;
  bash)
    profile="$HOME/.bash_profile"
    [ -f "$profile" ] || profile="$HOME/.bash_login"
    [ -f "$profile" ] || profile="$HOME/.profile" ;;
  *) profile="$HOME/.profile" ;;
esac

# The whole new profile is built in the private copy first: the profile without
# libi's old line, a newline ending a last line that has none, then the new
# line. Only a copy that really ends with the new line is written back, in one
# go, so the old line is never gone without the new one in its place.
tmp=$profile.libi-tmp
command rm -f "$tmp"
if [ -e "$profile" ]; then
  LC_ALL=C command sed "/$marker$cr\{0,1\}\$/d" "$profile" >| "$tmp"
else
  : >| "$tmp"
fi || { command rm -f "$tmp"; exit 1; }
if [ -s "$tmp" ] && [ "$(LC_ALL=C command tail -c 1 "$tmp" | LC_ALL=C command wc -l | LC_ALL=C command tr -d ' ')" = 0 ]; then
  echo >> "$tmp"
fi
printf "export $codex_key_env='%s' %s\n" "$key" "$marker" >> "$tmp" &&
  [ "$(LC_ALL=C command tail -n 1 "$tmp")" = "export $codex_key_env='$key' $marker" ] ||
  { command rm -f "$tmp"; exit 1; }
if ! command cat "$tmp" >| "$profile"; then
  echo "Could not write $profile. The complete edited copy is in $tmp." >&2
  exit 1
fi
command rm -f "$tmp"
echo "Saved $codex_key_env in $profile. Restart libi and Codex so they read it."

# An older libi line in any other login profile goes too, so a profile choice
# that changed since the last add never leaves two. ZDOTDIR's .zprofile comes
# first; when ZDOTDIR is your home folder that is the same file, checked once.
# A file that is the profile just written (a link to it, or its target) keeps
# the new line.
saved=$profile
failed=''
set -- "${ZDOTDIR:-$HOME}/.zprofile" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"
[ "$1" = "$2" ] && shift
for candidate in "$@"; do
  [ "$candidate" -ef "$saved" ] && continue
  drop_saved_key_line "$candidate"
  case $? in
    0) echo "Removed an older $codex_key_env line from $candidate." ;;
    2) failed=1 ;;
  esac
done
# A profile that couldn't be checked stops here, before the add. The new line
# is already saved.
[ -z "$failed" ] || exit 1

# Your own umask again, so Codex makes its files as it always does.
umask "$user_umask"
add_to_agent
