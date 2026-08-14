import fs from "fs";
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

const TEST_MODE_BANNER = `
> 🧪 **TEST MODE ACTIVE** — \`LIBI_TEST_MODE=1\` is set. The \`fal-ai\` MCP
> is present but runs as a sandboxed fake: it exposes the real fal tool surface
> (\`recommend_model\`, \`run_model\`, \`submit_job\`, etc.) but returns
> deterministic ffmpeg placeholder files at zero cost. The \`ElevenLabs\` MCP is
> ALSO a sandboxed fake: \`text_to_speech\`, \`voice_clone\`, \`compose_music\`,
> \`text_to_sound_effects\`, \`isolate_audio\`, and \`speech_to_text\` return
> deterministic placeholder audio/transcripts at zero cost (no API key needed).
> This is a development environment for testing libi itself — do NOT promise the
> user "real" AI output. Use the normal \`fal-ai\` / \`ElevenLabs\` tools as you
> would in production; the placeholder outputs confirm the pipeline end-to-end
> without spending credits.
`;

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

export function parseInstructionVersion(content: string): string | null {
  const match = content.match(/<!-- libi-instructions-start v([\d.]+) -->/);
  return match ? match[1] : null;
}

export function upsertInstructions(filePath: string): void {
  const instructions = getInstructions();

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, instructions);
    return;
  }

  const existing = fs.readFileSync(filePath, "utf-8");
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const combined = (before + instructions + after).replace(/\n*$/, "\n");
    fs.writeFileSync(filePath, combined);
  } else {
    fs.appendFileSync(filePath, "\n\n---\n\n" + instructions);
  }
}
