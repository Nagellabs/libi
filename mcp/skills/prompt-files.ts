import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod/v3";

/** A prompt file relative to its skill folder, e.g. `prompts/hook.md`. */
export interface PromptFile {
  relPath: string;
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const promptNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => NAME_RE.test(v), "Prompt name must be kebab-case (a-z, 0-9, -) with no slashes");

function promptsDir(skillDir: string): string {
  return path.join(skillDir, "prompts");
}

/** List `prompts/*.md` under a skill dir (non-recursive), sorted by name. */
export function readPromptFiles(skillDir: string): PromptFile[] {
  const dir = promptsDir(skillDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      relPath: `prompts/${name}`,
      body: fs.readFileSync(path.join(dir, name), "utf-8"),
    }));
}

/** Atomically write `prompts/<name>.md` under the skill dir. */
export function writePromptFile(skillDir: string, name: string, body: string): void {
  promptNameSchema.parse(name);
  const dir = promptsDir(skillDir);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${name}.md`);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, finalPath);
}

export function promptFileExists(skillDir: string, name: string): boolean {
  promptNameSchema.parse(name);
  return fs.existsSync(path.join(promptsDir(skillDir), `${name}.md`));
}

/** Remove `prompts/<name>.md`; prune the `prompts/` dir if now empty. */
export function removePromptFile(skillDir: string, name: string): void {
  promptNameSchema.parse(name);
  const dir = promptsDir(skillDir);
  fs.rmSync(path.join(dir, `${name}.md`), { force: true });
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
