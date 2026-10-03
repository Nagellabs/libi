---
name: social-posting
description: "Post a piece to Instagram or TikTok, or another platform the user's social provider reaches: post, publish, schedule, share to social, 'what should I post where', boost as an ad. Drafts first; publishing or scheduling needs the user's explicit yes. Music rights are social-music."
---

# Social posting

**You do the thinking; libi's UI does the last mile.** You write the caption, decide what goes
where, work across pieces and posts, and handle ads. The UI takes one export to a post, and owns
scheduling, approving, retrying and the connection itself.

**Nothing you do here publishes anything.** `libi.post_piece` creates a Zernio draft and opens
the piece's Posting tab; it cannot publish or schedule, by construction. Say "draft", never "posted",
and never tell the user something went out when it did not. Publishing on Instagram and TikTok is
irreversible, and TikTok offers no private mode through this route, so there is no safe rehearsal:
a draft is the safe state.

**Where a draft is visible.** In libi (the piece's Posting tab, Social → Posts) and at the provider —
**not in TikTok or Instagram**. Nothing shows in either app until the user sends it, so "I don't see it
in TikTok" is the normal state of a draft: say so up front, in the same message that reports the draft.
Provider words are not the user's: an inbox upload comes back from the provider as `published` /
`PUBLIC_TO_EVERYONE`, but it is **not public**. libi's own words (`statusWords` on the result, the
Posting tab's chips) say "Sent to your TikTok inbox — open the TikTok app's notification to finish";
use those, never "published".

## 0. Gate — always first

1. Call **`libi.social_status`**. It answers `providerId`, `libiConnected`, the connected `accounts`,
   the user's `timezone` and `defaults`, `postingContract` and `connectionHealth`. Read it before
   promising anything.
2. `providerId: null` → `libi.suggest_provider({ kind: "social" })` and stop. The chat shows the
   card with the connect button; do not describe a settings page and do not carry on without it.
3. `libiConnected: false` is not a blocker for you. Your own Zernio sign-in (the `zernio` tools in
   your tool list) and libi's OAuth grant are two separate connections. Say so in one line — "libi
   itself isn't connected, so the Social page stays empty until you click Connect libi there; I can
   still make the draft with my own Zernio access" — then take §2. Never report this as "everything is
   broken".
4. No `zernio` tools in your tool list and `libiConnected: false` → nothing can reach the provider: tell
   the user to connect libi on the Social page (Settings tab), and stop.
5. **Never ask the user for an API key**, and never paste one anywhere. Both connections are sign-ins
   the user completes themselves.
6. Several accounts on one platform and the user named none → ask. `ambiguous_account` (from
   `libi.post_piece`) or Zernio's own candidate-list error is a stop, not a guess.
7. **Never tell the user to reconnect an account because of a token expiry.** A TikTok token lasts
   about 24 h and Zernio refreshes it silently, so "expires today at 11:47" is normal and there is
   nothing for the user to do; libi deliberately shows no expiry countdown anywhere, and
   `libi.social_status` does not hand you one. The only reconnect signals are an account's
   `health.needsReconnection` and libi's own `needsReconnect`, both set from an observed refusal.
   If you find a raw expiry date somewhere (in your own account listing, say), it is not a
   deadline: do not mention it, do not plan around it, and do not tell the user to post before it.

## 0b. Platforms `libi.post_piece` does not build for

`libi.post_piece` builds Instagram and TikTok posts. Zernio reaches more (Facebook, X as `twitter` on the
wire, YouTube and others), and the user's account may have one connected. For those, skip `libi.post_piece`
and create the post with Zernio's own full-shaped tools (§2), then call `libi.social_link` kind `post` so the piece
and the post are linked and libi's Posts, Schedule and Analytics views show it like any other. Say plainly
which route you took: libi's own screens do not compose for those platforms, and the user should know the
post came from you.

If the piece has music, load `social-music` first: it owns the per-platform plan and the export arguments (including one call for several platforms), and you export before you create the post.

Never pass such a platform to `libi.post_piece`: its `targets` enum rejects it, and omitting `targets`
skips it rather than posting there.

## 1. The default path: `libi.post_piece`

If the piece has music, `social-music` applies (a per-target plan whose `sentence` you relay before anyone publishes, and possibly two linked drafts).

**TikTok with a song from TikTok's library: the browser route first.** When the piece needs TikTok's
own copy of its song and you have a browser automation MCP (Playwright's `browser_*` tools), load the
`browser-posting` skill and post through TikTok Studio on the web: it can add the song, which a draft
from here cannot for most accounts. Instagram always stays on this API path; its web uploader has no
music at all.

Use this whenever libi is connected. It exports if needed, checks the fit per platform locally, uploads,
creates a draft carrying the options TikTok and Instagram actually reported (TikTok gets a draft of its
own, so it can go to the user's TikTok inbox from the Posting tab without publishing the other platforms),
links it to the piece and opens the Posting tab.

- **Intake in one message:** which piece, which accounts, the Instagram type (Reel unless told
  otherwise), what the caption should say, and when. The default is a draft. Read
  `references/platforms/<platform>.md` for every target before you promise it will fit.
- **Write the caption yourself** — hook inside the first 125 characters (that is where Instagram folds),
  then the point, then ≤5 hashtags. Instagram Stories take no caption at all.
- If the piece has no export yet, say that exporting runs for minutes (and may download Chromium) before
  you start.
- Call `libi.post_piece({ pieceId, targets, caption })`. `targets` omitted = every connected account.
- Read the result: `reusedExport` non-null means it posted the piece's last export, which libi cannot
  tell is current. Name that file to the user and offer to re-export.
- `does_not_fit` → say which platform and why, then offer `libi.export_video` at a size that fits
  (several platforms at once: one call with `variants`, one entry per size, then `libi.list_exports`
  for the files), or dropping that target. Nothing was uploaded. `libi_not_connected` → §2. `piece_not_found` →
  `libi.list_pieces`.
- Then one line: *"The draft is in the piece's Posting tab (and at your provider); nothing is in TikTok or
  Instagram until you send it from there."* For a TikTok draft the user can finish in the TikTok app, add:
  *"Send to TikTok inbox"* is a button on the draft, and TikTok then shows a notification to finish. Stop.
- A `needs` item in a result (`plan.needs`, with `needsOpen`; an account's `open`) is one the user fixes on
  a libi screen: call `libi.show({ target: "social_settings", accountId })` with the `needsOpen` / `open`
  values, then say in one line what to do there. Do not explain menus from memory or from the provider's
  docs: that is how a user was once sent to connect the wrong account.

## 2. Your own Zernio tools — when libi is not connected, or the job is bigger than one piece

Your tool list advertises only Zernio's curated tools. Those are lossy: they are single-platform and
answer in prose, dropping `metadata`, `tiktok_settings` and `platformSpecificData`. Use the full-shaped
REST tools instead. They are not advertised and are reachable only by exact name through `call_tool`:

```
call_tool({ name: "posts_create_post", arguments: { … } })
```

`search_tools({ query: "create post" })` returns their real input schemas. Use `posts_create_post`, never
`posts_create`; `posts_list_posts`, never `posts_list`; `posts_get_post`, never `posts_get`. These are the
provider's current names (`references/providers/zernio.md`); if one answers `Unknown tool`, `search_tools` finds
the live spelling.

**The write body is snake_case at the top level** and every schema is `additionalProperties: false`, so a
camelCase key or an unknown one does not get ignored — the whole call is rejected and no post is created.
Inside `platforms[]` and `media_items[]` the keys are the REST API's own camelCase (`accountId`,
`platformSpecificData`, `mimeType`). Details and the full key list: `references/providers/zernio.md`.

Every draft you create yourself:

- `is_draft: true` always, `content`, `media_items`, `platforms[]` with `accountId`;
- `tags: ["libi"]` and `metadata: { libi: { pieceId, pieceName, exportFile, requestId, mediaUrl } }` — the
  stamp is what ties the post back to the piece. `mediaUrl` is the URL **you uploaded to**, and it belongs in
  the stamp for the same reason the bullet below says to keep it: it is the only copy that survives, and
  without it libi's composer has nothing to re-send on an edit but the provider's own echoed URL.
  There is **no `headers` argument** on these tools, so the **`x-request-id`** header Zernio's REST docs
  describe **is not reachable through MCP** and passing one is rejected outright: your idempotency key
  is `metadata.libi.requestId`. Reuse the same one on a retry, and treat a duplicate-content rejection
  as success rather than posting twice.
- Instagram options go in each platform row's `platformSpecificData`; TikTok's go in the root
  `tiktok_settings` (a per-target `platformSpecificData.tiktokSettings` is also valid and wins over
  the root one — that is where the `social-music` skill puts TikTok's licensed music).
- TikTok: read `accounts_get_tik_tok_creator_info` and use only a `privacy_level` it returned, never a
  guessed one. Set `allow_comment` / `allow_duet` / `allow_stitch` explicitly from what it reports,
  `content_preview_confirmed` and `express_consent_given` from the user's actual confirmation, and
  `video_made_with_ai` per their AI-label default (on unless they changed it).
- Media: `media_get_media_presigned_url` gives an `uploadUrl`; the PUT carries **no** Authorization
  header. Keep the URL the upload itself used and re-send THAT — **never a media URL the provider echoed
  back on a read**; the echoed copy dies with the post that references it and the failure blames the
  user's media.
- `validate_post` before creating — it accepts `content`, `media_items` and `platforms` and nothing else.
  On a 207/partial result, report every target's `errorMessage` **verbatim**; they are per-target and
  each says something different.

Then **`libi.social_link({ kind: "post", pieceId, providerPostId })`** so the post shows in the piece's Posting
tab and on the Social page. Linking changes nothing at the provider.

## 3. Publishing, scheduling and the TikTok inbox — the user's, on the Posting tab

None of these is yours to do: not with `libi.post_piece` (it cannot), and **not with the provider's own
tools either**. Never call `posts_update_post`, `publish_now`, `posts_publish_now`, `posts_cross_post`
or any call that sets `is_draft: false` to deliver or publish a post, even when the user says "yes, send
it" or "publish it": a yes from the user is a reason to point them at the button, not a licence to press
it for them. The Posting tab has them, each behind the user's own confirm: **Publish now**, **Schedule…**
and, on a TikTok draft, **Send to TikTok inbox**. When the user says "send it" or "post it":
open the draft for them if it is not already open (the post_piece result's `navigated`, or
`libi.social_link` kind `post` for a post you made yourself), name the button, and stop.

If libi is not connected (§0.3) the buttons are not there: ask the user to connect libi first
(`libi.show({ target: "social_settings" })`), which is also the path for a draft you made with your own
tools (link it with `libi.social_link` so it shows in the Posting tab). A caption, a plan or an earlier
message is never a yes. Say once, plainly, that Instagram and TikTok have no undo. A draft's
`scheduledFor` is meaningless: never read one back to the user as a schedule.

## 4. Ads — reading is libi's, every change is yours

libi's Social → Ads tab is reporting only: accounts, campaign tree, status, spend/CTR/CPC/CPM.
libi's grant holds no ads scope at all (Zernio's only ads scope also permits creating ads), so an ads
read can answer 403, which means "ads unavailable for this account": not a broken connection, and
never a reason to reconnect or re-sign-in anything. A `422 linked_account_required` (an Instagram
account with no linked Facebook) is the same kind of answer: show it verbatim.

Creating, pausing, resuming or re-budgeting an ad is yours, through your own tools. Find the tool with
`search_tools` rather than guessing a name. Before any ad write, state the network, the **budget**
(amount, and daily or lifetime), the dates and the audience, and **wait for an explicit yes**. This
spends real money, and a blanket go-ahead earlier in the conversation does not cover it. Afterwards report the
campaign id, the review status and the delivery status.

## 5. Reading back

`libi.social_status` for the connection and accounts (it reports health as `healthy` / `reconnect` /
`unknown`, never a token expiry — see §0.7); the full-shaped `posts_list_posts` for posts (its
filters are snake_case, `page` and `limit` go together, and it **cannot** filter by `metadata` — list and
match client-side). Analytics can be **"syncing" rather than zero**: `syncStatus` and
`overview.dataStaleness` say which, so never report a fresh post as having no reach.

## 6. What libi has no path for

Zernio's per-profile queue and calendar, and account-level analytics, have no libi path: say so and stop
rather than improvising one.
