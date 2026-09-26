# Instagram (through Zernio)

## What fits

| type | max duration | max size | accepted aspect | caption |
|---|---|---|---|---|
| **Reel** (the default) | **90 s** | 300 MB | 9:16 | 2,200 chars, folds at 125 |
| **Feed** | 60 min | 300 MB | 4:5, 1:1, 1.91:1 (a 9:16 export is cropped) | 2,200 chars, folds at 125 |
| **Story** | 60 s | 100 MB | 9:16 | **none** — Stories take no caption; it expires after 24 h |

`libi.post_piece` runs this check locally, before anything is uploaded, and answers `does_not_fit` with
the platform and the reason. Aspect is matched with a 2% tolerance.

## Options — `platformSpecificData` on the platform row

Inside `platforms[]`, camelCase (the row itself is free-form):

- `contentType`: `"reel" | "feed" | "story"` — the user's default lives in `libi.social_status().defaults`;
- `shareToFeed` (Reels), `commentsEnabled`;
- `isAiGenerated` — the AI label. Default ON; only the user turns it off;
- `collaborators`, `firstComment` when asked for.

## What it will not do

- **No private or unlisted mode.** Anything published is public — there is no rehearsal, and no undo.
- **No unpublish.** A post can be deleted at Instagram, but libi will not take it back for you.
- A scheduled Instagram post with no media is refused outright:
  `Error: [400] Instagram posts require media content (images or videos)`.

## Caption craft

The first **125 characters** are what shows before the fold — put the hook there, then the point, then
≤5 hashtags. Do not open with hashtags. Stories get no caption at all, so anything that needs to be read
has to be on the frame.
