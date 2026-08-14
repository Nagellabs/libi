/**
 * Per-agent instruction dialect rendering.
 *
 * The single `mcp/templates/instructions.md` template carries dialect-conditional
 * blocks so CLAUDE.md (Claude Code wording) and AGENTS.md (Codex wording) can
 * diverge on the few mechanics that genuinely differ between agents (e.g. how a
 * skill is invoked). Everything shareable stays OUTSIDE the blocks and survives
 * both dialects — divergence is kept deliberately minimal.
 *
 * Block syntax (each marker on its own conceptual line — the marker lines are
 * stripped, only the inner content is kept for the matching dialect):
 *
 *   <!-- libi-agent:claude -->
 *   …claude-only wording…
 *   <!-- /libi-agent:claude -->
 *
 *   <!-- libi-agent:codex -->
 *   …codex-only wording…
 *   <!-- /libi-agent:codex -->
 *
 * A malformed template (unclosed / stray-close / nested / mismatched marker) is
 * a template-authoring bug and throws a descriptive Error (a lint at render
 * time). The function is pure and idempotent on marker-free text.
 */

export type AgentDialect = "claude" | "codex";

const OPEN_RE = /<!--\s*libi-agent:(claude|codex)\s*-->/;
const CLOSE_RE = /<!--\s*\/libi-agent:(claude|codex)\s*-->/;
// A single scanner regex that finds either an open or a close marker.
const MARKER_RE = /<!--\s*(\/?)libi-agent:(claude|codex)\s*-->/g;

/**
 * Render the template for one dialect: keep the matching dialect's block content
 * (markers stripped), drop the non-matching dialect's blocks entirely, and leave
 * unmarked text untouched.
 */
export function renderDialect(text: string, dialect: AgentDialect): string {
  MARKER_RE.lastIndex = 0;

  let result = "";
  let cursor = 0;
  // The dialect of the currently-open block, or null when at top level.
  let openDialect: AgentDialect | null = null;
  // Whether the currently-open block matches the requested dialect (keep) or not (drop).
  let keeping = true;

  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const isClose = m[1] === "/";
    const markerDialect = m[2] as AgentDialect;
    const before = text.slice(cursor, m.index);

    if (!isClose) {
      // Opening marker.
      if (openDialect !== null) {
        throw new Error(
          `renderDialect: nested libi-agent marker — '${markerDialect}' block opened inside an open '${openDialect}' block`,
        );
      }
      // Emit text before the opener only if we're at top level (always true here).
      result += before;
      openDialect = markerDialect;
      keeping = markerDialect === dialect;
    } else {
      // Closing marker.
      if (openDialect === null) {
        throw new Error(
          `renderDialect: stray closing libi-agent marker for '${markerDialect}' with no matching opener`,
        );
      }
      if (markerDialect !== openDialect) {
        throw new Error(
          `renderDialect: mismatched libi-agent marker — '${openDialect}' block closed by '${markerDialect}'`,
        );
      }
      // Emit the block body only when keeping this dialect.
      if (keeping) result += before;
      openDialect = null;
      keeping = true;
    }
    cursor = m.index + m[0].length;
  }

  if (openDialect !== null) {
    throw new Error(
      `renderDialect: unclosed libi-agent marker — '${openDialect}' block was never closed`,
    );
  }

  result += text.slice(cursor);
  return result;
}

// Re-exported for callers that want to detect whether a template even uses
// dialect blocks (unused today but keeps the marker syntax in one place).
export { OPEN_RE as DIALECT_OPEN_RE, CLOSE_RE as DIALECT_CLOSE_RE };
