/**
 * Client-safe SKILL.md frontmatter helpers shared by the skill detail page.
 *
 * The server (`mcp/skills/frontmatter.ts`) is the source of truth — it parses
 * the emitted YAML with `gray-matter` and re-validates on every write. These
 * helpers only build a body for submission and best-effort split one for
 * prefilling the form, so they stay dependency-free (no gray-matter on the
 * client bundle).
 */

function yamlEscape(value: string): string {
  // JSON encoding produces a valid YAML double-quoted scalar — safe for any
  // printable string (gray-matter / js-yaml parse JSON-style scalars + arrays).
  return JSON.stringify(value);
}

/**
 * Build the SKILL.md frontmatter block from the structured fields.
 *
 * `tags` is ALWAYS emitted (even when empty) because the content-update PATCH
 * derives the skill's tags from `frontmatter.tags` — omitting it would wipe
 * the tags on every save. Emitted as a YAML flow sequence: `tags: ["a", "b"]`.
 */
export function buildFrontmatter(
  name: string,
  description: string,
  whenToUse: string,
  tags: string[] = [],
): string {
  const lines = ["---"];
  lines.push(`name: ${yamlEscape(name)}`);
  lines.push(`description: ${yamlEscape(description)}`);
  if (whenToUse.trim()) lines.push(`when_to_use: ${yamlEscape(whenToUse)}`);
  const cleanTags = tags.map((t) => t.trim()).filter(Boolean);
  lines.push(`tags: [${cleanTags.map((t) => yamlEscape(t)).join(", ")}]`);
  lines.push("---");
  return lines.join("\n");
}

/** Assemble a full SKILL.md body from structured fields + markdown. */
export function buildSkillBody(
  name: string,
  description: string,
  whenToUse: string,
  tags: string[],
  markdown: string,
): string {
  return `${buildFrontmatter(name, description, whenToUse, tags)}\n\n${markdown}`;
}

export interface SplitSkillBody {
  name: string;
  description: string;
  whenToUse: string;
  markdown: string;
}

/**
 * Best-effort split of a SKILL.md body into (frontmatter-fields, markdown).
 * Used only for prefilling the edit form — the server re-validates on submit.
 * Tags are NOT read here; the detail page seeds them from the DB `tags` column.
 */
export function splitSkillBody(raw: string): SplitSkillBody {
  const fallback = { name: "", description: "", whenToUse: "", markdown: raw };
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return fallback;
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) return fallback;
  const frontmatterBlock = trimmed.slice(3, endIdx).trim();
  const rest = trimmed.slice(endIdx + 4).replace(/^\r?\n/, "");

  // Naive line parser for the JSON-encoded scalars buildFrontmatter emits.
  const fields: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      try {
        val = JSON.parse(val) as string;
      } catch {
        val = val.slice(1, -1);
      }
    }
    fields[key] = val;
  }

  return {
    name: fields.name ?? "",
    description: fields.description ?? "",
    whenToUse: fields.when_to_use ?? "",
    markdown: rest,
  };
}
