---
id: video-overlays-export-unplayable-clip
title: An export goes out without a clip it could not load; the agent says so and offers to fix the file, not the code
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/unplayable-clip.mp4]
covers: [video-overlays, export, export-video, dropped-overlays, dropped-video, message-source, honest-result, manual-1.20.9]
---

> **What this tests.** When the canvas export cannot load a video clip (neither its original
> nor its proxy), it finishes WITHOUT that clip and still reports success; the clip is listed
> in `droppedOverlays` as `kind: "video"` with libi's own message
> (`messageSource: "libi"`, manual 1.20.9, "A clip an export could not play"). Before 1.20.9
> every entry was framed as `"overlay body (untrusted)"` and the tool description told the
> agent to fix the overlay's draw function — advice that does not apply to a video. The pass
> is: the agent tells the user the export is missing the clip, names it, does not go
> "fixing" the title's code, and offers what does apply — check the file, rebuild its proxy,
> re-import or replace it — then export again.
>
> **Setup.** The fixture is text under an `.mp4` name, so ffprobe reports nothing (no audio,
> so no linked audio clip rides along), its proxy fails, and the render page's decoder
> refuses it. The code-overlay title forces the chromium-render path, the only one that
> drops rather than fails. Invariant 1 is the precondition that the pipeline produced a
> video drop at all; if it fails, check the export's `libi.log` (`export/overlay_dropped`)
> before judging the agent.

## Prompt
Upload {{fixture:unplayable-clip.mp4}} to this piece and put it on the timeline for the first
3 seconds. Over it, add a title as a code overlay for the same 3 seconds that writes "Summer"
in white, centred. Then export the piece as an mp4 — you don't need to confirm the export with
me, and 1080p graphics are fine. Tell me when the file is ready.

## Hard invariants
```yaml
assertions:
  # 1. Precondition: the export's result listed a dropped VIDEO, not loaded at all, with libi's own mark (anchored
  #    on the escaped JSON of a tool RESULT, which the prompt and the agent's prose can't produce).
  - transcript_matches: '\\"droppedOverlays\\":\[(?:\{[^{}]*\},)*\{(?=[^{}]*\\"kind\\":\\"video\\")(?=[^{}]*\\"messageSource\\":\\"libi\\")(?=[^{}]*\\"cause\\":\\"load\\")(?=[^{}]*\\"fileId\\":)'
    expect: present
  # 2. The entry carried no file name: a downloaded clip's name is a web page's title, so the
  #    agent looks the file up instead.
  - transcript_matches: '\\"kind\\":\\"video\\"[^{}]*\\"name\\":'
    expect: absent
```

## Behavioral expectations
- Uploaded the fixture (`libi.upload_file`), added it as a video overlay (`libi.add_overlay`
  kind `video`, duration 3) and the title as a code overlay, then ran `libi.export_video`.
- Read the result's `droppedOverlays` entry with `kind: "video"` and did NOT report the export
  as done without qualification: told the user the file was written WITHOUT the uploaded clip,
  and named that clip (looked up by `fileId`, e.g. with `libi.list_files`).
- Did not treat it as a code-overlay failure: did not open or edit the title's `draw.jsx`, and
  did not call `libi.render_overlay_frames` / read `renderDiagnostics` to chase it.
- Explained the likely cause in plain words (the file could not be read as a video) and offered
  the remedies that apply — check / rebuild the proxy (`libi.regenerate_proxy`), re-import or
  re-download the clip, or replace it (`libi.update_overlay` with another `fileId`) — then export
  again. If it tried `libi.regenerate_proxy`, it reported that attempt's failure honestly rather
  than re-exporting and claiming success.
- Generated nothing.
