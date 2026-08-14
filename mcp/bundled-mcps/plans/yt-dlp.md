# Recovery guide: YouTube Downloader (`@kevinwatt/yt-dlp-mcp`)

This MCP runs via `npx -y @kevinwatt/yt-dlp-mcp@<version>` by default —
libi includes it in your session's MCP list automatically. You only
need this guide if `libi.diagnose_mcp({ mcpId: "youtube-downloader" })`
showed a problem.

## Symptom: `auxiliary` shows `yt-dlp not found on PATH`

The `yt-dlp` Python binary that this MCP shells out to is missing.
Libi normally installs it in Category A (boot time) via `uv tool
install yt-dlp`. If it's missing on your machine, install it manually:

```bash
~/.libi/bin/uv tool install yt-dlp --python 3.12
ln -sf "$(~/.libi/bin/uv tool dir)/yt-dlp/bin/yt-dlp" ~/.libi/bin/yt-dlp
```

On Windows, copy `yt-dlp.exe` into `%USERPROFILE%\.libi\bin\` instead
of symlinking.

Then call `libi.restart_mcp_server({ mcpId: "youtube-downloader" })`
to give the MCP a fresh start.

## Symptom: `auxiliary` shows yt-dlp present but VERY slow (>5s)

The user has the PyInstaller-onefile `yt-dlp_macos`/`_linux` binary
(35 MB single file) instead of the fast uv-managed Python script.
Cold startup is 10-12s; under parallel session spawn it can hit 40s
and exceed MCP_TIMEOUT.

Fix by replacing it with the uv-managed install (same commands as
above). The agent should normally never see this case because Tier 1
installs the fast variant — but if a user replaced it manually,
this is the recovery.

## Symptom: `lastServerError` mentions npm registry / 401 / network

The npx install is failing — usually offline, behind a corporate
proxy, or a transient registry outage. Suggest the user retry, or
configure their npm proxy. Don't attempt to install around it
automatically.

## Symptom: MCP appears `up` but tools aren't in your deferred list

Stale session state. Call `libi.restart_mcp_server` — it tells you
the right next step (per spike findings, either restarts the MCP
in-place or asks the user to open a new chat).

## When the install IS fully working

Nothing for you to do. Just call the tools directly:
`mcp__YouTube_Downloader__ytdlp_download_video`,
`mcp__YouTube_Downloader__ytdlp_get_video_metadata`, etc.

If you want to attest a successful manual fix to libi, call
`libi.update_dep_status({ mcpId: "youtube-downloader", status:
"installed" })`. Optional; the Settings UI uses this for the install
badge.
