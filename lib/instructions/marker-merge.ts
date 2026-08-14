/**
 * Marker-section merge for instruction files written into a CONNECTED
 * (external, user-owned) agent dir. Libi owns only the bracketed section;
 * everything the user wrote outside it survives every regeneration.
 *
 * Same bracketed-section pattern libi uses for its other marker-merged files.
 * Marker names are distinct from the libi-instructions / libi-memories
 * markers that live INSIDE the generated instructions, so nesting is safe.
 */
export const AGENT_MARKER_START = "<!-- libi-agent-start -->";
export const AGENT_MARKER_END = "<!-- libi-agent-end -->";

export function mergeMarkerSection(
  existing: string | null,
  section: string,
  start: string = AGENT_MARKER_START,
  end: string = AGENT_MARKER_END,
): string {
  const block = `${start}\n${section.trim()}\n${end}`;
  if (existing === null || existing.trim() === "") {
    return `${block}\n`;
  }
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return (
      existing.slice(0, startIdx) + block + existing.slice(endIdx + end.length)
    );
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}
