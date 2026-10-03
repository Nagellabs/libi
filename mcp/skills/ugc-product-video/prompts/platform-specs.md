# Platform specs

Pull the target aspect ratio and safe zones from here when framing the project; confirm against the platform's own current docs for a paid placement.

| Platform | Aspect and size | Length | Notes |
| --- | --- | --- | --- |
| TikTok | 9:16, 1080×1920 | ads 9 to 60 s (organic to 10 min); UGC sweet spot 15 to 30 s | Hook in 3 s or less, so the first frame must work. Keep key text out of the bottom 18% and top 8%. Assume sound on; captions still matter. |
| Instagram Reels | 9:16, 1080×1920 | 15 to 90 s; sweet spot 15 to 30 s | Hook in 3 s or less. Bottom 20% and top 10% are covered by UI. Author your own captions for style and placement. |
| YouTube Shorts | 9:16, 1080×1920 | up to 60 s | Hook in 3 s or less. No end screens on Shorts: bake the CTA into the final beat. |
| Square (Meta in-feed, LinkedIn) | 1:1, 1080×1080 | 5 to 30 s paid, up to 60 s organic | |
| Landscape (YouTube pre-roll, web display) | 16:9, 1920×1080 | 6 s bumper, 15 s, 30 s slots | About 5 s before the skip button. |

Whatever the platform: captions are text overlays (`libi.add_overlay({ kind: "text" })`) so they are crisp and styled, never the platform's auto-captions; loudness around -14 LUFS; treat the first frame as the thumbnail, since it is the only frame guaranteed to be seen.
