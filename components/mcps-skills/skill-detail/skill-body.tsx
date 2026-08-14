"use client";

import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OVERVIEW_KEY } from "./skill-file-sidebar";

/** Matches a markdown inline link: [label](target). */
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

const LINK_CLASS =
  "text-blue-500 hover:underline dark:text-blue-400";
/** Inline-reset so an in-flow <button> matches the surrounding <pre> text. */
const BUTTON_RESET =
  "inline cursor-pointer border-0 bg-transparent p-0 font-[inherit] align-baseline";

/**
 * Resolve a markdown link target to a selectable file key within THIS skill, or
 * null when it isn't an in-skill reference.
 *
 * Handles SKILL.md links (`SKILL.md`), sibling prompt links (`model-x.md`,
 * authored from inside a prompt file) and SKILL.md-relative links
 * (`prompts/model-x.md`). Cross-skill names, external URLs, and out-of-tree doc
 * links resolve to null (rendered styled but non-navigating).
 */
function resolveRefKey(target: string, prompts: { relPath: string }[]): string | null {
  const clean = target.trim().split("#")[0].replace(/^\.\//, "");
  if (!clean.endsWith(".md")) return null;
  const bare = clean.split("/").pop();
  if (!bare) return null;
  if (bare === OVERVIEW_KEY) return OVERVIEW_KEY; // "SKILL.md"
  const candidate = `prompts/${bare}`;
  return prompts.some((p) => p.relPath === candidate) ? candidate : null;
}

interface Props {
  text: string;
  /** The skill's prompt files — used to resolve in-skill references. */
  prompts: { relPath: string }[];
  /** Select an in-skill file (OVERVIEW_KEY or a prompt relPath) in the detail page. */
  onOpenRef?: (key: string) => void;
  /** Extra classes merged onto the <pre> wrapper (e.g. height/scroll). */
  className?: string;
}

/**
 * Renders a skill / prompt markdown body as preformatted text, turning inline
 * `[label](target)` links into blue references. In-skill references (other
 * prompts, SKILL.md) are clickable and switch the selected file; external URLs
 * open in a new tab; anything else is shown styled but inert.
 */
export function SkillBody({ text, prompts, onOpenRef, className }: Props) {
  const body = text && text.length > 0 ? text : "—";
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  // matchAll clones the regex internally, so the module-level LINK_RE is
  // never mutated during render (exec() would advance its shared lastIndex).
  for (const match of body.matchAll(LINK_RE)) {
    const [full, label, target] = match;
    if (match.index > last) {
      nodes.push(<Fragment key={`t${i}`}>{body.slice(last, match.index)}</Fragment>);
    }
    const key = resolveRefKey(target, prompts);
    const isHttp = /^https?:\/\//.test(target.trim());
    if (key && onOpenRef) {
      nodes.push(
        <button
          key={`l${i}`}
          type="button"
          className={cn(LINK_CLASS, BUTTON_RESET)}
          onClick={() => onOpenRef(key)}
        >
          {label}
        </button>,
      );
    } else if (isHttp) {
      nodes.push(
        <a
          key={`l${i}`}
          href={target.trim()}
          target="_blank"
          rel="noreferrer"
          className={cn(LINK_CLASS, "cursor-pointer")}
        >
          {label}
        </a>,
      );
    } else {
      nodes.push(
        <span key={`l${i}`} className={LINK_CLASS}>
          {label}
        </span>,
      );
    }
    last = match.index + full.length;
    i++;
  }
  if (last < body.length) {
    nodes.push(<Fragment key="tail">{body.slice(last)}</Fragment>);
  }

  return (
    <pre
      className={cn(
        "whitespace-pre-wrap rounded-lg border border-border bg-muted/10 p-4 text-xs leading-relaxed",
        className,
      )}
    >
      {nodes}
    </pre>
  );
}
