# zernio: provider notes for `social-music`

libi's own connection makes these calls. With your own Zernio tools they are unlisted full-shaped tools,
reached through `call_tool({ name, arguments })`; `search_tools` finds the live spelling if a name is refused.

- `accounts_list_tik_tok_commercial_music { account_id, country_code? }` — TikTok's Commercial Music
  Library: the 100 trending tracks, not paged, no search. Use `tracks[].id` (or `clip.id`) as
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
