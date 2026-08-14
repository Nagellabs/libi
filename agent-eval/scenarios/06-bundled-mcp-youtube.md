---
id: bundled-mcp-youtube
title: Bundled MCP works — download a YouTube video and import it
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [bundled-mcp-tier2, ytdlp-binary, upload-roundtrip]
cost: subscription-tokens
---

## Preconditions
- Scenario 01 confirmed the YouTube Downloader MCP is listed.
- Network access. Pick a short, stable, public video (e.g. a ~20s creative-
  commons clip; "first YouTube video" `https://www.youtube.com/watch?v=jNQXAC9IVRw` works).

## Prompt
> Download this YouTube video and add it to the piece "Agent Eval Run":
> https://www.youtube.com/watch?v=jNQXAC9IVRw

## Expected behavior
- Agent uses the bundled YouTube Downloader MCP (yt-dlp) to fetch the video,
  then imports the downloaded file via `libi.upload_file` into the piece.
- The bundled MCP spawns on demand (tier-2, npx) using the yt-dlp binary from
  `~/.libi/bin/`.

## Checks
- [ ] The yt-dlp MCP tool call succeeds (no spawn / binary-missing errors).
- [ ] A video file lands in the piece (Assets grid + on disk under
      `~/.libi/storage/<pieceId>/`).
- [ ] Media metadata (duration, dimensions) present on the file record.
- [ ] Proxy generation enqueued for the import (same as scenario 04).
- [ ] If the MCP errors: agent recovers via `libi.diagnose_mcp` /
      `libi.restart_mcp_server` rather than dead-ending (recovery loop is
      itself a pass if the retry then works).

## Notes
- This exercises the full tier-2 lifecycle: settings-file entry → npx spawn →
  binary dep → tool call → filesystem handoff to libi.
- yt-dlp breaks upstream periodically; a yt-dlp extraction failure with a
  clean MCP spawn is a CONTENT failure, not a connectivity failure — note it
  but count the spawn checks on their own.
