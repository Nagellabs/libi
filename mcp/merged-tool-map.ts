/**
 * The manual's "merged tool map": one line per merged tool, naming its actions and (for the small
 * ones) the per-verb tools it replaced. It exists for the agent that looks for a VERB: on Codex the
 * tool name is the search key (the instructions are prefixed to every tool description, so a
 * description filter matches all of them), and `split_clip` / `delete_clip` became `libi.clip`, a name
 * that contains neither verb. The map routes "split" to `libi.clip` from the first `read_manual` call.
 *
 * Generated from `lib/agents/merged-tools.ts` (the same tables the chat labels and the analytics read),
 * so it cannot drift from the tools the server registers: `__tests__/unit/mcp/merged-tool-map.test.ts`
 * holds every merged tool to a line in the rendered section.
 *
 * Pure: data in, text out. The heading below is the section's key (`merged-tool-map`), listed in
 * `ESSENTIAL_SECTION_KEYS` so the no-argument `read_manual` inlines it.
 */
import {
  FOLDED_TOOL_FORMER_NAMES,
  MERGED_TOOL_DISCRIMINATORS,
  MERGED_TOOL_FORMER_NAMES,
  MERGED_TOOL_RISK,
  type MergedToolName,
} from "@/lib/agents/merged-tools";

export const MERGED_TOOL_MAP_HEADING = "Merged tool map";
export const MERGED_TOOL_MAP_KEY = "merged-tool-map";

/** A tool with this many actions or fewer lists the old names it replaced; a larger one does not,
 *  because its actions already read as the old verbs (`libi.skill` action `add_prompt`) and the full list
 *  would cost more than the lookup is worth. */
const FORMER_NAMES_UP_TO = 4;

/**
 * The everyday words that find a tool whose name does not contain them. Only where the noun alone would
 * not do: nobody searches "snapshot" to undo, "audio_duck" to lower the music, or "asset_folder" to group.
 */
export const MERGED_TOOL_MAP_GLOSS: Partial<Record<MergedToolName, string>> = {
  "libi.snapshot": "save, undo, go back, what changed",
  "libi.audio_duck": "lower the music under a voice",
  "libi.asset_folder": "group a piece's assets",
  "libi.piece_folder": "group pieces",
  "libi.clip": "cut, split, remove, copy a clip",
  "libi.audio_clip": "edit, split, remove an audio clip",
  "libi.layer_effect": "apply an effect to the layers below",
  "libi.storyboard_take": "pick or approve a generated take",
  "libi.extension": "repair an extension",
};

/** Natural reading order: what the tool does, not which actions read and which change. */
function actionsOf(tool: MergedToolName): string[] {
  const risk = MERGED_TOOL_RISK[tool];
  return [...risk.readOnly, ...risk.changes];
}

function lineFor(tool: MergedToolName): string {
  const actions = actionsOf(tool);
  const field = MERGED_TOOL_DISCRIMINATORS[tool];
  const formerNames = MERGED_TOOL_FORMER_NAMES[tool] as Record<string, string>;
  const former = actions.map((a) => formerNames[a]).filter((n): n is string => typeof n === "string");
  const by = field === "action" ? "" : ` (\`${field}\`)`;
  const was = actions.length <= FORMER_NAMES_UP_TO && former.length > 0 ? ` (was ${former.join(", ")})` : "";
  const gloss = MERGED_TOOL_MAP_GLOSS[tool];
  return `- \`${tool}\`${by} — ${actions.join(" | ")}${was}${gloss ? ` — ${gloss}` : ""}`;
}

/** The `## Merged tool map` section. Dialect-neutral: the Codex-only lookup advice is a marker block in the template. */
export function renderMergedToolMap(): string {
  const tools = Object.keys(MERGED_TOOL_DISCRIMINATORS) as MergedToolName[];
  const lines = tools.map(lineFor);
  for (const [tool, former] of Object.entries(FOLDED_TOOL_FORMER_NAMES)) {
    lines.push(`- \`${tool}\` — \`name\` and/or \`description\` in one call (was ${former.join(", ")})`);
  }

  const parts = [
    `## ${MERGED_TOOL_MAP_HEADING}`,
    "",
    "Related verbs are ONE tool: a noun, with the verb as its `action` argument (`target` on `show`, `kind` on `social_link`). " +
      "Find a verb here. `was …` names the per-verb tools a small tool replaced; they no longer exist.",
    "",
    ...lines,
  ];

  return parts.join("\n");
}
