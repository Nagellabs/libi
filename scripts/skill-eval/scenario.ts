import matter from "gray-matter";
import yaml from "js-yaml";
import type { Matcher, ParsedScenario } from "./types";

/** Extract the body of a "## <heading>" section up to the next "## " or EOF. */
function sectionBody(markdown: string, heading: string): string | null {
  const re = new RegExp(`(^|\\n)##\\s+${heading}\\s*\\n`, "i");
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = /\n##\s+/.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Pull the first ```yaml ... ``` (or bare ``` ... ```) fenced block from a section. */
function fencedYaml(section: string): string | null {
  const m = /```(?:yaml)?\s*\n([\s\S]*?)```/.exec(section);
  return m ? m[1] : null;
}

function asStringArray(v: unknown, field: string, path: string): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v];
  throw new Error(`Scenario ${path}: frontmatter "${field}" must be a string or array`);
}

export function parseScenario(markdown: string, sourcePath: string): ParsedScenario {
  const { data, content } = matter(markdown);

  const id = data.id;
  if (!id || typeof id !== "string") {
    throw new Error(`Scenario ${sourcePath}: frontmatter "id" is required`);
  }
  const title = typeof data.title === "string" ? data.title : id;
  const skills = asStringArray(data.skills ?? [], "skills", sourcePath);
  const mcps = asStringArray(data.mcps ?? [], "mcps", sourcePath);
  const agents = asStringArray(data.agent ?? "claude-code", "agent", sourcePath);
  const covers = asStringArray(data.covers ?? [], "covers", sourcePath);
  const runs = Number.isInteger(data.runs) && data.runs > 0 ? data.runs : 1;
  const timeoutSec =
    Number.isInteger(data.timeoutSec) && data.timeoutSec > 0 ? data.timeoutSec : 300;
  const falStrict = data.falStrict === true;

  const prompt = sectionBody(content, "Prompt");
  if (!prompt) {
    throw new Error(`Scenario ${sourcePath}: a "## Prompt" section is required`);
  }

  let assertions: Matcher[] = [];
  const invSection = sectionBody(content, "Hard invariants");
  if (invSection) {
    const block = fencedYaml(invSection);
    if (block) {
      let parsed: unknown;
      try {
        parsed = yaml.load(block);
      } catch (err) {
        throw new Error(
          `Scenario ${sourcePath}: malformed yaml in the assertions block: ${(err as Error).message}`
        );
      }
      const list = (parsed as { assertions?: unknown })?.assertions;
      if (list !== undefined) {
        if (!Array.isArray(list)) {
          throw new Error(`Scenario ${sourcePath}: "assertions" must be a list`);
        }
        assertions = list as Matcher[];
      }
    }
  }

  let behavior: string[] = [];
  const behSection = sectionBody(content, "Behavioral expectations");
  if (behSection) {
    behavior = behSection
      .split("\n")
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter((l) => l.length > 0);
  }

  return {
    id,
    title,
    skills,
    mcps,
    agents,
    runs,
    timeoutSec,
    falStrict,
    covers,
    prompt,
    assertions,
    behavior,
    sourcePath,
  };
}
