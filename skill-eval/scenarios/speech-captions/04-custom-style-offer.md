---
id: speech-captions-custom-style-offer
title: A reusable caption look is offered as a custom STYLE, not re-specified per caption
skills: [speech-captions, animated-text-overlays]
mcps: []
agent: claude-code
runs: 1
covers: [text-overlay, caption-style, create_caption_style, reusable-artifact]
---

## Prompt
I have a piece open. Give my captions a punchy pink look with a thick black outline —
and I'll probably want to reuse this exact look on other videos too.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Set the look through the caption STYLE/controller fields (pink `color`, a thick black
  `stroke`, and any background/shadow that reads as "punchy") on the caption text
  overlay(s) — NOT baked into a `code` overlay.
- BECAUSE the user signaled they want to reuse the look, offered (consent-first) to save
  it as a REUSABLE custom caption style via `libi.create_caption_style({ … })` — which
  persists and appears in the Style tab's custom list for any caption — instead of
  re-specifying the same color/stroke fields per caption every time.
- Did NOT just describe the look in prose or hardcode it; the deliverable is an applied,
  inspectable style plus the reusable-style offer.

## Inverse (judge reference — NOT the prompt)
If the user had asked for a one-off look with no reuse intent, simply setting the style
fields (without the create_caption_style offer) is acceptable — the offer is prompted by
the "reuse on other videos" signal.
