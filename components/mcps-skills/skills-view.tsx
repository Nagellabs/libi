"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSkills,
  useBulkSetSkillEnabled,
  mergeByName,
  type EffectiveSkill,
} from "@/lib/queries/skills";
import { SkillCard } from "@/components/settings/skill-card";
import { InstallFromUrlDialog } from "@/components/mcps-skills/install-from-url-dialog";
import { TagFilter } from "@/components/mcps-skills/tag-filter";

// Re-exported for back-compat with existing imports + tests.
export { mergeByName };
export type { EffectiveSkill };

interface SkillsViewProps {
  searchQuery: string;
  onClearSearch?: () => void;
}

interface SkillLike {
  name: string;
  description: string;
  body?: string | null;
}

export function matchesQuery(skill: SkillLike, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = (skill.name ?? "").toLowerCase();
  const desc = (skill.description ?? "").toLowerCase();
  const body = (skill.body ?? "").toLowerCase();
  return name.includes(q) || desc.includes(q) || body.includes(q);
}

export function matchesTags(skill: { tags: string[] }, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return skill.tags.some((t) => selected.includes(t));
}

export function SkillsView({ searchQuery, onClearSearch }: SkillsViewProps) {
  const { data: skills, isLoading } = useSkills();
  const [installFromUrlOpen, setInstallFromUrlOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  function handleTagToggle(tag: string) {
    setSelectedTags((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]));
  }

  function clearFilters() {
    setSelectedTags([]);
    onClearSearch?.();
  }

  const merged = mergeByName(skills ?? []);
  const allTags = Array.from(new Set(merged.flatMap((s) => s.tags))).sort();

  const trimmedQuery = searchQuery.trim();
  const visible = merged.filter(
    (s) => matchesQuery(s, trimmedQuery) && matchesTags(s, selectedTags)
  );

  const bulk = useBulkSetSkillEnabled();
  const allVisibleEnabled = visible.length > 0 && visible.every((s) => s.enabled);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const hasFilter = trimmedQuery.length > 0 || selectedTags.length > 0;
  const showEmpty = visible.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setInstallFromUrlOpen(true)}
          >
            <Download className="size-3.5 mr-1.5" />
            Install from GitHub
          </Button>
          <Link
            href="/mcps-skills/skills/new"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-pointer")}
          >
            <Plus className="size-3.5 mr-1.5" />
            Add skill
          </Link>
        </div>
        <p className="text-xs text-muted-foreground italic">
          Or ask your agent to add a skill to Libi
        </p>
      </div>

      {visible.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <TagFilter
            allTags={allTags}
            selected={selectedTags}
            onToggle={handleTagToggle}
          />
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer shrink-0"
            onClick={() => bulk.mutate({ ids: visible.map((s) => s.id), enabled: !allVisibleEnabled })}
          >
            {allVisibleEnabled ? "Disable all shown" : "Enable all shown"}
          </Button>
        </div>
      )}

      {visible.length === 0 && allTags.length > 0 && (
        <TagFilter
          allTags={allTags}
          selected={selectedTags}
          onToggle={handleTagToggle}
        />
      )}

      {showEmpty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {trimmedQuery
              ? <>Nothing matches &ldquo;{trimmedQuery}&rdquo;</>
              : "No skills match the selected filters"}
          </p>
          {hasFilter && (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}

      <InstallFromUrlDialog
        open={installFromUrlOpen}
        onOpenChange={setInstallFromUrlOpen}
        defaultKind="skill"
      />
    </div>
  );
}
