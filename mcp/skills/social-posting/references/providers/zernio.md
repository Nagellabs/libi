# zernio — provider reference for `social-posting`

Everything here was read off the live server on 2026-09-20 (tool schemas and responses) unless it says
UNVERIFIED. Where this disagrees with a guess, this wins; where it says unverified, say so rather than
inventing a spelling.

## Two connections, one provider

- **Yours** — the `zernio` tools in your tool list, signed in by the user in their own agent config.
- **libi's** — an OAuth grant libi holds for the Social page, the Posting tab and `libi.post_piece`.

`libi.social_status().libiConnected` describes libi's, never yours. Either can be present without the
other. libi never reads your sign-in and never writes your agent's config.

## The curated tools are LOSSY

`tools/list` advertises a convenience subset (`posts_create`, `posts_get`, `posts_list`,
`posts_publish_now`, `posts_cross_post`, `accounts_list`, …). They are single-platform, they drop
`metadata` / `tiktok_settings` / `platformSpecificData`, and several answer **prose** instead of JSON.
The full-shaped REST tools are NOT advertised and are reachable only by exact name through `call_tool`:

| what you want | use | never |
|---|---|---|
| create a post | `posts_create_post` | `posts_create` |
| read a post | `posts_get_post` | `posts_get` |
| list posts | `posts_list_posts` | `posts_list` |
| change / schedule / publish / cancel | `posts_update_post` | `posts_update`, `posts_publish_now` |
| delete a draft or a scheduled post | `posts_delete_post` | `posts_delete` |
| accounts | `accounts_list_accounts` | `accounts_list` |
| TikTok's own options for an account | `accounts_get_tik_tok_creator_info` | — |
| an upload URL | `media_get_media_presigned_url` | — |
| ad accounts / campaigns (READ) | `ad_accounts_list_ad_accounts`, `ad_campaigns_list_ad_campaigns` | — |

`call_tool({ name, arguments })`; `search_tools({ query })` returns full tool definitions (name, title,
description, inputSchema). An unknown name answers `Unknown tool: '<name>'`. Errors arrive as text:
`Error: [422] … (code: …)`.

## The write body

Every generated tool declares **`additionalProperties: false`**, so an unexpected key fails the whole
call (`1 validation error … Unexpected keyword argument`) and creates nothing.

- **Top level is snake_case.** `posts_create_post` accepts exactly: `title`, `content`, `media_items`,
  `platforms`, `scheduled_for`, `publish_now`, `is_draft`, `dry_run`, `timezone`, `tags`, `hashtags`,
  `mentions`, `crossposting_enabled`, `metadata`, `tiktok_settings`, `facebook_settings`, `recycling`,
  `queued_from_profile`, `queue_id`. `posts_update_post` is the same plus a required `post_id` and
  `visibility`, minus `dry_run`.
- **Nested objects are free-form and keep the REST API's camelCase.** `platforms[]` rows carry
  `platform`, `accountId`, `platformSpecificData`; `media_items[]` carry `type`, `url`, `filename`,
  `size`, `mimeType`. Do not "fix" those into snake_case.
- `validate_post` takes `content`, `media_items`, `platforms` and **nothing else** — handing it a whole
  create body fails on `tags  Unexpected keyword argument`, so validation never runs.
- `posts_list_posts` filters are snake_case (`account_id`, `date_from`, `date_to`, `profile_id`,
  `include_hidden`, `sort_by`, `search`, `source`, `status`, `platform`), and `page` + `limit` must be
  sent **together** or the call 400s.

## Idempotency — the `x-request-id` header does not exist here

Zernio's REST docs describe an `x-request-id` idempotency header. The MCP tools expose **no `headers`
argument**, so passing one is rejected (`headers  Unexpected keyword argument`) and nothing is created.
Rebuild the contract without it:

- stamp `metadata.libi.requestId` (a UUID) — `metadata` round-trips intact;
- reuse the SAME id on a retry, and check what you already know about this piece before creating again;
- treat the provider's duplicate-content rejection (same content, same account, within 24 h) as success;
- `posts_list_posts` cannot filter by `metadata`, so any recovery scan lists recent posts and matches
  client-side.

