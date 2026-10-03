---
name: social-music
description: "Music rights for a piece: copyrighted versus generated or owned audio, confirming a song, what an export is for, and each platform's music plan before posting. Load when a piece has downloaded or uploaded music, when exporting or posting one, or when a template's song was left out. Not for making music (music-creation)."
---

# Social music

A song the user did not make is someone else's. libi keeps it in the preview so the piece sounds
right, but it decides — per export and per platform — whether the song travels, and it says what
will happen before it happens. Your job is to ask the two questions only the user can answer (what
is this export for; is this really *Title* by *Artist*), relay libi's per-platform sentences, and
never claim rights the user did not give.

## 1. Rights — what a file's audio is

- Every audio-bearing file is **copyrighted**, **generated** or **owned**. libi stamps it:
  `libi.generate_music`, libi's voiceovers and any `libi.upload_file` that carries `aiGeneration` →
  generated; `libi.download_video` and `libi.import_remote_files` → copyrighted; uploads — the
  user's own files, from the app or through `libi.upload_file` — → owned. The user can flip any
  file in its rights section (the file's details, or the audio clip's inspector).
- **A file you put on disk yourself is not an upload.** If you `libi.upload_file` something that is
  not the user's own — a song you downloaded with your own tools — stamp it right after:
  `libi.set_audio_rights({ pieceId, fileId, class: "copyrighted" })`. When the user tells you an
  uploaded file's music is someone else's song (they name a released track, or say they found it
  online), stamp it copyrighted the same way — with the track in the same call when they named it:
  `libi.set_audio_rights({ pieceId, fileId, class: "copyrighted", track: { title, artist } })`.
  Without that, the song counts as theirs and travels everywhere unchanged.
- **A file you made from another libi file inherits its rights.** (A louder, quieter, dipped or spliced
  bed needs no new file: gain, the volume envelope and crossfades are set on the clip, see `music-creation`.)
  An ffmpeg render, re-encode or mix of
  a song goes in with `libi.upload_file({ …, derivedFromFileId })`: copyrighted stays copyrighted,
  generated stays generated. Without it the upload reads as the user's own and the song would travel
  unflagged. You can never make a file `owned` this way.
- **Tell libi what the song is when you add it.** When you know — you downloaded it, or the user
  named it — pass it on the add: `libi.audio_add_clip({ …, rights: { class: "copyrighted", track: { title, artist } } })`.
  That stamps the file and, in the same call, matches the song on every connected platform that can
  attach a licensed copy. The result's `music.summary` says where it matched and where it didn't —
  relay those lines to the user in your words ("Matched on TikTok: *Espresso — Sabrina Carpenter*. Not
  in Instagram's results — it'll be left out there unless you pick one.").
  Never claim a match the result didn't report (`status: "picked"`). A `skipped` result says why (no
  confirmed identity, social not connected) — act on it, don't retry. `libi.audio_add_clip` also
  returns the file's `rights` (and, for copyrighted audio, a `note`); `libi.get_piece_state` lists
  `audioRights` for everything the piece plays. If `libi.audio_add_clip` refuses with
  `user_decided` (the user already decided this file's rights), add the clip again without `rights`.
- **Confirm the song.** A download's track may carry `trackConfidence: "low"` — it is a page title,
  not a tag. Ask once: "Is this *Espresso* by Sabrina Carpenter?" Then
  `libi.set_audio_rights({ pieceId, fileId, track: { title, artist } })`. When the user already
  named the song, record it without asking again. A wrong or missing identity means no platform can
  attach its licensed copy. A changed track is matched again in the same call: relay the `music`
  result `libi.set_audio_rights` returns exactly as for `libi.audio_add_clip` — never claim a match
  it didn't report.
- **Music you generated yourself.** Import it with `libi.upload_file({ …, aiGeneration })` and it is
  stamped generated. If you imported it any other way (a track fetched from a generation provider's
  output URL with `libi.import_remote_files`, say) it lands as copyrighted: stamp it right away with
  `libi.set_audio_rights({ pieceId, fileId, class: "generated" })`. Stamp `generated` only for a
  file you imported from your own generation tool's output in this same turn, never otherwise.
- **Never set `owned`.** The tool refuses it. When the user says the music is theirs, tell them:
  "Open the file's details (or the audio clip's inspector) and switch on **I own this**."
- Generated and owned music always stays in the video, in every export and on every platform, and
  becomes the post's original sound (Instagram names it — `targets[].music.soundName` overrides the
  name; no name when the Reel also keeps a copyrighted song, since that song is what plays).

