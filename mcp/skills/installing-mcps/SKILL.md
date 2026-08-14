---
name: installing-mcps
description: Use when the user asks you to install, set up, configure, repair, or fix an MCP server. Drives the get_install_plan → follow plan → update_dep_status → verify_install flow with appropriate progress updates.
---

# Installing MCPs

Use this skill whenever you receive a prompt like:
- "Please install the \<Name\> MCP server (id: `<mcpId>`)."
- "The \<Name\> MCP server failed to install or run. Please diagnose and repair it."

The install plan is the single source of truth. This skill is the generic wrapper for driving it.

## INSTALL flow

1. **Signal start.** Call `libi.update_dep_status({ mcpId, status: "installing" })` immediately. This flips the UI badge to "Installing…" so the user knows work is underway.

2. **Fetch the plan.**

   ```
   libi.get_install_plan({ mcpId: "<id>" })
   ```

   Read the entire plan before acting. It specifies exact tool calls, shell commands, model sizes, and consent checkpoints. The plan is the authority — this skill is only the driver.

3. **Follow the plan step-by-step.** Use your native Bash tool for shell commands the plan asks you to run; use Read / Write for files. Keep the user informed at meaningful checkpoints (e.g. "Downloading model weights (~480 MB)…", "uv sync complete"). Do not narrate every sub-step.

4. **On success — mark installed and verify.**

   ```
   libi.update_dep_status({ mcpId: "<id>", status: "installed" })
   libi.verify_install({ mcpId: "<id>" })
   ```

   Only call `update_dep_status("installed")` after the plan's final step succeeds AND `verify_install` returns `ok: true`. Then restart the server:

   ```
   libi.restart_mcp_server({ mcpId: "<id>" })
   ```

   Tell the user: "✓ \<Name\> is installed and running."

5. **On failure — mark failed with the error.**

   ```
   libi.update_dep_status({ mcpId: "<id>", status: "failed", error: "<last clear error message including failing command/step>" })
   ```

   Then surface the error verbatim and ask the user how to proceed. Do not retry silently — it may require user input (disk space, permissions, network proxy, etc.).

## REPAIR flow

Use this flow when the prompt includes "failed to install or run", "diagnose and repair", or `verify_install` returns `ok: false`.

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

   ```
   libi.verify_install({ mcpId: "<id>" })
   ```

   If `ok: true`: mark installed, restart, tell the user. If still failing: mark `failed` with the error, surface it verbatim, and ask the user how to proceed.

## Consent checkpoints

Some plans require explicit user approval before downloading large files (e.g. model weights > 100 MB). If the plan says to ask first — ask. Do not skip consent steps or abbreviate the disclosure the plan specifies.

## When you are stuck

Surface the error verbatim. Say which step failed. Ask the user whether to retry, skip, or abort. Do not invent a fix not in the plan.
