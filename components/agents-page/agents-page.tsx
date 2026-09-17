"use client";

import { useState } from "react";
import { Bot, Globe, ServerIcon, Sparkles, Plug } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchInput } from "./search-input";
import { SkillsView } from "./skills-view";
import { AgentsTab } from "./agents-tab/agents-tab";
import { OnboardingVisitProvider } from "./agents-tab/onboarding-visit";
import { GlobalSetupTab } from "./global-setup-tab/global-setup-tab";
import { LibiMcpTab } from "./libi-mcp-tab/libi-mcp-tab";
import { ProvidersTab } from "./providers-tab/providers-tab";
import { BackToChat } from "./back-to-chat";
import { SetupTerminalHost } from "./setup-terminal-host";
import { isAgentsTab, useAgentsPageParams } from "./use-agents-page-params";

/**
 * The one page for setting up coding agents, libi's own tools, third-party
 * providers and skills. Tab panels keep base-ui's `keepMounted: false` default,
 * so a hidden tab's subtree is unmounted; anything that has to outlive a tab
 * switch (a running setup terminal, what this visit settled about onboarding)
 * belongs above the panels, not inside one.
 */
export function AgentsPage() {
  const { tab, setTab, agent, provider, extension, from } = useAgentsPageParams();
  const [skillsSearch, setSkillsSearch] = useState("");

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-brand text-[28px] font-semibold text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set up Claude Code or Codex, connect libi&rsquo;s tools to them, add the providers
            they generate media with, and edit bundled or custom skills.
          </p>
        </div>
        {from ? <BackToChat sessionId={from} /> : null}
      </div>

      <SetupTerminalHost>
        <OnboardingVisitProvider>
          <Tabs
            value={tab}
            onValueChange={(next) => {
              if (isAgentsTab(next)) setTab(next);
            }}
            className="flex flex-col gap-4"
          >
            <TabsList variant="line" className="self-start">
              <TabsTrigger value="agents" className="gap-2">
                <Bot className="size-4" />
                Agents
              </TabsTrigger>
              <TabsTrigger value="global-setup" className="gap-2">
                <Globe className="size-4" />
                Global setup
              </TabsTrigger>
              <TabsTrigger value="skills" className="gap-2">
                <Sparkles className="size-4" />
                Skills
              </TabsTrigger>
              <TabsTrigger value="libi-mcp" className="gap-2">
                <ServerIcon className="size-4" />
                Libi MCP
              </TabsTrigger>
              <TabsTrigger value="providers" className="gap-2">
                <Plug className="size-4" />
                Providers
              </TabsTrigger>
            </TabsList>

            <TabsContent value="agents" className="space-y-4">
              <AgentsTab agent={agent} />
            </TabsContent>

            <TabsContent value="global-setup" className="space-y-4">
              <GlobalSetupTab />
            </TabsContent>

            <TabsContent value="skills" className="space-y-4">
              <SearchInput value={skillsSearch} onChange={setSkillsSearch} placeholder="Search skills…" />
              <SkillsView searchQuery={skillsSearch} onClearSearch={() => setSkillsSearch("")} />
            </TabsContent>

            <TabsContent value="libi-mcp" className="space-y-4">
              <LibiMcpTab extension={extension} />
            </TabsContent>

            <TabsContent value="providers" className="space-y-4">
              <ProvidersTab provider={provider} />
            </TabsContent>
          </Tabs>
        </OnboardingVisitProvider>
      </SetupTerminalHost>
    </div>
  );
}
