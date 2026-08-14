export type SkillSource = "bundled" | "user";

export interface SkillFrontmatter {
  name: string;
  description: string;
  when_to_use?: string;
  "disable-model-invocation"?: boolean;
  "allowed-tools"?: string[];
  "argument-hint"?: string;
  paths?: string[];
  model?: string;
  effort?: "low" | "medium" | "high";
  context?: string;
  agent?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
  body: string;
  frontmatter: SkillFrontmatter;
  supportingFiles: SkillSupportFile[];
  tags: string[];
}

export interface SkillSupportFile {
  relPath: string;
  contents: string | Buffer;
}
