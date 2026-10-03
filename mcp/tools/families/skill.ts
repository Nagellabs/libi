import { z } from "zod/v3";
import {
  listSkills,
  addSkill,
  updateSkill,
  removeSkill,
  setSkillEnabled,
  listSkillPrompts,
  addSkillPrompt,
  updateSkillPrompt,
  removeSkillPrompt,
  setSkillsEnabledByTag,
  forkSkill,
  diffSkillOverride,
} from "@/mcp/tools/skill-tools";
import {
  listSkillsSchema,
  addSkillSchema,
  updateSkillSchema,
  removeSkillSchema,
  setSkillEnabledSchema,
  listSkillPromptsSchema,
  addSkillPromptSchema,
  updateSkillPromptSchema,
  removeSkillPromptSchema,
  setSkillsEnabledByTagSchema,
  forkSkillSchema,
  diffSkillOverrideSchema,
} from "@/mcp/tools/schemas";
import { action, sessionIdOf, type ActionToolDef } from "@/mcp/tools/action-tool";

const ctx = (extra: unknown) => ({ pieceId: "", sessionId: sessionIdOf(extra) });

export const skillTool: ActionToolDef = {
  name: "libi.skill",
  description:
    "Manage libi's skills (the playbooks agents load): list, install or edit a user skill, remove, fork a bundled skill, enable or disable one or a tag, diff an override against its bundled original, manage a skill's prompt files. Actions: list, add, update, remove, fork, enable, enable_by_tag, diff_override, list_prompts, add_prompt, update_prompt, remove_prompt.",
  // Differs per action in length/pattern, so the flat schema advertises the loosest form; each action still enforces its own.
  widen: { name: z.string().min(1) },
  props: {
    name: "Kebab-case, max 64. add/update: must equal the SKILL.md frontmatter `name`; diff_override: a bundled skill with a user override; *_prompt: the prompt file name without extension.",
    id: "Skill id from list (remove: a USER skill or an override; fork: the bundled skill to copy).",
    skillName: "The skill whose prompt files to list or edit (add/update/remove need a USER skill).",
    body: "Full markdown: add/update the complete SKILL.md with YAML frontmatter; *_prompt the prompt file.",
    description: "One-line description shown in the Settings UI.",
    enabled: "New enabled state (true enables, false disables).",
  },
  actions: {
    list: action({
      describe:
        "libi's view of registered skills (bundled + user) with enabled state (your live skill surface is authoritative: use this to diagnose mismatches). A fork carries `overridesBundled` and `bundledUpdatedSinceFork` (true = the original changed since): disclose it and offer diff_override, revert (remove the override) or merge (update). A user copy naming a merged-away skill carries `retiredSkillRefs`: libi never rewrites a user copy, so say so and offer to update it",
      schema: listSkillsSchema,
      run: (params, extra) => listSkills(ctx(extra), params),
    }),
    add: action({
      describe:
        "install a user skill (writes ~/.libi/skills/<name>/SKILL.md)",
      schema: addSkillSchema,
      run: (params, extra) => addSkill(ctx(extra), params),
    }),
    update: action({
      describe:
        "edit a skill's SKILL.md in place (a bundled skill gets a shadowing override). The session reloads and the in-flight prompt is cancelled: end your turn and ask the user to re-send",
      schema: updateSkillSchema,
      run: (params, extra) => updateSkill(ctx(extra), params),
    }),
    remove: action({
      describe:
        "delete a user skill or an override (restoring the bundled one); bundled skills cannot be deleted (enable disables them). The session reloads afterwards: end your turn",
      schema: removeSkillSchema,
      run: (params, extra) => removeSkill(ctx(extra), params),
    }),
    fork: action({
      describe:
        "copy a bundled skill (SKILL.md + prompts) into an editable user copy that shadows it; use before editing a bundled skill or its prompts",
      schema: forkSkillSchema,
      run: (params, extra) => forkSkill(ctx(extra), params),
    }),
    enable: action({
      describe: "toggle one skill; a disabled skill is not surfaced to agents but is kept",
      schema: setSkillEnabledSchema,
      run: (params, extra) => setSkillEnabled(ctx(extra), params),
    }),
    enable_by_tag: action({
      describe: "enable or disable every skill with ANY of `tags` (e.g. all `ugc`)",
      schema: setSkillsEnabledByTagSchema,
      run: (params, extra) => setSkillsEnabledByTag(ctx(extra), params),
      notes: { enabled: "applies to every skill matching `tags`." },
    }),
    diff_override: action({
      describe:
        "compare a forked skill with its bundled original: `upstreamChanged`, `changedFiles` and the SKILL.md as base (at fork time), currentBundled and userCopy. Use when list says bundledUpdatedSinceFork, to propose keep, revert or merge",
      schema: diffSkillOverrideSchema,
      run: (params, extra) => diffSkillOverride(ctx(extra), params),
    }),
    list_prompts: action({
      describe: "list a skill's prompts/*.md (bundled or user)",
      schema: listSkillPromptsSchema,
      run: (params, extra) => listSkillPrompts(ctx(extra), params),
    }),
    add_prompt: action({
      describe:
        "add prompts/<name>.md to a USER skill (bundled ones are read-only: fork first) for its SKILL.md to reference",
      schema: addSkillPromptSchema,
      run: (params, extra) => addSkillPrompt(ctx(extra), params),
    }),
    update_prompt: action({
      describe: "replace the contents of an existing prompts/<name>.md on a USER skill",
      schema: updateSkillPromptSchema,
      run: (params, extra) => updateSkillPrompt(ctx(extra), params),
    }),
    remove_prompt: action({
      describe: "delete prompts/<name>.md from a USER skill",
      schema: removeSkillPromptSchema,
      run: (params, extra) => removeSkillPrompt(ctx(extra), params),
    }),
  },
};
