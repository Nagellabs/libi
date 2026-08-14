---
id: file-upload
title: File import via the agent — upload_file from a local path
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [upload-file, storage, proxy-gen-job, sse-refresh]
cost: subscription-tokens
---

## Preconditions
- Scenarios 02–03 done; editor showing "Agent Eval Run".
- A small local video exists. Prepare one if needed:
  `ffmpeg -f lavfi -i testsrc=duration=6:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -c:a aac -shortest /tmp/agent-eval-clip.mp4`

## Prompt
> Import the video at /tmp/agent-eval-clip.mp4 into the piece "Agent Eval
> Run" and show it to me.

## Expected behavior
- Agent calls `libi.upload_file` (path → content-type inference → ffprobe
  metadata → storage + DB insert), then `libi.show_asset` to display it.
- Upload auto-enqueues a `proxy_gen` job; the asset is auto-wrapped in an
  asset record (Asset Options).

## Checks
- [ ] `upload_file` succeeds; agent reports the new fileId.
- [ ] File on disk: `ls ~/.libi/storage/<pieceId>/` contains the video.
- [ ] Media metadata probed: agent (or `list_files`) reports duration/dimensions.
- [ ] Asset appears in the editor Assets grid without manual reload.
- [ ] `show_asset` navigates the editor to the asset view.
- [ ] Proxy job ran: `*-proxy.mp4` appears next to the original (within ~30s),
      or `jq 'select(.tag == "proxy")' ~/.libi/logs/libi.log` shows the run.

## Notes
- This is THE file-input path for terminal mode (no chat-attachment UI).
- Keep the file imported — scenarios 05 reuses it.
