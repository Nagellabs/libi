---
name: removing-and-replacing-backgrounds
description: "Cut a subject out of a video or photo and use it elsewhere: 'remove the background', 'put her on a beach', 'green screen this', 'cut out the product', 'transparent background', 'place him in the other video'. Free and local for video. Not for a blur or sticker that follows a moving subject (using-object-tracking)."
---

# Removing and replacing backgrounds

Done means a cutout asset (subject isolated, background transparent) that you have looked at as pixels, and
then, if the user wants it, composed over a new background or placed into another video with the normal overlay
tools. Never write custom compositing code for this, and never fake a cutout with a crop, a static mask or a
rect overlay.

`libi.remove_background` is local and free and needs no provider. A video provider matters only for the paid
fallback or to generate a new background: read `references/providers/<id>.md` for yours before the first paid
call. With none, call `libi.suggest_provider({ kind: "video" })` (`"image"` for a photo cutout) and stop; the full rule is
`libi.read_manual({ section: "providers" })`.

## Route the request first

| Source | Subject | Route |
|---|---|---|
| Video | A person (or another class the local seed knows) | Local: `libi.remove_background`, the default |
| Video | An object the local seed cannot find, a local result you verified as bad, or hardware too slow | Paid provider: disclose cost, get a yes |
| Photo | Anything | Paid provider; there is no local photo matting |

Local is free, offline and temporally stable, and resolves fine hair well. Paid is not strictly better, so do
not upsell it: reach for it when the local matte is verifiably broken (missing limbs, fragmentation, flicker),
when the seed cannot find the subject, or when local is impractically slow. The local cut is a long job; a ten
second clip takes about half a minute on a good GPU and minutes on weak hardware. Tell the user before starting.

If `remove_background` returns `dependency_not_ready` or `tracking_engine_not_installed`, install the
libi-tracking engine: `libi.get_install_plan({ mcpId: "libi-tracking" })`, disclose the 10-20 minute, ~2 GB
download and get a yes, `libi.install_tracking_engine`, `libi.verify_install` until `ok:true`, retry. Or offer
the paid path if the user would rather not wait.

## Local video cutout

**Look for burned-in graphics first.** Captions, subtitles, logos, watermarks and end cards are baked into the
source pixels. Matting correctly treats them as background, so any glyph lying on the subject punches a
glyph-shaped hole through it, and nothing downstream can recover what was behind the glyph. Downloaded
short-form clips often carry captions. View a frame or two of the source; if graphics overlap the subject, pick
another `range` or clip, or tell the user which regions will punch through. Graphics that never touch the subject
vanish with the rest of the background.

1. **Pick the subject.** One obvious person: omit `subject`. Several people or any ambiguity:
   `libi.track({ action: "ground_target", fileId, time })`, view the numbered frame, and pass the chosen candidate as
   `subject: { kind: "box", box: [x, y, w, h] }`. Never guess pixels.
2. **Cut.** `libi.remove_background({ fileId, subject?, range? })` returns `{ cutoutFileId }`, a transparent WebM.
   `range` scopes it to the section the user needs. An error starting `no_seed_instance:` means no subject was
   found at the range start: pass a `subject.box`, start `range` where the subject is clearly visible, or offer
   the paid path.
3. **Verify pixels; counts are not evidence.** `libi.generate_thumbnails({ fileId: cutoutFileId })` and view the
   frames. For files with alpha the tool composites each frame over solid magenta, so magenta means transparent
   here. This is the only honest way to see alpha: a plain decode of a transparent WebM shows the full original
   footage even for a perfect cutout, so never judge alpha from a raw screenshot or extract. Then:
   - Good: flat magenta everywhere except the subject, clean edges, plausible hair, no gross flicker.
   - Bad matte: stray background patches inside the magenta, big subject chunks missing, or a frame entirely
     magenta or entirely unmatted footage. Re-seed with a different `ground_target` box and `forceNew: true`, or offer the
     paid path with its price.
   - No magenta in any frame: the file carries no alpha. Do not re-run the matte blindly; first confirm you
     thumbnailed the cutout (`...-cutout.webm`), not the source.
   - Burned-in graphic, not a matte bug: a magenta hole shaped like a letter, logo or watermark that overlays the
     subject in the source (check the same timestamp there). Neither a re-run nor the paid path fixes it. Say so
     plainly and offer another segment or clip.
   Never hand over an unverified cutout.
4. **Compose with existing tools.**
   - Replacement: add the new background as a full-frame overlay (`libi.add_overlay({ kind: "video" | "image",
     fileId })`, `rect` the whole canvas), then `libi.add_overlay({ kind: "video", fileId: cutoutFileId })` with a
     `z` above the background's. Preview and export honour the alpha as is.
   - Transplant: `libi.add_overlay` the cutout onto the other video's composition, placed with `rect` and timed
     with `startTime` / `duration`.
   - `rect` is an object `{ x, y, width, height }` in composition pixels; the `[x, y, w, h]` tuple belongs to
     `subject.box` only.
   - Transparent or green-screen deliverable: the cutout file is the transparent asset; for green, compose it over
     a solid green full-frame code overlay and export.
5. **Audio.** The cutout is video-only; the source's audio stays with the source asset. Re-attach it with the
   audio-clip tools if the composed piece should keep the subject's speech.
6. **Lineage.** Append one `libi.update_file_notes` line (mode `append`) to the cutout: source fileId, engine,
   subject seed, range.

## Paid provider path (video fallback and every photo)

Agent-driven through your own provider MCP. `libi.remove_background` never spends money: its provider engine
value only returns these instructions. The endpoints, their required parameters and the endpoints not to use are
in `references/providers/<id>.md`; read it before calling anything, because two plausible-looking
background-removal endpoints are traps.

1. Disclose and approve: get the price from the provider's pricing tool, state it, proceed only on an explicit
   yes.
2. Upload the source with the provider's own upload tool (named in the reference). Never handle a provider key
   or upload bytes yourself; `ai-asset-generation` owns the generation mechanics (queueing, polling, downloads).
3. Run the endpoint with its exact parameters; they are not optional detail, and omitting the transparency
   parameter returns a black-matted video with no alpha.
4. Download the result with `libi.import_remote_files({ urls, pieceId, autoUpload: false })` (it returns each file's `localPath`), then import it with `libi.upload_file({ pieceId, filePath, aiGeneration })` so it carries provenance (`ai-asset-generation` has the fields). Verify it exactly like local step 3 (a photo cutout is a
   transparent PNG: view it directly, since `generate_thumbnails` is video-only), and add the lineage note.
5. Compose as in local step 4.

## Honesty

A failed or ugly matte is reported, not hidden: offer the re-seed or the paid path and let the user choose.
Every paid call is disclosed and approved first.
