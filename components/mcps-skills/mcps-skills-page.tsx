"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ServerIcon, Sparkles } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchInput } from "./search-input";
import { McpServersView } from "./mcp-servers-view";
import { SkillsView } from "./skills-view";
import { ConnectToolsSection } from "./connect-tools-section";

const MCPS_SKILLS_TABS = ["mcp", "skills"] as const;
type McpsSkillsTab = (typeof MCPS_SKILLS_TABS)[number];
// Skills are viewed/edited far more often than MCP servers, so default to them.
const DEFAULT_TAB: McpsSkillsTab = "skills";

function isMcpsSkillsTab(value: string | null): value is McpsSkillsTab {
  return value !== null && (MCPS_SKILLS_TABS as readonly string[]).includes(value);
}

export function McpsSkillsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTab] = useState<McpsSkillsTab>(
    isMcpsSkillsTab(urlTab) ? urlTab : DEFAULT_TAB,
  );
  const [mcpSearch, setMcpSearch] = useState("");
  const [skillsSearch, setSkillsSearch] = useState("");

  // Keep state in sync if the URL changes externally (back/forward, deep-link).
  // Adjusted during render (React's previous-state pattern) rather than in an
  // effect — the re-render happens before paint, with no effect cascade.
  const [prevUrlTab, setPrevUrlTab] = useState(urlTab);
  if (urlTab !== prevUrlTab) {
    setPrevUrlTab(urlTab);
    if (isMcpsSkillsTab(urlTab) && urlTab !== tab) setTab(urlTab);
  }

  const handleTabChange = (next: string) => {
    if (!isMcpsSkillsTab(next)) return;
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <h1 className="font-brand text-[28px] font-semibold text-foreground">
          MCPs &amp; Skills
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage agent tools and bundled or custom skills.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="flex flex-col gap-4"
      >
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="skills" className="gap-2">
            <Sparkles className="size-4" />
            Skills
          </TabsTrigger>
          <TabsTrigger value="mcp" className="gap-2">
            <ServerIcon className="size-4" />
            MCP Servers
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mcp" className="space-y-4">
          <ConnectToolsSection />
          <SearchInput
            value={mcpSearch}
            onChange={setMcpSearch}
            placeholder="Search MCP servers…"
          />
          <McpServersView
            searchQuery={mcpSearch}
            onClearSearch={() => setMcpSearch("")}
          />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <SearchInput
            value={skillsSearch}
            onChange={setSkillsSearch}
            placeholder="Search skills…"
          />
          <SkillsView
            searchQuery={skillsSearch}
            onClearSearch={() => setSkillsSearch("")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
