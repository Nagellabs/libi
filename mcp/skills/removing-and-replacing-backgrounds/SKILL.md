---
name: removing-and-replacing-backgrounds
description: Remove a video's or photo's background into a reusable alpha "cutout" asset (subject isolated, background transparent), then compose it over any new background or transplant it into another video — local free MatAnyone matting for video, paid fal fallback (bria video / birefnet photos). Triggers — "remove the background", "put her on a beach", "green screen this", "cut out the product", "transparent background", "place him in the other video".
when_to_use: When the user wants a subject separated from its background — background replacement, transparent/green-screen output, object transplant between videos, or a photo cutout. Single source of truth for the cutout workflow; composition reuses the normal scene/overlay tools.
---

# Removing & Replacing Backgrounds

The capability is a composable **cutout asset** — one tool produces an
alpha-matted file; everything after that (replacement, transplant, export) is
libi's EXISTING compositing. Never write custom compositing code for this.

> **Engine install:** if `libi.remove_background` returns
> `dependency_not_ready` / `tracking_engine_not_installed`, follow the
> libi-tracking install plan (`libi.get_install_plan` with id `libi-tracking`,
> then `libi.verify_install` until `ok:true`, then retry) — or offer the paid
> fal path if the user prefers not to wait.

## Route the request (decide FIRST)

| Source | Subject | Route |
|---|---|---|
| Video | Person (or another YOLOE class) | **Local, free** — `libi.remove_background` (default) |
| Video | Arbitrary object the local seed can't find, local result verified bad, or the user's machine is too slow | **fal, paid** — `bria/video/background-removal/v3` (disclose cost, get approval) |
| Photo | Anything | **fal, paid** — `fal-ai/birefnet` (local photo matting is not available in v1) |

The local engine is the hero: free, offline, temporally stable (MatAnyone
consistent-memory propagation seeded from a real first-frame subject mask).
Prefer it for any video with a visible person. It is a LONG job — progress
streams to the chat; a ~10 s clip takes roughly half a minute on a good GPU,
minutes on weak hardware. Tell the user before starting.

## Local video cutout

> **Check the source for BURNED-IN GRAPHICS first.** Captions, subtitles,
> logos, watermarks and end-cards are baked into the source pixels. Matting
> correctly treats them as background — they are not the person — so any glyph
> sitting ON the subject punches a glyph-shaped HOLE clean through them (a
> caption letter over a hand reads as a strange ring in the hand). **No tool
> and no stage can fix this**: there is nothing behind the glyph to recover.
> Downloaded YouTube/TikTok clips very often carry burned-in captions.
> So before cutting, LOOK at a frame or two of the source: if graphics overlap
> the subject, pick a different segment (`range`), pick a different clip, or
> tell the user up front which regions will punch through. Graphics that never
> touch the subject are harmless — they vanish with the rest of the background.

1. **Pick the subject.** One obvious person → omit `subject` (auto). Multiple
   people / ambiguity → `libi.ground_target({ fileId, time })`, LOOK at the
   numbered frame, and pass the chosen candidate's bbox as
   `subject: { kind: "box", box: [x, y, w, h] }`. Never hand-guess pixels.
2. **Cut.** `libi.remove_background({ fileId, subject?, range? })` →
   `{ cutoutFileId }` — a VP9-alpha WebM (transparent background baked in).
   `range` scopes the cutout when the user only needs a section.
   A failure whose message starts with `no_seed_instance:` means the seed
   step found no subject at the range start — pass a `subject.box` from
   `libi.ground_target`, start `range` where the subject is clearly visible,
   or offer the paid fal path.
3. **VERIFY PIXELS (mandatory — counts are not evidence).**
   `libi.generate_thumbnails({ fileId: cutoutFileId })` and LOOK at the
   frames. For alpha-bearing files the tool decodes alpha-preserving and
   composites each frame over SOLID MAGENTA — **magenta = "transparent
   here"**. That compose is the ONLY honest way to see alpha: a plain
   native decode of a VP9-alpha WebM shows the FULL ORIGINAL SCENE even for
   a perfect cutout (the alpha rides a side-band the native decoder skips),
   so never judge alpha from a raw screenshot/extract. Judge the magenta
   thumbnails:
   - GOOD — background is flat magenta everywhere except the subject;
     edges clean; hair plausible; no gross flicker between stamps.
   - BAD MATTE — stray original-background patches inside the magenta, big
     subject chunks missing (magenta holes), or a frame that is entirely
     magenta (matte dropped the subject) / entirely scene (matte covered the
     full frame). Re-seed with a different `ground_target` box and
     `forceNew: true`, or offer the paid fal upgrade with its price.
   - NO MAGENTA IN ANY FRAME — the file carries no alpha at all. Do NOT
     re-run the matte blindly: confirm you thumbnailed the CUTOUT
     (`…-cutout.webm`), not the source clip.
   - BURNED-IN GRAPHIC — NOT a matte bug. A magenta hole whose shape matches
     a letter, logo or watermark that overlays the subject in the SOURCE.
     Confirm by looking at the same timestamp in the source clip. Do NOT
     re-run the matte and do NOT offer the paid upgrade — neither can fix it
     (see the burned-in-graphics note above). Report it plainly and offer a
     different segment or clip.
   You may NOT hand the user an unverified cutout.
