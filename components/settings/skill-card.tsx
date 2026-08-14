"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreVertical } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
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
  useToggleSkill,
  useDeleteSkill,
  type EffectiveSkill,
} from "@/lib/queries/skills";

interface SkillCardProps {
  skill: EffectiveSkill;
}

function detailHref(name: string, edit = false): string {
  return `/mcps-skills/skills/${encodeURIComponent(name)}${edit ? "?edit=1" : ""}`;
}

export function SkillCard({ skill }: SkillCardProps) {
  const router = useRouter();
  const toggle = useToggleSkill();
  const del = useDeleteSkill();
  const [confirm, setConfirm] = useState<"restore" | "delete" | null>(null);

  const isBundled = skill.source === "bundled";
  const isOverridden = Boolean(skill.overriddenFromBundled);
  const isPlainUser = skill.source === "user" && !isOverridden;
  const fileCount = 1 + skill.prompts.length;

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Link
              href={detailHref(skill.name)}
              className="cursor-pointer truncate font-medium hover:underline"
            >
              {skill.name}
            </Link>
            <Badge
              variant="outline"
              className={
                isBundled
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }
            >
              {skill.source}
            </Badge>
            {isOverridden && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
                overridden
              </Badge>
            )}
            {skill.bundledUpdatedSinceFork === true && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <Badge
                      variant="outline"
                      className="cursor-default border-blue-500/50 text-blue-600 dark:text-blue-400"
                    >
                      bundled updated
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs">
                      The bundled version of this skill has been updated since
                      you forked it. Ask the agent to show the differences, or
                      revert the override to take the update.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          {skill.description && (
            <p className="text-sm text-muted-foreground">{skill.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {skill.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>
          <Link
            href={detailHref(skill.name)}
            className="inline-block cursor-pointer text-xs text-muted-foreground underline"
          >
            Files ({fileCount})
          </Link>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`skill-enabled-${skill.id}`} className="text-xs">
              Enable
            </Label>
            <Switch
              id={`skill-enabled-${skill.id}`}
              checked={skill.enabled}
              onCheckedChange={(enabled) => toggle.mutate({ id: skill.id, enabled })}
            />
          </div>

          <Link
            href={detailHref(skill.name)}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-pointer")}
          >
            Open
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Actions for ${skill.name}`}
                  className="cursor-pointer inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            >
              <MoreVertical className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              {isBundled && (
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => router.push(detailHref(skill.name, true))}
                >
                  Override
                </DropdownMenuItem>
              )}
              {isOverridden && (
                <DropdownMenuItem
                  variant="destructive"
                  className="cursor-pointer"
                  onClick={() => setConfirm("restore")}
                >
                  Restore to default
                </DropdownMenuItem>
              )}
              {isPlainUser && (
                <DropdownMenuItem
                  variant="destructive"
                  className="cursor-pointer"
                  onClick={() => setConfirm("delete")}
                >
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "restore"
                ? `Restore "${skill.name}" to the bundled version?`
                : `Delete skill "${skill.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "restore"
                ? "Your override copy — including any prompt edits — will be removed and the bundled skill restored. This cannot be undone."
                : "This skill and its files will be permanently removed. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                del.mutate(skill.id);
                setConfirm(null);
              }}
            >
              {confirm === "restore" ? "Restore" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
