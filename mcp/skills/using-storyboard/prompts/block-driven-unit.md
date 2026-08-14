# Structured-default Tier-1 render unit (satori, block-driven)

Use this as the default content of a card's render-unit file (e.g. `render.jsx`,
`render: { kind: "satori" }`). It renders the card's **`context.blocks`** — so when the
user drags/resizes blocks in the in-app editor (which writes `card.blocks`), the
schematic regenerates from this unit and visibly updates. It uses only the injected
`h` hyperscript + `context` (`width`, `height`, `blocks`, `camera`) — no imports.

Each block's `rect` is normalized 0..1; we convert to `%` so layout is resolution-free.
The look is a clean schematic (labeled outlined boxes on a neutral frame), NOT a doodle —
that keeps it usable as a gpt-image-2 composition reference.

```js
// render.jsx — satori unit body. Returns an element built with the injected `h`.
const { width, height, blocks = [], camera = {} } = context;
const pct = (n) => `${(n * 100).toFixed(2)}%`;

const boxes = blocks.map((b) =>
  h("div", {
    style: {
      position: "absolute",
      left: pct(b.rect.x), top: pct(b.rect.y),
      width: pct(b.rect.w), height: pct(b.rect.h),
      border: "2px solid #9aa0a6",
      borderRadius: 6,
      display: "flex",
      alignItems: "flex-end",
      padding: 6,
      color: "#5f6368",
      fontSize: 16,
    },
  }, b.label || b.kind),
);

const caption = h("div", {
  style: {
    position: "absolute", left: 0, bottom: 0, width: "100%",
    display: "flex", justifyContent: "center", padding: 8,
    color: "#5f6368", fontSize: 16,
  },
}, `${camera.shot || "medium"}${camera.motion ? " · " + camera.motion : ""}`);

return h("div", {
  style: {
    width: "100%", height: "100%", position: "relative",
    display: "flex", background: "#f1f3f4",
  },
}, [...boxes, caption]);
```

Notes:
- Keep blocks structured (`kind`, `label`, `rect`, `z`) in `card.json` — that's what the
  konva editor edits and what this unit reads.
- For a scene that needs bespoke art the structured template can't express, switch the
  card to a `svg` or `canvas` unit and write custom code — but then the konva block
  editor won't drive the visual (custom units own their own drawing).
