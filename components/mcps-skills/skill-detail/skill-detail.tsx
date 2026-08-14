"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useSkillDetail,
  useToggleSkill,
  useForkSkill,
  useAddSkillPrompt,
  useDeleteSkill,
} from "@/lib/queries/skills";
import { SkillDetailSkeleton } from "./skill-detail-skeleton";
import { SkillFileSidebar, OVERVIEW_KEY } from "./skill-file-sidebar";
import { SkillOverviewPane } from "./skill-overview-pane";
import { SkillPromptPane } from "./skill-prompt-pane";

const SKILLS_LIST = "/mcps-skills?tab=skills";

type Props =
  | { name: string; initialEdit?: boolean; create?: undefined }
  | { create: true; name?: undefined; initialEdit?: undefined };

export function SkillDetail(props: Props) {
  const router = useRouter();
  if (props.create) return <CreateSkill router={router} />;
  return <ViewSkill name={props.name} initialEdit={props.initialEdit} />;
}

function BackLink() {
  return (
    <Link
      href={SKILLS_LIST}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      Back to Skills
    </Link>
  );
}

function CreateSkill({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-5 p-6">
      <BackLink />
      <div className="flex min-h-0 flex-1 flex-col">
        <SkillOverviewPane
          mode="create"
          ensureOverride={async () => {
            throw new Error("unreachable in create mode");
          }}
          onCreated={(name) => router.push(`/mcps-skills/skills/${encodeURIComponent(name)}`)}
          onCancel={() => router.push(SKILLS_LIST)}
        />
      </div>
    </div>
  );
}

function ViewSkill({ name, initialEdit }: { name: string; initialEdit?: boolean }) {
  const { data: skill, isLoading } = useSkillDetail(name);
  const toggle = useToggleSkill();
  const fork = useForkSkill();
  const addPrompt = useAddSkillPrompt();
  const del = useDeleteSkill();
  const [selected, setSelected] = useState<string>(OVERVIEW_KEY);
  const [confirmRestore, setConfirmRestore] = useState(false);

  if (isLoading) return <SkillDetailSkeleton />;

  if (!skill) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
        <BackLink />
        <p className="text-sm text-muted-foreground">No skill named &ldquo;{name}&rdquo;.</p>
      </div>
    );
  }

  async function ensureOverride(): Promise<string> {
    if (!skill) throw new Error("Skill not loaded");
    if (skill.source === "user") return skill.id;
    const res = await fork.mutateAsync(skill.id);
    return res.id;
  }

  async function handleAddPrompt(promptName: string) {
    const targetId = await ensureOverride();
    await addPrompt.mutateAsync({ id: targetId, name: promptName, body: `# ${promptName}\n` });
    setSelected(`prompts/${promptName}.md`);
  }

  const selectedPrompt =
    selected === OVERVIEW_KEY ? undefined : skill.prompts.find((p) => p.relPath === selected);

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-5 p-6">
      <BackLink />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{skill.name}</h1>
            <Badge
              variant="outline"
              className={
                skill.source === "bundled"
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }
            >
              {skill.source}
            </Badge>
            {skill.overriddenFromBundled && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
                overridden
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {skill.overriddenFromBundled && (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer text-destructive hover:text-destructive"
              onClick={() => setConfirmRestore(true)}
            >
              Restore to default
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Label htmlFor="detail-enabled" className="text-xs">
              Enable
            </Label>
            <Switch
              id="detail-enabled"
              checked={skill.enabled}
              onCheckedChange={(enabled) => toggle.mutate({ id: skill.id, enabled })}
            />
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-6 border-t border-border pt-5">
        <div className="h-full min-h-0 overflow-y-auto pr-1">
          <SkillFileSidebar
            prompts={skill.prompts}
            selected={selected}
            onSelect={setSelected}
            canAddPrompt
            onAddPrompt={handleAddPrompt}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          {selected === OVERVIEW_KEY || !selectedPrompt ? (
            <SkillOverviewPane
              mode="view"
              skill={skill}
              initialEdit={initialEdit}
              ensureOverride={ensureOverride}
              onOpenRef={setSelected}
            />
          ) : (
            <SkillPromptPane
              skill={skill}
              prompt={selectedPrompt}
              ensureOverride={ensureOverride}
              onDeleted={() => setSelected(OVERVIEW_KEY)}
              onOpenRef={setSelected}
            />
          )}
        </div>
      </div>

      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore &ldquo;{skill.name}&rdquo; to the bundled version?</AlertDialogTitle>
            <AlertDialogDescription>
              Your override copy — including any prompt edits — will be removed and the bundled
              skill restored. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                del.mutate(skill.id);
                setSelected(OVERVIEW_KEY);
                setConfirmRestore(false);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
