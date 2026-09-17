import matter from "gray-matter";
import yaml from "js-yaml";
import { basename, isAbsolute, normalize, sep } from "node:path";
import type { Matcher, ParsedScenario } from "./types";
import { SHAREABLE, isShareable, type Shareable } from "./shared-deps";

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
  // See ParsedScenario.mcps (types.ts) for what the names mean; the configure
  // route validates them, the parser only normalizes.
  const mcps = asStringArray(data.mcps ?? [], "mcps", sourcePath);
  const agents = asStringArray(data.agent ?? "claude-code", "agent", sourcePath);
  const covers = asStringArray(data.covers ?? [], "covers", sourcePath);
  const runs = Number.isInteger(data.runs) && data.runs > 0 ? data.runs : 1;
  const timeoutSec =
    Number.isInteger(data.timeoutSec) && data.timeoutSec > 0 ? data.timeoutSec : 300;
  const falStrict = data.falStrict === true;
  // Validated HERE rather than at boot: a typo'd `share:` should fail the run
  // before anything is spawned, and the allowlist is what keeps this from
  // becoming "point the harness at any directory".
  const share = asStringArray(data.share ?? [], "share", sourcePath);
  for (const name of share) {
    if (!isShareable(name)) {
      throw new Error(
        `Scenario ${sourcePath}: "share" may only name ${SHAREABLE.join(" / ")}; got "${name}"`,
      );
    }
  }

  // Media fixtures, validated here for the same reason `share` is: a typo'd path
  // should fail before anything is spawned. Repo-relative only — an absolute path, or one
  // that climbs out of the repo with `..`, is rejected, because a fixture list that can
  // name any file on the machine is a very different feature from a fixture list.
  const fixtures = asStringArray(data.fixtures ?? [], "fixtures", sourcePath);
  for (const rel of fixtures) {
    if (isAbsolute(rel)) {
      throw new Error(
        `Scenario ${sourcePath}: "fixtures" entries must be repo-relative; got absolute "${rel}"`,
      );
    }
    const resolved = normalize(rel);
    if (resolved.startsWith("..") || resolved.split(sep).includes("..")) {
      throw new Error(
        `Scenario ${sourcePath}: "fixtures" may not escape the repo with ".."; got "${rel}"`,
      );
    }
    if (basename(resolved) !== basename(rel) || basename(resolved).length === 0) {
      throw new Error(`Scenario ${sourcePath}: "fixtures" entry "${rel}" names no file`);
    }
  }

  // Default TRUE: without the pre-authorization preamble an unattended run stops at
  // the first "OK to generate?" and produces an empty trace. Setting it false is what lets
  // a scenario assert a paid call is ABSENT — see harness.ts#preambleFor.
  if (data.preauthorize !== undefined && typeof data.preauthorize !== "boolean") {
    throw new Error(`Scenario ${sourcePath}: frontmatter "preauthorize" must be a boolean`);
  }
  const preauthorize = data.preauthorize !== false;

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
    share: share as Shareable[],
    fixtures,
    preauthorize,
    covers,
    prompt,
    assertions,
    behavior,
    sourcePath,
  };
}
