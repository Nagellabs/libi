import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import { loadBundledTemplate } from "@/lib/instructions/bundled-template";
import { readInstructionsOverride } from "@/lib/instructions/override";
import { readMemories } from "@/lib/instructions/memories";
import { renderDialect, type AgentDialect } from "@/lib/instructions/dialect";

const START_MARKER = "<!-- libi-instructions-start";
const END_MARKER = "<!-- libi-instructions-end -->";
const MEMORIES_START = "<!-- libi-memories-start -->";
const MEMORIES_END = "<!-- libi-memories-end -->";

/**
 * The full test-mode banner, injected into the FULL manual (`getInstructions`).
 */
export const TEST_MODE_BANNER = `
> 🧪 **TEST MODE ACTIVE** — \`LIBI_TEST_MODE=1\` is set. The \`fal-ai\` MCP
> is present but runs as a sandboxed fake: it exposes the real fal tool surface
> (\`recommend_model\`, \`run_model\`, \`submit_job\`, etc.) but returns
> deterministic ffmpeg placeholder files at zero cost. The \`elevenlabs\` MCP is
> ALSO a sandboxed fake of ElevenLabs' hosted creative tools
> (\`creative_list_voices\`, \`creative_generate_speech\`,
> \`creative_generate_in_flow\`, \`creative_get_flow_run_status\`, uploads and
> transcription): runs and polls work as they do there, and the output URLs serve
> deterministic placeholder audio/transcripts at zero cost (no sign-in needed).
> The \`zernio\` MCP is a sandboxed fake too: the same curated tool surface, an
> in-memory store, and nothing ever reaches a real social account. Its curated
> convenience tools answer prose and its full REST surface is reached through
> \`call_tool\`, exactly as the real server behaves.
> This is a development environment for testing libi itself — do NOT promise the
> user "real" AI output, and never tell them a post actually went out. Use the
> normal \`fal-ai\` / \`elevenlabs\` / \`zernio\` tools as you would in
> production; the placeholder outputs confirm the pipeline end-to-end without
> spending credits.
`;

/**
 * Claude Code truncates a server's `instructions` at this many characters.
 * Everything `renderInstructionsCore` returns has to fit inside it.
 */
export const INSTRUCTIONS_CORE_CAP = 2048;

/**
 * How much of that cap must stay unspent, asserted by
 * `__tests__/unit/mcp/instructions-core.test.ts`.
 *
 * The point is that the budget is visible BEFORE it is blown. The core plus
 * the test-mode banner used to leave 68 characters — one added sentence from
 * silent truncation, with nothing failing until it happened. 150 is the floor;
 * the actual slack today is comfortably above it, which is the state to keep.
 */
export const INSTRUCTIONS_CORE_MIN_SLACK = 150;

/**
 * The same fact as `TEST_MODE_BANNER`, condensed for the TIERED instructions
 * core (`renderInstructionsCore`) — the full version does not fit in what is
 * left of `INSTRUCTIONS_CORE_CAP`. It carries the one thing the agent must not
 * get wrong (the output is a placeholder, not real AI) and defers the detail
 * to `libi.read_manual`.
 *
 * Every word here is one the instructions cannot spend elsewhere. Naming a
 * THIRD fake (`zernio`) took the slack to 3 characters over the floor, which
 * is the state this assertion exists to prevent — so the wording was cut back
 * at the same time, and now leaves MORE room than the two-fake version did.
 *
 * Built from the fakes ACTUALLY attached, and `null` when there are none: a
 * skill-eval scenario with `mcps: []` gets no fake fal and no fake ElevenLabs
 * (`POST /api/skill-eval/configure`), and announcing tools the agent does not
 * have is precisely what the `_meta/no-provider` scenario exists to catch.
 */
export function testModeCoreBanner(fakeNames: readonly string[]): string | null {
  if (fakeNames.length === 0) return null;
  // `a`, `b` and `c` — the Oxford comma is dropped on purpose: the core is
  // rendered into a 2,048-character budget and every character here is one the
  // instructions cannot spend elsewhere (INSTRUCTIONS_CORE_MIN_SLACK).
  const quoted = fakeNames.map((n) => `\`${n}\``);
  const names = quoted.length <= 2 ? quoted.join(" and ") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  const verb = fakeNames.length === 1 ? "is a sandboxed fake" : "are sandboxed fakes";
  return (
    `> 🧪 **TEST MODE** — ${names} ${verb}: real tool surface, ` +
    `placeholder output, zero cost. Never promise real AI output.`
  );
}

/** Active template: the user's override when present, else the bundled one. */
function resolveTemplate(): string {
  return readInstructionsOverride() ?? loadBundledTemplate();
}

/**
 * Build the full instruction block for a given agent dialect. The template is
 * rendered for the dialect FIRST (`claude` → CLAUDE.md, `codex` → AGENTS.md),
 * then the dialect-NEUTRAL injections run unchanged: the TEST MODE banner and
 * the memories section are identical in both files.
 *
 * Reads `~/.libi/memories.md` and inlines it between the memories markers as a
 * `## Memories` section. If an override removed the markers, memories are
 * injected before the end marker, or appended at the very end — never silently
 * dropped. A marker-free user override renders identically for both dialects.
 */
export function getInstructions(dialect: AgentDialect = "claude"): string {
  let working = renderDialect(resolveTemplate(), dialect);

  if (isTestMode()) {
    // Inject banner right after the START_MARKER line so it's visible early —
    // before the body sections so the agent reads it before any tool docs.
    const startIdx = working.indexOf(START_MARKER);
    if (startIdx !== -1) {
      const lineEnd = working.indexOf("\n", startIdx);
      if (lineEnd !== -1) {
        working =
          working.slice(0, lineEnd + 1) + TEST_MODE_BANNER + "\n" + working.slice(lineEnd + 1);
      } else {
        working = TEST_MODE_BANNER + "\n" + working;
      }
    } else {
      // Marker missing (unexpected) — prepend
      working = TEST_MODE_BANNER + "\n" + working;
    }
  }

  const trimmed = readMemories().trim();
  if (trimmed.length === 0) return working;

  const block = `${MEMORIES_START}\n\n## Memories\n\n${trimmed}\n\n${MEMORIES_END}`;
  const startIdx = working.indexOf(MEMORIES_START);
  const endIdx = working.indexOf(MEMORIES_END);
  if (startIdx !== -1 && endIdx !== -1) {
    return working.slice(0, startIdx) + block + working.slice(endIdx + MEMORIES_END.length);
  }
  if (working.includes(END_MARKER)) {
    return working.replace(END_MARKER, `${block}\n${END_MARKER}`);
  }
  logger.warn({ tag: "instructions", op: "memories_append_fallback" },
    "override template lost all markers; appending memories at end");
  return `${working}\n\n${block}\n`;
}

export function getInstructionContent(): string {
  const full = getInstructions();
  const lines = full.split("\n");
  const startLine = lines.findIndex((l) => l.startsWith(START_MARKER));
  const endLine = lines.findIndex((l) => l.trim() === END_MARKER);
  if (startLine !== -1 && endLine !== -1) {
    return lines.slice(startLine + 1, endLine).join("\n").trim();
  }
  return full;
}
