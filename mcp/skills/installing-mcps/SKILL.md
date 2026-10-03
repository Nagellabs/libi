---
name: installing-mcps
description: "Install, set up, configure, repair or fix a libi extension (on-device tracking, transcription, speech, music, downloads). Not for connecting a media provider such as an image or video service; that is libi.suggest_provider."
---

# Installing libi extensions

Use this for a request like "install the <Name> extension (id: `<mcpId>`)" or "the <Name> extension failed to
install or run; diagnose and repair it". The install plan is the single source of truth; this skill only drives
it. Done means the extension's own check passes and the user has been told.

## Install

1. **Signal start.** `libi.update_dep_status({ mcpId, status: "installing" })` right away, so the UI badge shows
   work underway. It records status only; nothing it does installs anything.
2. **Fetch the plan** with `libi.get_install_plan({ mcpId })` and read all of it before acting. It names the exact
   calls, commands, download sizes and consent checkpoints, and the plan wins over anything here.
3. **Follow it step by step**, with your shell and file tools for the commands and files it asks for. Some plans
   install through a dedicated tool instead (`libi-tracking` uses `libi.install_tracking_engine`); when the plan
   names one, call it rather than improvising the install by hand. Update the user at meaningful checkpoints
   ("downloading model weights, about 480 MB", "environment sync complete"), not every sub-step.
4. **Verify with the check that belongs to this extension, then mark installed.** There is no generic verify
   tool, and the wrong one gives a confident answer about something else.
   - `libi-tracking`, and only it: `libi.verify_install()` with no arguments. It runs the engine self-test and
     records the dependency state the tracking gate reads. Another extension's id is refused, because its
     `missing[]` is always the tracking engine's.
   - Every other extension (`whisper`, `local-tts`, `local-music`, `youtube-download`, `libi-export`) has no server
     and no self-test. Re-call the tool that returned `status: "needs_install"` (`libi.generate_music`,
     `libi.generate_speech`, `libi.analysis_transcribe_audio`, `libi.download_video`): that re-checks the same
     gate the install had to satisfy. For a dependency-by-dependency readout, re-run `libi.get_install_plan` and
     read its `dependencies`.

   When the check passes: `libi.update_dep_status({ mcpId, status: "installed" })`. Only `libi-tracking` runs an
   MCP server, so only it gets `libi.extension({ action: "restart", mcpId: "libi-tracking" })`. Then tell the user the
   extension is installed and ready.
5. **On failure**, `libi.update_dep_status({ mcpId, status: "failed", error })` with the last clear error and the
   failing command or step, then show the error verbatim and ask how to proceed. Do not retry silently: it may need
   the user (disk space, permissions, a network proxy).

## Repair

For "failed to install or run", "diagnose and repair", or a check that still fails after an install:

1. `libi.extension({ action: "diagnose", mcpId })` and read the snapshot (server status, last error, dependency states, env
   sanity). Know what is wrong before touching anything.
2. Fetch the plan (it has a recovery section), signal `installing`, and follow the recovery section exactly.
3. Run the same extension-specific check as install step 4. Passing: mark installed, restart `libi-tracking` if
   that is the one, and tell the user. Still failing: mark `failed`, surface the error verbatim, and ask.

## Consent and being stuck

When the plan says to ask before a large download (model weights over about 100 MB, say), ask, and keep the
disclosure the plan specifies. When stuck, state which step failed, show the error verbatim, and ask whether to
retry, skip or abort. Do not invent a fix the plan does not contain.
