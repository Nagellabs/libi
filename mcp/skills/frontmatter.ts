import matter from "gray-matter";
import { z } from "zod/v3";
import type { SkillFrontmatter } from "./types";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export const frontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64, "Skill name must be 64 chars or fewer")
      .refine(
        (v) => NAME_RE.test(v),
        'Skill name must be kebab-case (lowercase letters, digits, hyphens) — e.g. "my-cool-skill"',
      ),
    description: z.string().min(1),
    when_to_use: z.string().optional(),
    "disable-model-invocation": z.boolean().optional(),
    "allowed-tools": z.array(z.string()).optional(),
    "argument-hint": z.string().optional(),
    paths: z.array(z.string()).optional(),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    context: z.string().optional(),
    agent: z.string().optional(),
    tags: z
      .preprocess((v) => {
        if (v == null) return [];
        if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
        if (typeof v === "string")
          return v.split(",").map((s) => s.trim()).filter(Boolean);
        return [];
      }, z.array(z.string()))
      .default([]),
  })
  .passthrough();

export function parseSkillBody(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!raw.trimStart().startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");
  }
  const parsed = matter(raw);
  const result = frontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.length > 0 ? String(issue.path[0]) : null;
    const prefix = field ? `${field}: ` : "";
    throw new Error(`${prefix}${issue.message}`);
  }
  return { frontmatter: result.data as SkillFrontmatter, body: parsed.content };
}

export function serializeSkillBody(frontmatter: SkillFrontmatter, body: string): string {
  return matter.stringify(body.trimStart(), frontmatter);
}
