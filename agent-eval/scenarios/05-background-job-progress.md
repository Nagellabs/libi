---
id: background-job-progress
title: ffmpeg tool round-trip (trim) + async jobs SSE bridge (tracking)
surfaces: [terminal, acp, connect-agent]
agents: [claude-code, codex]
systems: [ffmpeg-tool, jobs-http-bridge, job-manager, jobs-ui]
cost: subscription-tokens
---

## Two distinct paths — do not conflate them
- **`libi.trim_video` is a DIRECT ffmpeg MCP tool** (`mcp/tools/ffmpeg-tools.ts`),
  run in-process by the MCP child. It does NOT touch the JobManager async SSE
  bridge. Use Part A below to prove the simple ffmpeg-tool round-trip.
- **The async jobs HTTP+SSE bridge (`runJobViaServer`) is exercised only by
  `compute_object_track`** (tracking). That requires the tier-2 libi-tracking
  engine to be installed. Use Part B for the true bridge test.
- The JobManager is also exercised indirectly by scenario 04's upload, whose
  proxy generation runs through the `proxy_gen` runner (fire-and-forget enqueue).

## Preconditions
- Scenario 04 imported `/tmp/agent-eval-clip.mp4` (6s clip) into the piece.

## Part A — ffmpeg tool round-trip (always runnable)
### Prompt
> Trim the imported test clip to keep only seconds 1 through 4, as a new file.

### Expected behavior
- Agent calls `libi.trim_video`; a new ~3s file lands in the piece.

### Checks (Part A)
- [ ] New ~3s file appears (Assets grid + `list_files`).
- [ ] `jq 'select(.tag=="ffmpeg" and .op=="trim_video")' libi.log` shows it.

## Part B — async jobs SSE bridge (requires libi-tracking engine)
### Prompt
> Track the main subject in the imported clip across the whole clip.

### Expected behavior
- Agent calls `libi.compute_object_track`, which goes
  MCP child → `POST /api/jobs` → SSE `/api/jobs/<id>/events` → result via
  `runJobViaServer`, forwarding live progress to the chat/terminal.

### Checks (Part B)
- [ ] If the engine is not installed, the tool returns the structured
      `tracking_engine_not_installed` error and the agent follows the install
      plan — that itself is a valid connectivity outcome to record.
- [ ] If installed: per-tick progress is visible and a track is produced;
      Settings → Background Jobs lists the `tracking` job.

## Checks
- [ ] Tool completes and a new ~3s file appears in the piece (Assets grid +
      `list_files`).
- [ ] `jq 'select(.tag == "ffmpeg" and .op == "trim_video")' ~/.libi/logs/libi.log`
      shows the invocation.
- [ ] Settings → Background Jobs lists the job (status `completed`).
- [ ] Re-issuing the same trim attaches/dedupes rather than blindly re-running
      (agent reports a previous result or the server returns
      `matching_completed` — see Long-running tool dedup policy).
- [ ] `libi.get_job_status` on the reported jobId returns a snapshot.

## Notes
- If this fails with `libi_server_unavailable` while scenario 02 passed,
  suspect the jobs SSE stream specifically (`/api/jobs/[id]/events`), not the
  port file.