## 2. Exports

- `libi.export_video` refuses a piece with copyrighted music until you pass `purpose`
  (`purpose_required`). When the user asks for an export and did not say what it is for — and did
  not ask to post it — ask first, in one line: "Is this export for a social post or for personal
  use?" Ask only that, not the song's title or artist in the same question; a song's identity
  matters when they post (§3), not to export. Don't guess, and don't call the tool to find out.
- `purpose: "social"` leaves copyrighted songs out (at posting, each platform gets its own
  treatment); `"personal"` keeps them. `copyrightedAudio` overrides that default, `includeFileIds`
  keeps chosen files in. The result's `audioDecision.carriesCopyrighted` says what the file
  carries — tell the user in one line.
- If they want to post it, don't export first: `libi.post_piece` exports per platform itself.
- Several exports at once — a with-song and a without-song cut, or one per platform — are one
  `libi.export_video` call with `variants` (the tool's own argument: each entry its own `purpose` /
  `copyrightedAudio`; unrelated to the posting plan's with-song / without-song `exportVariant`, which
  only names which audio cut a post uses). It returns at once with what was queued;
  `libi.list_exports({ pieceId })` shows them finishing (and each one's `carriesCopyrightedMusic`).
  Exports are saved in the piece — never pass `destFolder`.

## 3. Posting

The user hears, per platform, what happens to the music before anything reaches that platform.

`libi.post_piece` plans every target and returns `targets[].plan` — `mode`, `sentence`,
`warnings`, `needs`, `needsChoice`. **Relay every target's `plan.sentence`** (and its warnings and
`needs`) to the user before they publish, in libi's words; never soften a "will likely claim" or
"may mute". For a platform you post to with your own tools, get the same plan first with
`libi.social_music_search` and relay it before you create the post.

The song's platform matches live on the song itself: what `libi.audio_add_clip` matched (or the user
picked — in the song's details or the Posting tab's Music step) is what `libi.post_piece` attaches, and
a user's pick is never overridden. To change a match, the user picks in the song's details panel; a
renamed song (`libi.set_audio_rights` with a new title/artist) is matched again automatically.

What libi does with a copyrighted song, in words:
- **TikTok, Business account:** attaches TikTok's licensed copy from its trending library when the
  song is there, and the post goes out directly (now or scheduled) once the user approves it;
  otherwise a TikTok draft the user finishes in the app.
- **TikTok, personal account:** a TikTok draft sent to the user's TikTok inbox. The user opens it
  from the inbox notification in TikTok and adds the song from the sound library. Keeping the song
  in the video likely posts it silent. An account whose type libi doesn't know yet gets the same
  draft, and the plan's `needs` asks the user to set Business or Personal in Social → Settings.
- **TikTok, either account, with a browser tool:** when TikTok's plan ends in "finish it in the app"
  and you have a browser automation MCP (Playwright), the `browser-posting` skill can finish it for the
  user instead: the without-song export uploaded in TikTok Studio on the web, with TikTok's own copy of
  the song added from its sound library, posted only on the user's yes. Offer it; it is the default
  TikTok route for a piece that needs platform music.
- **Instagram (connected with Facebook Login):** attaches Instagram's licensed copy found by search;
  otherwise posts without the song. Connected with Instagram Login: posts without it and asks the
  user to reconnect with Facebook Login.
- **YouTube:** keeps the song (a with-song export). YouTube will likely claim it — the owner may
  run ads on it or block it in some countries; it is not a strike, and it can be fixed later in
  YouTube Studio's editor.
