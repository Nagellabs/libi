/**
 * The selectable Satori "blocking diagram" render body (labeled outlined boxes
 * driven by `context.blocks`). No longer the create-time default — see
 * `DEFAULT_ROUGH_RENDER` — but retained so a slot can opt into a boxes layout.
 *
 * Kept in one place so the bootstrap tool and the skill documentation can't drift.
 */
export const DEFAULT_BLOCK_DRIVEN_RENDER = `// render.jsx — satori unit body. Returns an element built with the injected \`h\`.
const { width, height, blocks = [], camera = {} } = context;
const pct = (n) => \`\${(n * 100).toFixed(2)}%\`;

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
}, \`\${camera.shot || "medium"}\${camera.motion ? " · " + camera.motion : ""}\`);

return h("div", {
  style: {
    width: "100%", height: "100%", position: "relative",
    display: "flex", background: "#f1f3f4",
  },
}, [...boxes, caption]);
`;

/**
 * The default render unit written by `addStoryboardCard` / `addSketch` when a slot
 * is created from scratch: a minimal canvas+rough "sketch scaffold" (paper fill +
 * a faint rough horizon line). It renders immediately so the card is never blank;
 * the agent then refines this start slot into a full scene illustration by editing
 * the unit file (the existing refine-by-editing flow). See the `using-storyboard`
 * skill (`prompts/rough-illustration-unit.md`) for the illustration style + API.
 *
 * Kept here in one place so the bootstrap tool and the skill docs can't drift.
 */
export const DEFAULT_ROUGH_RENDER = `// render.js — canvas unit body. Draws onto \`ctx\`; \`rough\` + \`INK\`/\`GRAYS\` injected.
const { ctx, rough, width, height } = context;
// paper background
ctx.fillStyle = "#f3f1ec";
ctx.fillRect(0, 0, width, height);
// faint rough horizon — orientation for the empty sketch canvas
rough.line(width * 0.06, height * 0.62, width * 0.94, height * 0.62, {
  stroke: "#b6b1a8",
  strokeWidth: 2,
  roughness: 2.2,
});
`;
