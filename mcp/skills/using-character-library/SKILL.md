---
name: using-character-library
description: "Catalog and reuse recurring characters and items across pieces: when the user asks about a person or product by name, or analysis surfaces a subject worth saving. Covers when to suggest saving, disambiguation, and linking assets."
---

# Using the character and item library

libi keeps a cross-piece catalogue of **characters** (people and figures, real or fictional) and **items**
(products, props, recurring set pieces). Both have the same shape and the same actions (`list`, `get`, `create`,
`update`, `delete`, `link`, `unlink`) on two tools: `libi.character` for characters, `libi.catalog_item` for items; if the subject talks or has
agency it is a character. A character's voice sample (a clean audio file) is linked like any asset with `libi.character({ action: "link", characterId, fileId })`, so the same voice carries to other pieces. It applies to every kind of video, not just product ads.

Be proactive in both directions: catalogue central recurring subjects as you find them, and bring up existing
entries when they are relevant, without waiting for "do we have a Jessica already?".

## Rules

- **Central recurring subjects are saved without asking; unclear ones are asked.** Save when a subject is plainly
  the recurring focus (the presenter, the advertised product, a named character who reappears). Ask when it
  is genuinely unclear whether the user wants it kept, for example someone who appears once.
- **Never catalogue background noise.** One-off extras, generic objects the user has shown no interest in, and
  strangers' faces in a busy frame stay out whatever your confidence. This is a quality and privacy guard.
- **Check before creating.** Names are unique within a catalogue (a character and an item may share one), so
  `libi.character({ action: "list", query })` / `libi.catalog_item({ action: "list", query })` first; the subject may already exist.
- **Show the representative image after creating**, so the user can confirm the right region was cropped, with
  one short line ("Cataloged **Jessica** as a recurring character; reuse her any time"). Create from an
  analysis frame you already have: `fromAsset: { fileId, bbox, frameTime? }`.
- **Deleting a catalogue entry keeps the files.** `deleteAssets: true` also deletes every linked file and needs
  the user's explicit confirmation first.

## When to look

- **After an analysis pass**, review the names you set (`people[].name`, `subjects[].name`) and apply the rules
  above to each.
- **At the start of a piece**, when the brief mentions a person or product that might be cataloged ("the same
  guy as last time"), search by name or description and offer a match inline (image, name, one line of context)
  as the reference or seed for generation, or to link to a piece asset. If they decline, carry on with a fresh
  subject. Use `representativeImageUrl` as the reference image.
- **"Use Jessica in this piece":** one match, use it; several, show a numbered list with each image and a short
  description and ask which; none, say so and offer to create one from a video or image they provide.
- **A tracked subject** that is a catalogue entry: pass its `subjectId` to `libi.track` action `compute`
  (`using-object-tracking`).