- **Facebook, X:** post without the song; keeping it risks a mute, a block, or (X) a DMCA report
  that counts toward suspending the account.

Choices: settle them before posting. Every `libi.post_piece` call mints a fresh request and makes
a NEW draft, so a second call to change the music leaves the user with two drafts:
- First, for each Instagram and TikTok target, call
  `libi.social_music_search({ pieceId, platform, accountId, query })`. Its `plan` is the one
  `libi.post_piece` would use. `needsChoice: true` means libi could not pick the licensed copy
  itself: no exact match in the catalog, a song identity that is only a low-confidence guess
  (`trackConfidence: "low"`), or a catalog libi couldn't read. Without a pick, the platform's
  fallback is what gets applied — a TikTok draft the user finishes in the app, or an Instagram post
  without the song.
- A low-confidence identity: don't offer candidates for a guess. Confirm the song with the user
  (§1), fix it with `libi.set_audio_rights({ pieceId, fileId, track: { title, artist } })`, then
  search again — a confirmed identity is matched automatically.
- No exact match: offer the `candidates` and let the user pick (or accept the fallback).
- Then call `libi.post_piece` once, with each pick as `targets[].music: { mode: "attach", trackId }`.
- Never re-run `libi.post_piece` to change the music on a draft that already exists — tell the user
  to change it on the piece's Posting tab.
- Keeping a copyrighted song where it isn't the default (`mode: "include"`) only on the user's
  explicit say-so. On Instagram and TikTok relay the warning in the plan libi returns; on Facebook
  and X, tell them the risk in the words above (a mute, a block, or on X a DMCA report that counts
  toward suspending the account).
- Two different exports (with and without the song) become two linked drafts — say so.
- `export_audio_unknown`: libi can't tell what audio the `exportPath` you passed carries — call
  `libi.post_piece` again without it. A partial failure lists the drafts already made: never re-run
  `libi.post_piece` (it would duplicate them); tell the user which draft is missing.
- Platforms `libi.post_piece` does not build for (YouTube, Facebook, X — X is
  `platform: "twitter"`): get the plan with `libi.social_music_search({ pieceId, platform })`,
  relay it, export with exactly its
  `exportVideoArgs` — `libi.export_video({ pieceId, purpose: "social", copyrightedAudio: "include" })`
  when the plan keeps the song (YouTube), `copyrightedAudio: "exclude"` when it strips it. For
  several platforms make one call with `pieceId` at the top level and `variants`, each entry carrying
  its platform's `exportVideoArgs` minus `pieceId` (an entry takes only per-export fields; a `pieceId`
  inside one is refused). Export before creating the post, then
  post with your own provider tools and link the post with `libi.social_link` kind `post`.
- Finishing by hand: libi shows the links on the Posting tab — "Open TikTok to finish" (with a QR
  code), "Open in YouTube Studio", "Replace the audio in the Instagram app".

## 4. Templates

- `libi.apply_template`'s result may list `pendingMusic`: a song the template names but did not
  include because it is copyrighted. Tell the user which song was not included and ask: "Want me
  to download it?" Download only after the user says yes:
  `libi.fetch_template_music({ pieceId, assetId })`, once per entry. An entry with no source link is
  refused — ask the user for a file or a link instead.
- **If the fetch fails** (the link is dead, the download errors): tell the user plainly, and offer
  to use a file or a link from them instead. With their file or link: bring it in
  (`libi.upload_file` / `libi.download_video`), place it with `libi.audio_add_clip` at each of the
  entry's `clips` (their `startTime`, `duration`, `trimStart`, `volume`), and stamp it copyrighted
  with the entry's track — `libi.set_audio_rights({ pieceId, fileId, class: "copyrighted", track })`
  — since the template named it as someone else's song.
- Making a template: a copyrighted song is named, not included (the create result warns). Tell the
  author which songs will not travel.

## 5. Provider notes

The provider-specific calls (TikTok's commercial music library, Instagram audio search, the payload fields)
are in `references/providers/zernio.md`. libi's own connection makes them; read the reference only when you
build a post with your own provider tools.
