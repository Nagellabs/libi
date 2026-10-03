---
name: browser-posting
description: Post a piece to TikTok through a browser the user is signed in to (a browser automation MCP such as Playwright), with TikTok's own copy of the song — the default TikTok route when the piece needs platform music. Use for "post to TikTok with music", "post using the browser", or Instagram from the web (routes Instagram back to the API). Not for plain API drafts (that is social-posting).
---

# Browser posting (TikTok Studio)

**Why this exists.** libi's social provider (the `social-posting` skill) cannot attach TikTok's
licensed copy of a song for most accounts — a personal account only gets a TikTok inbox draft that
the user finishes in the app. TikTok Studio on the web (https://www.tiktok.com/tiktokstudio/upload) HAS the
sound library, so a browser you drive can do the whole post: the export without the copyrighted
song, plus TikTok's own copy of that song on top. Every rule below was learned on a real post
(owner's account, 2026-10-02); the selectors and timings that worked are in
`references/tiktok-studio.md` — read it before your first click.

## 0. Which route — decide before anything else

| Target | Piece has a song that needs the platform's copy | Route |
|---|---|---|
| **TikTok** | yes | **this skill** (browser), when a browser MCP is available (§1); otherwise `social-posting` (inbox draft) and say why |
| **TikTok** | no | `social-posting` (API draft) by default; this skill only if the user asks for the browser |
| **Instagram** | either | **`social-posting` (API)**. Never the browser — see §8 |
| anything else | — | `social-posting` |

"Needs the platform's copy" is decided by the `social-music` skill: load it, get the plan, and when
the plan for TikTok is to finish the song in the app, this skill IS the better way to finish it.

## 1. Gate — always first

1. **A browser tool you can drive.** You need Playwright MCP's `browser_*` tools
   (`browser_navigate`, `browser_file_upload`, `browser_run_code_unsafe`, `browser_take_screenshot`).
   - **Not in your tool list** → call **`libi.suggest_provider({ kind: "browser" })`** and stop. In the
     app it puts a card in the chat whose **Connect Playwright** button opens libi's Providers tab, where
     the user submits the add command themselves — libi does not add browser tools to an agent (it never
     writes an agent's config), so do not print commands or edit any config. From a CLI outside libi
     the tool returns the commands (`… mcp add … playwright -- npx @playwright/mcp@latest`): relay them
     verbatim. Either way say that Playwright runs on their computer with npx (Node.js), needs no key,
     and that a NEW chat is needed afterwards — a running session never picks up a new MCP. Offer the
     `social-posting` route meanwhile.
   - `status: "none"` from that call means Playwright IS connected for this agent but its tools are not
     in this chat: it was added after the chat started — tell the user to open a new chat.
   - **Claude in Chrome is not a substitute.** It uploads a file by sending its bytes and caps
     that at 10 MB — every real video is bigger. Don't try it, and don't try serving the file from a
     local web server either: TikTok's page security refuses it.
   - **chrome-devtools MCP `--autoConnect`** also uploads by path and uses the user's real Chrome,
     but only after the user switches remote debugging ON at `chrome://inspect/#remote-debugging`
     (the MCP's "Could not find DevToolsActivePort" error means it is off). Playwright MCP is the
     default; its steps here translate one-to-one.
2. **Signed in.** `browser_navigate` to `https://www.tiktok.com/tiktokstudio/upload`. Playwright MCP
   runs its OWN browser profile (it keeps the login between runs). A redirect to `/login` means not
   signed in: ask the user to sign in **in that browser window** (the QR code is quickest), and wait
   for them to say so. **Never type a password, a code or any credential yourself.**
3. **Permissions.** Claude Code's auto mode classifies clicks on TikTok as real-world transactions
   and refuses them — even after the user says yes in chat, which it cannot see. If a browser action
   is refused that way, stop retrying and tell the user: switch this session out of auto mode (to
   ask-each-time, or bypass if they choose) and say "go". Never work around the refusal.

## 2. Prepare the video — default 59 s

- **Default length ≤ 59.9 s; aim for 59 s.** Two things switch off above 60 s: **Duet/Stitch**
  ("Reuse of content" is greyed out with *"Duet and Stitch not available for videos over 60s"*), and
  **TikTok's song clips** — the library's clips are at most **1:00**, so anything longer has a
  silent tail. 60.2 s already counts as "over 60 s".
- Longer only when the content needs it (a tutorial, a story that loses its point when cut) — then
  say what the user gives up (Duet/Stitch, music under the last seconds) and let them choose.
- A longer piece → offer a cut: **duplicate the piece** (`libi.duplicate_piece`, keep the original)
  and trim whole sections — not frames off every scene. When narration carries numbers ("One:",
  "Two:"), keep or cut whole numbered items, re-split the narration clip at word boundaries
  (`libi.audio_add_clip` with `trimStart` + `duration`, words from the caption overlay), re-sync the
  captions (`libi.update_overlay` with `captionFromFileId`), and fix any on-screen counter that now
  lies ("4 lessons", "SHEET 11/11"). Render frames across the cut (`libi.render_overlay_frames`,
  `contactSheet: true`) and look before you export.
- **Export for the platform-music route:** `libi.export_video({ pieceId, purpose: "social" })` — the
  copyrighted song is LEFT OUT, because TikTok's own copy goes on top. Never post that file without
  adding the song: it is the piece minus its music (an intro over a downloaded clip can go silent).
- **The file path.** Playwright MCP only reads files inside its workspace roots (the agent's cwd and
  `<cwd>/.playwright-mcp/`). Copy the export to `<cwd>/.playwright-mcp/<short-ascii-name>.mp4`, upload
  that, and delete the copy once the upload shows **Uploaded**.

## 3. Defaults for every TikTok post

Set these unless the user said otherwise, and list them in your summary so they can change any:

| Setting | Default |
|---|---|
| Who can see this post | **Everyone** |
| Comment | **on** |
| Reuse of content (Duet + Stitch) | **on** (only offered when ≤ 60 s) |
| Disclose post content | **on → "Your brand"** (the user promoting their own product or brand) |
| AI-generated content | **on** for anything libi generated or drew |
| When to post | Now (Schedule only when asked) |
| Sound | the piece's song from TikTok's library, from 0:00, under the whole video |
| Sound volume | **−8 dB** when there is narration; 0 dB when the song IS the audio; 1 s fade-out |

"Your brand" is right for libi's own promotional pieces and most users' own products. When the
piece plainly promotes SOMEONE ELSE's product for payment, that is "Branded content" instead — ask.
Never turn on TikTok's account-wide **automatic content checks** (a first-upload prompt): that is an
account setting, so answer it **Cancel**.

## 4. The run — in this order

Each numbered step is ONE `browser_run_code_unsafe` call where possible (see the reference for
the code); batching is what keeps this fast.

1. Navigate to the upload page; confirm "Select video".
2. Click **Select video** (`getByRole('button', { name: 'Select video', exact: true })`), then
   `browser_file_upload` with the copied path. The MCP intercepts the file chooser itself — a
   `waitForEvent('filechooser')` inside your own code never fires.
3. Dismiss first-run prompts: *Turn on automatic content checks?* → **Cancel**; *new editing
   features* / *Preview your video on your phone* tour → **Got it** (a tour overlay blocks every
   click until it is gone).
4. Caption (§5), while the upload runs.
5. Wait for the text **Uploaded** (a 4K file of 170–220 MB takes about a minute; a social export is fitted to 1080×1920 by default, far smaller), then **Show more** and
   the settings (§3).
6. Sound (§6).
7. Read back everything (§7), screenshot, and stop for the user's yes.

## 5. Caption

The description box is a Draft.js editor (`[contenteditable="true"]`, prefilled with the file name).
What works:
- Click it, `Meta+A`, `Backspace`, **wait ~600 ms** — text inserted straight after clearing is dropped.
- Each line with `keyboard.insertText(line)` then `Enter`; an empty line is just `Enter`.
- **Hashtags last, slowly:** `keyboard.type('#tag', { delay: 60 })`, wait **1.5 s**, `Space`. Inserted
  fast, the hashtag suggester eats whole tags.
- Read back `innerText` and compare with what you meant. Fix a dropped piece in place (select the
  text node range and `insertText`) rather than retyping everything.
- Reuse the caption the user approved (`libi.post_piece`'s or the social-music plan's), and fix any
  line the edit made untrue (after a cut: "4 lessons" → one).

## 6. Sound — adding the song

1. Click **Sounds** — exactly (`{ name: 'Sounds', exact: true }`; "Royalty-free sounds" in the sidebar
   also matches). It opens a full editor.
2. Search `"<title> <artist>"`, press Enter, and pick the row whose title and artist match; prefer
   the 1:00 clip and, when there are several masters, the one the original video used.
3. Its **+** adds the track at 0:00 under the whole video and opens the Audio panel: Volume (dB),
   Fade-in, Fade-out — set per §3, Enter after each.
4. **Save** (top right) returns to the form.
5. **Verify by reopening Sounds** — the track shows as `.AudioClip__title`; click the clip
   (`.AudioClip__root`, the title span does not take clicks) to re-read volume and fades, then
   **Cancel** out (no changes). The form's phone preview keeps saying "Original sound – <user>" even
   with the song saved: TikTok mixes it into the upload, so that label proves nothing either way.
6. No match for the song → say so before posting; never post without it silently.

## 7. Before Post — the user's yes

Read the form back in ONE call: caption `innerText`, each checkbox's state (`label.Checkbox__root`
`aria-checked`), the AI switch, Who can see. Take a screenshot of the form (and of the sound editor)
and show the user with every setting in a short list. Then **stop**.

**Click Post only when the user says, for THIS post, "post it"** (or equivalent) — the screenshot, a
caption or an earlier message is not that yes. TikTok has no undo; with the user's yes:
`getByRole('button', { name: 'Post', exact: true })`. Afterwards the page goes to
`/tiktokstudio/content`; the new post shows **"Content under review"** and **"Only me"** until review
clears (a few minutes), then **Everyone**. Say that, and that libi's Posting tab does not list a
browser post — it went straight to TikTok, not through the provider.

**Leaving the form open is leaving it armed.** The user may click Post themselves at any time; when
you return to the window, check `/tiktokstudio/content` before you change the form again.

## 8. Instagram — not from the web

Instagram's web uploader has **no music picker**: Reels music is mobile-app only, and the web can't
reach the in-app features. So:
- **Default: the API route** (`social-posting` → `libi.post_piece`), with the `social-music` plan
  (the platform's licensed copy when the account can attach one, otherwise the without-song cut).
- Never drive instagram.com to post. If the user wants the song on and the API cannot attach it, say
  so plainly: the remaining way today is the Instagram app on their phone.
- **Planned, not available yet:** libi will add a phone-emulator path so an agent can post through
  the Instagram mobile app, which has everything (music, covers, collabs). Mention it only when it
  explains why you can't do something now; never promise a date.

## 9. When it goes wrong

- **"Videos with commercial content can only be edited on the TikTok app."** Once TikTok tags a post
  as commercial (a brand in it is enough), the web can neither delete it nor change its privacy. The
  user does that in the app: profile → the video → ⋯ (or the share arrow) → **Delete**.
- A post went out wrong (no song, wrong cut) → it cannot be edited into the right one: the fix is
  delete (often app-only, above) and re-post. Say so before the user asks.
- An element "intercepts pointer events" → a tour or tooltip overlay is on top: dismiss it
  (**Got it** / **Cancel**) and retry; for checkboxes click the `label.Checkbox__root`, not the text.
- Any refusal, error dialog or unexpected page → screenshot, tell the user what you see, stop.

## Never

- Type a password, code or credential; change an account setting; turn on automatic checks.
- Click Post, Save draft or Discard on a form you did not just fill without the user's say-so.
- Post the without-song export to TikTok without adding the song when the plan called for one.
- Drive instagram.com to post.
