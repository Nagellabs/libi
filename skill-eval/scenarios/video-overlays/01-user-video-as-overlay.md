---
id: video-overlays-user-video-as-overlay
title: A user's uploaded video is placed as an editable video OVERLAY — there is no video-scene tool at all
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [video-overlays, add-overlay, video-overlay, not-video-scene, full-frame-default, editable-base, video-less-piece]
---

## Prompt
I just uploaded a video clip to this piece. Put it on the timeline so I can see it.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Placed the user's uploaded video on the timeline as an editable **video
  overlay** — a `libi.add_overlay({ kind: "video", fileId })` call (full-frame by
  default: `rect` omitted ⇒ `fit:"cover"`, so it looks like the old base video but
  is now movable/resizable/z-orderable).
- Did NOT call `libi.create_scene` for the user's clip. `create_scene` is for
  canvas / AI-drawn scenes only — there is no video-scene tool of any kind any
  more (`libi.create_video_scene` / `update_video_scene` /
  `convert_video_scene_to_overlay` were all retired; every video, whether a
  user's upload, an AI-generated take, or a storyboard clip, is an overlay).
- Treated an initially empty composition (`scenes[] == []`) as a valid state, not
  a broken one — it did not seed or insist on a placeholder canvas scene before
  adding the overlay. Most pieces are built entirely from overlays now.
- Optionally matched the composition dimensions to the clip's
  `mediaWidth`×`mediaHeight` (e.g. a vertical clip ⇒ vertical canvas), but the
  load-bearing behavior is the video-as-overlay placement above.
