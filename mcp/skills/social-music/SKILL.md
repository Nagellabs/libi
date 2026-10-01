---
name: social-music
description: Music rights across a piece's life — copyrighted vs generated or owned audio, confirming a song's identity, asking what an export is for, relaying each platform's music plan before posting (attach the platform's licensed copy, a TikTok draft to finish in the app, keep, or strip), and fetching a template's left-out song only on the user's yes. Use whenever a piece has downloaded or uploaded music, when exporting or posting a piece with music, or when a template's music was not included.
---

# Social music

A song the user did not make is someone else's. libi keeps it in the preview so the piece sounds
right, but it decides — per export and per platform — whether the song travels, and it SAYS what
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
  stamped generated. If you imported it any other way — e.g. an ElevenLabs track fetched from its
  output URL with `libi.import_remote_files` — it lands as copyrighted: stamp it right away with
  `libi.set_audio_rights({ pieceId, fileId, class: "generated" })`. Stamp `generated` ONLY for a
  file you imported from your own generation tool's output in this same turn. Never otherwise.
- **Never set `owned`.** The tool refuses it. When the user says the music is theirs, tell them:
  "Open the file's details (or the audio clip's inspector) and switch on **I own this**."
- Generated and owned music always stays in the video, in every export and on every platform, and
  becomes the post's original sound (Instagram names it — `targets[].music.soundName` overrides the
  name; no name when the Reel also keeps a copyrighted song, since that song is what plays).

## 2. Exports

- `libi.export_video` refuses a piece with copyrighted music until you pass `purpose`
  (`purpose_required`). When the user asks for an export and did not say what it is for — and did
  not ask to post it — ask first, in one line: "Is this export for a social post or for personal
  use?" Ask ONLY that — not the song's title or artist in the same question; a song's identity
  matters when they post (§3), not to export. Don't guess, and don't call the tool to find out.
- `purpose: "social"` leaves copyrighted songs out (at posting, each platform gets its own
  treatment); `"personal"` keeps them. `copyrightedAudio` overrides that default, `includeFileIds`
  keeps chosen files in. The result's `audioDecision.carriesCopyrighted` says what the file
  carries — tell the user in one line.
- If they want to POST it, don't export first: `libi.post_piece` exports per platform itself.
- Several exports at once — a with-song and a without-song cut, or one per platform — are ONE
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
- **Instagram (connected with Facebook Login):** attaches Instagram's licensed copy found by search;
  otherwise posts without the song. Connected with Instagram Login: posts without it and asks the
  user to reconnect with Facebook Login.
- **YouTube:** keeps the song (a with-song export). YouTube will likely claim it — the owner may
  run ads on it or block it in some countries; it is not a strike, and it can be fixed later in
  YouTube Studio's editor.
- **Facebook, X:** post without the song; keeping it risks a mute, a block, or (X) a DMCA report
  that counts toward suspending the account.

Choices — settle them BEFORE posting. Every `libi.post_piece` call mints a fresh request and makes
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
- Then call `libi.post_piece` ONCE, with each pick as `targets[].music: { mode: "attach", trackId }`.
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
  when the plan keeps the song (YouTube), `copyrightedAudio: "exclude"` when it strips it — then
  post with your own provider tools and link the post with `libi.social_link_post`.
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

## 5. Provider notes — Zernio

libi's own connection makes these calls; with your own Zernio tools they are unlisted full-shaped
tools reached through `call_tool`:
- `accounts_list_tik_tok_commercial_music { account_id, country_code? }` — TikTok's Commercial Music
  Library: the 100 trending tracks, not paged, NO search. Use `tracks[].id` (or `clip.id`) as
  `tiktokSettings.musicSoundInfo.musicSoundId`, never `commercialMusicId` (TikTok rejects it).
  Only for accounts connected through the TikTok for Business app. `musicSoundInfo` is ignored on drafts
  sent to the TikTok inbox (`tiktokSettings.draft: true`); at most 5 pending inbox drafts per 24 h;
  Business-app video direct posts are public only.
- `instagram_search_instagram_audio { account_id, audio_type: "music", q? }` — ~30 results; no
  `q` = trending. `instagram_get_instagram_audio { account_id, audio_id }` refreshes a track (its
  `downloadUrl` preview expires after ~1.5 days) and re-validates it before a scheduled publish.
  An Instagram-Login account answers 400 `instagram_audio_requires_facebook_login`: the user
  reconnects choosing the Facebook option.
- Payload: Instagram `platformSpecificData.audioConfiguration { audioId, audioVolume, videoVolume }`
  and `platformSpecificData.audioName` (the Reel's own sound, set once); TikTok per target
  `platformSpecificData.tiktokSettings { musicSoundInfo { musicSoundId, musicSoundVolume,
  musicSoundStart, musicSoundEnd }, videoOriginalSoundVolume }`. The `social-posting` skill §2 puts
  TikTok's options in the root `tiktok_settings`; both places are valid, and a per-target
  `tiktokSettings` wins over the root one. Volumes are 0–100; start and end are milliseconds into the
  track.