4. **Compose** (existing tools only)
   - **Replacement** — add the new background as a full-frame OVERLAY
     (`libi.add_overlay({ kind: "video" | "image", fileId })`, rect = the whole
     canvas), then `libi.add_overlay({ kind: "video", fileId: cutoutFileId })`
     for the cutout with a `z` ABOVE the background's. The renderer and the
     export pipeline honor the WebM's alpha as-is.
     Videos are ALWAYS overlays — there is no video-scene tool to reach for.
     Overlays are the editable, orderable layer model; use them for BOTH halves
     of the composite and set `z` to control which is behind.
   - **Transplant** — `libi.add_overlay` the cutout onto the OTHER video's
     composition, sized/positioned via `rect` (and timing via
     `startTime`/`duration`).
   - `rect` is an OBJECT — `{ x, y, width, height }` in composition pixels.
     Never write it as a `[x, y, w, h]` tuple; that tuple shape belongs to
     `subject.box` only.
   - **Transparent/green-screen deliverable** — the cutout file itself IS the
     transparent asset; for a green-screen variant compose it over a solid
     green full-frame code overlay and export.
5. **Audio** — the cutout is video-only (`-an`). The source clip's audio stays
   with the source asset; re-attach it via the normal audio-clip tools if the
   composed piece should keep the subject's speech.
6. **Lineage** — append one `libi.update_file_notes` line to the cutout file
   (mode `append`) noting source fileId, engine (local matanyone / fal
   endpoint), subject seed, and range.

## Paid fal path (video fallback + all photos)

Agent-driven through the fal-ai MCP — `libi.remove_background` never spends
money (engine `"fal"` only returns these instructions).

> **Paid is NOT strictly better — do not upsell it reflexively.** Measured on
> real footage (bake-off, 2026-07-19, local MatAnyone vs Bria V-RMBG 3.0 vs
> veed on the same clip):
> - **Local resolves FINER HAIR** — individual curls and wisps, where V-RMBG
>   3.0 merges them into a more solid mass. Local also costs nothing.
> - **V-RMBG 3.0 is STRUCTURALLY sturdier** — it kept a gesturing hand whole
>   where the local matte fragmented it. Being temporally aware rather than
>   frame-by-frame, it is also the better answer for flicker.
>
> So: local stays the default. Reach for the paid path when the local result
> is verifiably broken (missing limbs, fragmentation, flicker), when the
> subject is one the local seed can't find, or when the user's hardware makes
> local matting impractically slow — not merely to sound premium.

1. **Disclose + approve.** Get the price via fal `get_pricing` for the
   endpoint and state it plainly; proceed only on explicit user approval.
2. **Upload.** `libi.upload_file_to_fal({ fileId })` → a fal-hosted URL. Never
   handle FAL_KEY or upload bytes yourself (see `ai-asset-generation` for the
   full fal mechanics — queue tools, polling, downloads).
3. **Run.** Video: `bria/video/background-removal/v3` (Bria V-RMBG 3.0) with
   `{ video_url, background_color: "Transparent", output_container_and_codec: "webm_vp9" }`.
   **Pass those two explicitly** — `background_color` defaults to `Black`, so
   omitting it returns a black-matted video with NO alpha, and only the
   webm/mkv VP9 outputs can carry alpha at all (any mp4/h264 variant silently
   drops it).
   Photo: `fal-ai/birefnet` with `{ image_url }` (transparent PNG out).

   Do NOT use `bria/video/background-removal` (the v1 id): it is a real
   endpoint but its worker crashes server-side on the transparent path
   (status reports COMPLETED, result fetch 500s) and it is priced ~33x above
   v3. Do not use `veed/video-background-removal` either — measured softer on
   both hair and subject edges at ~5x v3's price.
4. **Import.** `libi.import_remote_files` the transparent result into the
   piece; verify pixels exactly like local step 3 (a video import gets the
   same magenta-composited thumbnails; a photo cutout is a transparent PNG —
   view it directly, `generate_thumbnails` is video-only); add the lineage
   note.
5. **Compose** — same as local step 4.

## Honesty rules

- Never fake a cutout (cropping, masking with a static shape, or a rect
  overlay is NOT background removal).
- A failed/ugly matte is reported, not hidden — offer the re-seed or the paid
  upgrade and let the user choose.
- Do not silently spend — every fal call is disclosed and approved first.
