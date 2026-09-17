"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  InstallSkillError,
  useInstallSkill,
  useUpdateSkill,
  type EffectiveSkill,
  type SkillFieldError,
} from "@/lib/queries/skills";
import { buildSkillBody, splitSkillBody } from "@/lib/skills/skill-frontmatter";
import { SkillBody } from "./skill-body";

type FieldErrors = Partial<Record<SkillFieldError | "general", string>>;

interface Props {
  mode: "view" | "create";
  skill?: EffectiveSkill;
  /** Auto-enter edit mode on mount (from ?edit=1 or the Override action). */
  initialEdit?: boolean;
  /** Returns the editable user-row id, forking a bundled skill first if needed. */
  ensureOverride: () => Promise<string>;
  /** create mode: after a successful install. */
  onCreated?: (name: string) => void;
  /** create mode: cancel returns to the list. */
  onCancel?: () => void;
  /** Select an in-skill file (OVERVIEW_KEY or a prompt relPath) from a body reference. */
  onOpenRef?: (key: string) => void;
}

const NEW_MARKDOWN = `# My Skill

Step-by-step instructions the agent will follow when this skill matches.

1. First step.
2. Second step.
`;

export function SkillOverviewPane({
  mode,
  skill,
  initialEdit,
  ensureOverride,
  onCreated,
  onCancel,
  onOpenRef,
}: Props) {
  const install = useInstallSkill();
  const update = useUpdateSkill();

  const isCreate = mode === "create";
  const isBundled = skill?.source === "bundled";
  // Name is locked whenever the skill has a bundled origin (its frontmatter
  // name must keep matching). Pure user skills and new skills allow renaming.
  const nameLocked = !isCreate && (isBundled || Boolean(skill?.overriddenFromBundled));

  const [editing, setEditing] = useState(isCreate || Boolean(initialEdit));
  const [seeded, setSeeded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [whenToUse, setWhenToUse] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState(isCreate ? NEW_MARKDOWN : "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  function seedFromSkill(s: EffectiveSkill) {
    const split = splitSkillBody(s.body ?? "");
    setName(split.name || s.name);
    setDescription(split.description || s.description);
    setWhenToUse(split.whenToUse);
    setTags(s.tags);
    setMarkdown(split.markdown);
  }

  // Seed the editable fields once when we're editing an existing skill and the
  // data is ready (covers the ?edit=1 / "Override" deep-link, where the pane
  // mounts already in edit mode). The `seeded` guard prevents a background
  // refetch from clobbering in-progress edits.
  useEffect(() => {
    if (isCreate || seeded || !editing || !skill) return;
    seedFromSkill(skill);
    setSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, seeded, skill, isCreate]);

  function enterEdit() {
    if (skill) seedFromSkill(skill);
    setSeeded(true);
    setErrors({});
    setEditing(true);
  }

  function cancel() {
    setErrors({});
    setSeeded(false);
    if (isCreate) {
      onCancel?.();
      return;
    }
    setEditing(false);
  }

  async function save() {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = "Name is required";
    if (!description.trim()) next.description = "Description is required";
    if (!markdown.trim()) next.body = "SKILL.md body is required";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    const fullBody = buildSkillBody(name.trim(), description.trim(), whenToUse, tags, markdown);
    try {
      if (isCreate) {
        await install.mutateAsync({ name: name.trim(), description: description.trim(), body: fullBody });
        onCreated?.(name.trim());
        return;
      }
      const targetId = await ensureOverride();
      await update.mutateAsync({
        id: targetId,
        name: name.trim(),
        description: description.trim(),
        body: fullBody,
      });
      setEditing(false);
    } catch (e) {
      if (e instanceof InstallSkillError && e.field) {
        setErrors({ [e.field]: e.message });
      } else {
        setErrors({ general: (e as Error).message });
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- VIEW MODE ---------------------------------------------------------
  if (!editing && skill) {
    const split = splitSkillBody(skill.body ?? "");
    return (
      <div className="flex h-full min-h-0 flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">SKILL.md</h2>
          <Button size="sm" className="cursor-pointer" onClick={enterEdit}>
            {isBundled ? "Override & Edit" : "Edit"}
          </Button>
        </div>

        <dl className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
          <Field label="Name">{skill.name}</Field>
          <Field label="Description">{skill.description}</Field>
          {split.whenToUse && <Field label="When to use">{split.whenToUse}</Field>}
          <div className="grid grid-cols-[120px_1fr] gap-2">
            <dt className="text-muted-foreground">Tags</dt>
            <dd className="flex flex-wrap gap-1">
              {skill.tags.length === 0 ? (
                <span className="text-muted-foreground/60 italic">none</span>
              ) : (
                skill.tags.map((t) => (
                  <Badge key={t} variant="secondary">
                    {t}
                  </Badge>
                ))
              )}
            </dd>
          </div>
        </dl>

        {isBundled && (
          <p className="text-xs text-muted-foreground">
            Bundled skill — read-only. Editing creates an editable override copy.
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Label className="text-xs text-muted-foreground">Body</Label>
          <SkillBody
            text={split.markdown}
            prompts={skill.prompts}
            onOpenRef={onOpenRef}
            className="min-h-0 flex-1 overflow-auto"
          />
        </div>
      </div>
    );
  }

  // ---- EDIT / CREATE MODE ------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{isCreate ? "New skill" : "SKILL.md"}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="cursor-pointer" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" className="cursor-pointer" onClick={() => void save()} disabled={saving}>
            {saving ? (isCreate ? "Creating…" : "Saving…") : isCreate ? "Create" : "Save"}
          </Button>
        </div>
      </div>

      {isBundled && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Saving will create an editable override of this bundled skill.
        </p>
      )}

      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <Label htmlFor="ov-name">Name (kebab-case, ≤64 chars)</Label>
          <Input
            id="ov-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((p) => ({ ...p, name: undefined, general: undefined }));
            }}
            placeholder="my-skill"
            className="font-mono text-sm"
            disabled={nameLocked}
            aria-invalid={errors.name ? true : undefined}
          />
          {nameLocked && (
            <p className="text-xs text-muted-foreground">
              Name is locked — it must match the bundled skill it overrides.
            </p>
          )}
          {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="ov-desc">Description</Label>
          <Input
            id="ov-desc"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors((p) => ({ ...p, description: undefined, general: undefined }));
            }}
            placeholder="One-sentence description shown in the Settings UI."
            aria-invalid={errors.description ? true : undefined}
          />
          {errors.description && <p className="text-sm text-destructive">{errors.description}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="ov-when">When to use (optional)</Label>
          <Input
            id="ov-when"
            value={whenToUse}
            onChange={(e) => setWhenToUse(e.target.value)}
            placeholder="Triggers when the user asks to ..."
          />
        </div>

        <div className="space-y-2">
          <Label>Tags</Label>
          <TagEditor tags={tags} onChange={setTags} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <Label htmlFor="ov-body">SKILL.md body</Label>
        <textarea
          id="ov-body"
          value={markdown}
          onChange={(e) => {
            setMarkdown(e.target.value);
            setErrors((p) => ({ ...p, body: undefined, general: undefined }));
          }}
          className="w-full min-h-[200px] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-invalid={errors.body ? true : undefined}
        />
        {errors.body && <p className="text-sm text-destructive">{errors.body}</p>}
        <p className="text-xs text-muted-foreground">
          The YAML frontmatter (name, description, when-to-use, tags) is generated from the fields above.
        </p>
      </div>

      {errors.general && <p className="text-sm text-destructive">{errors.general}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [value, setValue] = useState("");
  function add() {
    const t = value.trim().toLowerCase();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setValue("");
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <Badge key={t} variant="secondary" className="gap-1">
          {t}
          <button
            type="button"
            className="cursor-pointer"
            aria-label={`Remove tag ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </Badge>
      ))}
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder="+ tag"
        className="h-6 w-20 text-xs"
      />
    </div>
  );
}
