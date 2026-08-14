---
name: using-character-library
description: Catalog and reuse recurring characters and items across pieces — when to suggest saving, how to disambiguate, and how to link assets.
when_to_use: When the user asks about a person/figure or product/item by name, or when analysis surfaces a recurring subject worth saving for later reuse.
---

# Using the Character & Item Library

Libi maintains a cross-piece **objects catalog** — "objects" here means both **characters** (people, figures, fictional or real) and **items** (objects, products, props). This is a general capability across every video type (UGC ads, music videos, narrative shorts, tutorials, anything) — it is not specific to product/UGC work. Characters and items have the same shape and the same set of MCP tools, just for different kinds of subjects.

You should be **proactive** in both directions: auto-catalog central recurring subjects as you find them during analysis (report inline, don't gate on asking first), and proactively surface existing catalog entries when they're relevant to what the user is doing — don't wait for the user to ask "do we have a Jessica already?"

## Core principles

1. **Central recurring subjects get auto-cataloged; ambiguous cases get asked.** Auto-create when a subject is clearly the recurring focus of the content (the presenter, the product being advertised, a named character who reappears). Ask first only when it's genuinely unclear whether the user wants this subject saved (e.g. a subject who appears once and might be a one-off).
2. **Never catalog background noise.** One-off extras, generic objects, and strangers in a busy frame stay out of the catalog regardless of how confident you are — this is a quality and privacy guard, not a judgment call to relax.
3. **Names are unique within each catalog.** Two characters can't both be named "Jessica", but a character "Jessica" and an item "Jessica" can coexist.
4. **Always show the representative image** after creating a character or item, so the user can confirm you cataloged the right region.

## Workflow: auto-catalog during analysis

After an analysis pass (frames described, summary saved), review the names you set — `people[].name` in `analysis_save_frames` entries, `subjects[].name` in `analysis_save_summary`. For each name that is a clearly-recurring CENTRAL subject of the video (not a background extra, not a generic object):

1. Call `list_characters({ query: "<the name>" })` (or `list_items` for a product/object) first — it may already exist.
2. **No match →** auto-create it — do not stop to ask "OK?" first. Call `create_character({ name, description, fromAsset: { fileId, bbox, frameTime? } })` (or `create_item`), cropping the representative image from a bbox frame you already have from analysis.
3. **Report inline, right after creating:**
   `![${name}](${response.character.representativeImageUrl})`
   followed by one short line, e.g. "Cataloged **Jessica** as a recurring character — reuse her any time." No need to ask for confirmation unless the crop looks obviously wrong to you.
4. **Genuinely ambiguous case** (e.g. a subject who appears once, or you're unsure if this is a real recurring figure vs. incidental) → ask instead of auto-creating: "I noticed <name> — want me to save them as a character for reuse?"
5. Skip entirely: one-off background extras, generic unbranded objects, strangers incidental to a busy frame (see "When NOT to catalog" below).

## Workflow: offer existing objects (agent-push reuse)

When starting or continuing a piece whose brief references a person or product that might already be cataloged — a name, a product description, "the same guy from last time" — don't wait for the user to ask. Proactively check:

1. Call `list_characters({ query: "<name or description fragment>" })` and/or `list_items({ query: "..." })`.
2. If there's a relevant match (or a few), surface it inline before proceeding — rep image + name + one line of context — and offer to reuse it: as a reference/seed image for generation, or to link directly to a piece asset via `link_character_to_asset` / `link_item_to_asset`. Example: "I already have **Jessica Wong** cataloged from an earlier piece — want me to use her as the reference for this generation? ![](.../content)"
3. If the user accepts, use the `representativeImageUrl` as the reference/seed, or link the asset. If they decline or want someone else, proceed with a fresh subject as normal.

This is agent-push: you surface the match as part of doing the work, not only in response to the user explicitly asking "do we have X already?"

## Workflow: user asks "use Jessica in this piece"

1. Call `list_characters({ query: "jessica" })`.
2. **One match** → use it directly. Call `link_character_to_asset` if linking to an existing piece asset, OR generate/import using the character's `representativeImageUrl` as a reference.
3. **Multiple matches** → render a numbered list with each rep image and brief description, ask user to pick. Example:
   ```
   I found 2 characters matching "Jessica":

   1. **Jessica Wong** — Blonde tennis player, often in workout attire
      ![](.../content)

   2. **Jessica K** — Brunette, casual office settings
      ![](.../content)

   Which one did you mean?
   ```
4. **Zero matches** → "I don't have a Jessica yet. Want me to create one from a video or image you'll provide?"

## Workflow: deletion

`delete_character({ id })` removes the catalog entry and all asset mappings — but leaves the actual files alone. To also delete linked files, pass `deleteAssets: true` AFTER explicit user confirmation.

## Items work identically

Use `list_items`, `create_item`, etc. Mental model: items are for products, props, branded objects, recurring set pieces. Characters are for people/figures. If the subject talks or has agency, it's a character.

## When NOT to catalog

- One-off background extras
- Generic objects the user hasn't expressed interest in (a generic "coffee cup" — vs a specific branded mug they're advertising)
- When the user asks for a one-shot edit and recurrence isn't suggested
- Faces of strangers visible in frame (privacy)

## Tools reference

**Characters:** `list_characters`, `get_character`, `create_character`, `update_character`, `delete_character`, `link_character_to_asset`, `unlink_character_from_asset`

**Items:** `list_items`, `get_item`, `create_item`, `update_item`, `delete_item`, `link_item_to_asset`, `unlink_item_from_asset`

All catalog tools live under the `libi.` MCP namespace.