## Media

`media_get_media_presigned_url({ filename, content_type, size })` → an upload URL. PUT the bytes with
**no Authorization header**. Limits: 5 GB per file, the URL lives about an hour, uploaded media about
7 days if never attached.

**Attaching PROMOTES the object** from `media.zernio.com/temp/…` to `media.zernio.com/media/…`, so a
read never echoes back the URL you sent. The promoted copy lives and dies with the post that references
it: re-sending it on an update has failed with `[400] Some media files failed to upload. Please
re-upload your media and try again.` — a message that blames the user's media for a URL problem. **Never re-send a media URL the provider echoed back; keep
the upload's own URL** (libi stamps it at `metadata.libi.mediaUrl`) and re-send THAT on every update.

## Status lifecycle

`draft` → `scheduled` → `published` (or `failed` per target). `posts_update_post` is the whole
lifecycle; there is no separate schedule or cancel op:

- schedule: `{ post_id, is_draft: false, scheduled_for, timezone, media_items, platforms }`;
- publish now: `{ post_id, is_draft: false, publish_now: true }`;
- cancel back to a draft: `{ post_id, is_draft: true }`.

`scheduled_for` accepts a local `datetime-local` value with or without seconds; `timezone` is preserved
and the conversion is correct. **A draft keeps whatever `scheduledFor` it had** (and its platform rows
read `status: "pending"` at ≈now) — that time means nothing and must never be shown as a schedule.
Instagram refuses a scheduled post with no media, so fit/validate before scheduling, not only before
publishing.

## Reading

`accounts_list_accounts` → `{ accounts, hasAnalyticsAccess }`; a row carries `_id`, `platform`,
`username`, `displayName`, `isActive`, `needsReconnection`, `permissions[]`, `platformStatus`,
`tokenExpiresAt`, `followersCount`, `adsStatus`, and `profileId` as an OBJECT.
`accounts_get_account_health` adds `tokenStatus` and a `permissions` breakdown with `canPost`.

**`tokenExpiresAt` / `tokenStatus.expiresAt` are NOT a health signal, and never a reason to tell the
user to reconnect.** A TikTok token's lifetime is about 24 h and Zernio refreshes it silently, so an
expiry a few hours out is the steady state, not a warning — which is why libi shows no expiry
countdown in its UI and why `libi.social_status` strips the field before you see it. Reconnect advice
comes from `needsReconnection` (per account) or libi's `needsReconnect`, both set from an OBSERVED
refusal. Saying "the TikTok connection expires today, you'll need to reconnect" is wrong, and it
happened: a real chat turn said it twice off this field (QA 2026-09-21).

`platforms[].accountId` is an **object** on the posts endpoints and a **string** on analytics — handle
both. Analytics rows carry `syncStatus` and `overview.dataStaleness`: "still syncing" is signalled
there, **not** by zeros, and `lastUpdated` is `"2026-09-19 11:00:24"` — space-separated, no zone, not
ISO. Posts published outside libi appear with `isExternal: true`.

Rate limit on the free plan: 60 requests/minute.

## Cost — say it accurately when asked

libi charges nothing for social posting; it is not a membership feature. Zernio is a separate
paid service: it bills the user per connected social account (a free-tier credit covers a small
setup today) and meters some platforms separately (its usage report has an `xApi` line for X).
Never call social posting "free" without that qualifier, never quote a Zernio price from memory
(it is Zernio's to change — point the user at Zernio's pricing), and remember that ad spend goes
to the ad network and your own turns use the user's own Claude Code / Codex plan.

## Ads

`ad_accounts_list_ad_accounts` **requires** `account_id` — ad accounts hang off a connected social
account, not the workspace. An Instagram account with no linked Facebook answers
`Error: [422] A connected Facebook account is required to manage Instagram ads. (code:
linked_account_required)`; libi's own grant, which asks for no ads scope, gets a 403. Both mean **ads
are unavailable for this account** — an expected state to show verbatim, never a broken connection and
never a reason to reconnect. Campaign and ad-account field shapes are UNVERIFIED (no ad account was
connected when this was measured); campaign `status` arrives UPPERCASE.
