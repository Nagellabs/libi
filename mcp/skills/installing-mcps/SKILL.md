---
name: installing-mcps
description: Use when the user asks you to install, set up, configure, repair, or fix a libi extension. Drives the get_install_plan → follow plan → verify → update_dep_status flow with appropriate progress updates.
---

# Installing MCPs

Use this skill whenever you receive a prompt like:
- "Please install the \<Name\> MCP server (id: `<mcpId>`)."
- "The \<Name\> MCP server failed to install or run. Please diagnose and repair it."

The install plan is the single source of truth. This skill is the generic wrapper for driving it.

## INSTALL flow

1. **Signal start.** Call `libi.update_dep_status({ mcpId, status: "installing" })` immediately. This flips the UI badge to "Installing…" so the user knows work is underway. It records status only — no `update_dep_status` call ever installs anything; the plan's install steps do that.

2. **Fetch the plan.**

   ```
   libi.get_install_plan({ mcpId: "<id>" })
   ```

   Read the entire plan before acting. It specifies exact tool calls, shell commands, model sizes, and consent checkpoints. The plan is the authority — this skill is only the driver.

3. **Follow the plan step-by-step.** Use your native Bash tool for shell commands the plan asks you to run; use Read / Write for files. Some plans install through a dedicated tool instead of shell commands — e.g. `libi-tracking` installs via `libi.install_tracking_engine` — and when the plan names such a tool, call it; do not improvise the install by hand. Keep the user informed at meaningful checkpoints (e.g. "Downloading model weights (~480 MB)…", "uv sync complete"). Do not narrate every sub-step.

4. **On success — verify, then mark installed.**

   **Verify with the check that belongs to THIS extension.** There is no generic
   verify tool, and reaching for the wrong one gives you a confident answer about
   something else:

   - **`libi-tracking`** — and only this one — is verified by
     `libi.verify_install()`, **with no arguments**. It runs the engine self-test
     and persists the dependency row the tracking gate reads. Passing it another
     extension's id is refused: its `missing[]` is always the tracking engine's
     (`tracking-pyenv`, `uv`, the ONNX models), so an answer about `local-music`
     would be a lie in the shape of a result.
   - **Every other extension** (`whisper`, `local-tts`, `local-music`,
     `youtube-download`, `libi-export`) has no server and no self-test. Its real
     verification is **re-calling the tool that returned `status: "needs_install"`**
     — `libi.generate_music`, `libi.generate_speech`,
     `libi.analysis_transcribe_audio`, `libi.download_video`. That re-checks the
     same gate the install had to satisfy. For a dep-by-dep readout, re-run
     `libi.get_install_plan({ mcpId: "<id>" })` and read its `dependencies` array.

   Only after that check passes:

   ```
   libi.update_dep_status({ mcpId: "<id>", status: "installed" })
   ```

   `libi-tracking` is also the only extension that runs an MCP server, so
   `libi.restart_mcp_server({ mcpId: "libi-tracking" })` applies to it alone —
   do not call it for the others, which have nothing to restart.

   Tell the user: "✓ \<Name\> is installed and ready."

5. **On failure — mark failed with the error.**

   ```
   libi.update_dep_status({ mcpId: "<id>", status: "failed", error: "<last clear error message including failing command/step>" })
   ```

   Then surface the error verbatim and ask the user how to proceed. Do not retry silently — it may require user input (disk space, permissions, network proxy, etc.).

## REPAIR flow

Use this flow when the prompt includes "failed to install or run", "diagnose and repair", or the extension's own check (step 4 above) still fails after an install.

1. **Diagnose first.**

   ```
   libi.diagnose_mcp({ mcpId: "<id>" })
   ```

   Read the snapshot: server status, last error, dep statuses, env-var sanity. Note what is wrong before touching anything.

2. **Fetch the install plan** — it contains a repair / recovery section:

   ```
   libi.get_install_plan({ mcpId: "<id>" })
   ```

3. **Signal repair in progress.**

   ```
   libi.update_dep_status({ mcpId: "<id>", status: "installing" })
   ```

4. **Follow the recovery section** of the plan exactly, using Bash / Read / Write as needed.

5. **Verify and close.**

   Run the same extension-specific check as step 4 of the INSTALL flow —
   `libi.verify_install()` (no arguments) for `libi-tracking`, otherwise re-call
   the tool that reported `needs_install`.

   If it passes: mark installed, restart `libi-tracking` if that is the one, and
   tell the user. If still failing: mark `failed` with the error, surface it
   verbatim, and ask the user how to proceed.

## Consent checkpoints

Some plans require explicit user approval before downloading large files (e.g. model weights > 100 MB). If the plan says to ask first — ask. Do not skip consent steps or abbreviate the disclosure the plan specifies.

## When you are stuck

Surface the error verbatim. Say which step failed. Ask the user whether to retry, skip, or abort. Do not invent a fix not in the plan.
