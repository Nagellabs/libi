---
id: photo-cutout-birefnet
title: Photo background removal routes to fal birefnet with cost disclosure
skills: [removing-and-replacing-backgrounds, ai-asset-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
# Two paid steps (generate the source photo, then cut it out) plus compose.
# The 300s default is not enough — placeholder image-gen alone runs ~130s.
timeoutSec: 900
covers: [birefnet, photo-cutout, cost-disclosure, no-video-overgen]
---

## Prompt
Generate ONE simple product photo of a red ceramic mug on a wooden table.
Then remove the photo's background and give me the mug as a cutout on a clean
white background. Yes — you have my approval for the paid steps.

## Hard invariants
```yaml
assertions:
  - { endpoint_id: "fal-ai/birefnet*", expect: present }
  # A photo cutout must not over-generate into video.
  - { endpoint_id: "bytedance/seedance-2.0/*", expect: absent }
  - { endpoint_id: "fal-ai/veo3.1/*", expect: absent }
  # No unknown endpoints — the KB knows the bg-removal ids.
  - { unknown_endpoint: true, expect: absent }
```

## Behavioral expectations
- Routed the PHOTO to the fal birefnet path (v1 has no local photo matting) —
  did NOT try `libi.remove_background` engine local on an image, or treated its
  `local_image_matting_not_supported` redirect correctly if it did.
- Disclosed the birefnet price before running it (approval was pre-granted in
  the prompt, but the cost must still be stated).
- Uploaded the source via `libi.upload_file_to_fal` (no hand-rolled fal uploads).
- Imported the transparent result back into the piece and composed it over a
  white background using existing scene/overlay tools — no custom compositing.
- Appended a lineage note to the cutout file (`libi.update_file_notes`).
