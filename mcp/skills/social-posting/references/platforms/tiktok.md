# TikTok (through Zernio)

## What fits

| | value |
|---|---|
| max duration | **600 s (10 min)** |
| max size | 4 GB |
| accepted aspect | 9:16 |
| caption | 2,200 chars |
| post types | video only |
| rate | 15 videos per 24 h |

## Ask the account, never a constant

`accounts_get_tik_tok_creator_info({ account_id })` reports what THIS account may do — privacy levels,
the interaction toggles and their defaults, and the duration cap. Use only a `privacy_level` it returned.
On the accounts measured so far the only level it returned is `PUBLIC_TO_EVERYONE`, so there is no
private option and therefore no safe rehearsal on TikTok: a Zernio draft is the only safe state. A guessed privacy level
is the one mistake that publishes.

`libi.post_piece` reads creator info itself and refuses with `tiktok_creator_info_unavailable` rather
than inventing a level. If you are building the post yourself and the read fails, stop and say so.

## `tiktok_settings` — the ROOT of the create body, not the platform row

snake_case, alongside `content`/`platforms`:

- `privacy_level` — from creator info;
- `allow_comment`, `allow_duet`, `allow_stitch` — TikTok requires these to be sent **explicitly**, and
  their defaults are **off**; take the values creator info reports rather than assuming;
- `content_preview_confirmed`, `express_consent_given` — TikTok's two mandatory consents. They are the
  user's confirmation, not a constant you set to get a call through;
- `video_made_with_ai` — the AI label, on by default;
- `commercialContentType`, `video_cover_timestamp_ms` when relevant (these two are camelCase/mixed as
  Zernio spells them).

## Before anything real

Run the create once with **`dry_run: true`** before any TikTok schedule or publish — it validates the
whole body without creating a post.

## Not available here

No drafts-to-inbox on this account (a Zernio draft is a Zernio-side draft, not a TikTok one), no
unpublish, no undo.
