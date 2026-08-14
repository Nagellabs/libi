"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractSections } from "@/lib/instructions/toc";
import { useInstructionsDoc, useMemories } from "@/lib/queries/instructions";
import { DocToc } from "./doc-toc";
import { InstructionsView } from "./instructions-view";
import { MemoriesView } from "./memories-view";

const TABS = ["instructions", "memories"] as const;
type Tab = (typeof TABS)[number];
const DEFAULT_TAB: Tab = "instructions";

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

export function InstructionsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTab] = useState<Tab>(isTab(urlTab) ? urlTab : DEFAULT_TAB);
  // While a view is in edit mode the content column becomes a fixed-height
  // flex column (textarea gets the full height + inner scroll) instead of a
  // scrolling document.
  const [editing, setEditing] = useState(false);
  const scrollRef = useRef<HTMLElement | null>(null);

  const instructionsDoc = useInstructionsDoc();
  const memories = useMemories();

  useEffect(() => {
    const next = searchParams.get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isTab(next) && next !== tab) setTab(next);
  }, [searchParams, tab]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setEditing(false);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const activeMarkdown =
    tab === "instructions" ? instructionsDoc.data?.content ?? "" : memories.data?.content ?? "";
  const sections = useMemo(() => extractSections(activeMarkdown), [activeMarkdown]);

  return (
    <div className="flex h-full min-h-0">
      {/* Inner left sidebar: page switcher + section TOC */}
      <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3">
        {(
          [
            { id: "instructions" as Tab, label: "Instructions", icon: BookOpen },
            { id: "memories" as Tab, label: "Memories", icon: Brain },
          ]
        ).map(({ id, label, icon: Icon }) => (
          <div key={id}>
            <button
              type="button"
              onClick={() => switchTab(id)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors",
                tab === id
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
            {tab === id && (
              <div className="mb-2 ml-3 mt-1 border-l border-border pl-1">
                <DocToc sections={sections} scrollRef={scrollRef} />
              </div>
            )}
          </div>
        ))}
      </aside>

      {/* Content */}
      <div
        ref={(el) => {
          scrollRef.current = el;
        }}
        className="min-w-0 flex-1 overflow-y-auto"
      >
        <div
          className={
            editing
              ? "mx-auto flex h-full w-full max-w-7xl flex-col p-6"
              : "mx-auto w-full max-w-7xl p-6"
          }
        >
          {tab === "instructions" ? (
            <InstructionsView onEditingChange={setEditing} />
          ) : (
            <MemoriesView onEditingChange={setEditing} />
          )}
        </div>
      </div>
    </div>
  );
}
