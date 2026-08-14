"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DatabaseIcon, FolderIcon, SlidersHorizontalIcon, Crown, ActivityIcon, BellIcon, DownloadIcon, ShieldIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { GeneralTab } from "@/components/settings/general-tab";
import { DbBackupsTab } from "@/components/settings/db-backups-tab";
import { DataFolderTab } from "@/components/settings/data-folder-tab";

import { PremiumTab } from "@/components/settings/premium-tab";
import { JobsTab } from "@/components/settings/jobs-tab";
import { NotificationsTab } from "@/components/settings/notifications-tab";
import { ExportTab } from "@/components/settings/export-tab";
import { PrivacyTab } from "@/components/settings/privacy-tab";

const SETTINGS_TABS = [
  "general",
  "premium",
  "jobs",
  "notifications",
  "analytics",
  "export",
  "database",
  "storage",
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const DEFAULT_TAB: SettingsTab = "general";

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (SETTINGS_TABS as readonly string[]).includes(value);
}

export default function SettingsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTab] = useState<SettingsTab>(
    isSettingsTab(urlTab) ? urlTab : DEFAULT_TAB,
  );

  // Keep state in sync if the URL changes externally (back/forward, deep-link).
  // Adjusted during render (React's previous-state pattern) rather than in an
  // effect — the re-render happens before paint, with no effect cascade.
  const [prevUrlTab, setPrevUrlTab] = useState(urlTab);
  if (urlTab !== prevUrlTab) {
    setPrevUrlTab(urlTab);
    if (isSettingsTab(urlTab) && urlTab !== tab) setTab(urlTab);
  }

  const handleTabChange = (next: string) => {
    if (!isSettingsTab(next)) return;
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <h1 className="font-brand text-[28px] font-semibold text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your workspace, integrations and data.
          </p>
        </div>
        <Tabs
          value={tab}
          onValueChange={handleTabChange}
          orientation="vertical"
          className="flex flex-row gap-6"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 items-start gap-0.5 bg-transparent py-1"
          >
            <TabsTrigger
              value="general"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <SlidersHorizontalIcon className="size-4" />
              General
            </TabsTrigger>
            <TabsTrigger
              value="premium"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <Crown className="size-4" />
              Premium
            </TabsTrigger>
            <TabsTrigger
              value="jobs"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <ActivityIcon className="size-4" />
              Background Jobs
            </TabsTrigger>
            <TabsTrigger
              value="notifications"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <BellIcon className="size-4" />
              Notifications
            </TabsTrigger>
            {/* value="analytics" is INTENTIONAL, not a leftover: the tab id is
                the URL/deep-link identity (?tab=analytics), so renaming it
                would break every existing link to this tab. Only the visible
                label and the component (PrivacyTab) broadened when crash
                reports joined analytics here. Leave the value alone. */}
            <TabsTrigger
              value="analytics"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <ShieldIcon className="size-4" />
              Privacy
            </TabsTrigger>
            <TabsTrigger
              value="export"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <DownloadIcon className="size-4" />
              Export
            </TabsTrigger>
            <TabsTrigger
              value="database"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <DatabaseIcon className="size-4" />
              Database
            </TabsTrigger>
            <TabsTrigger
              value="storage"
              className="w-full cursor-pointer justify-start gap-2 rounded-md px-3 py-2 text-sm data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
            >
              <FolderIcon className="size-4" />
              Libi Home
            </TabsTrigger>
          </TabsList>

          <div className="min-w-0 flex-1">
            <TabsContent value="general" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">General</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Workspace-level preferences stored in this browser.
                </p>
              </div>
              <GeneralTab />
            </TabsContent>

            <TabsContent value="premium" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Premium</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  One optional membership, for a single user or a team. The
                  editor stays free and open source forever — take it to the
                  next level with additional offerings.
                </p>
              </div>
              <PremiumTab />
            </TabsContent>

            <TabsContent value="jobs" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Background Jobs</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  All long-running operations in libi run through the
                  JobManager. This panel lists active and recent jobs with
                  cancel and retry actions.
                </p>
              </div>
              <JobsTab />
            </TabsContent>

            <TabsContent value="notifications" className="space-y-4">
              <NotificationsTab />
            </TabsContent>

            <TabsContent value="analytics" className="space-y-4">
              <PrivacyTab />
            </TabsContent>

            <TabsContent value="export" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Export</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Where exported videos go by default and which format/quality to start with.
                  Each export still lets you override these in the dialog.
                </p>
              </div>
              <ExportTab />
            </TabsContent>

            <TabsContent value="database" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Database</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Backups are created automatically before database migrations.
                  Only the 3 most recent backups are kept.
                </p>
              </div>
              <DbBackupsTab />
            </TabsContent>

            <TabsContent value="storage" className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Libi Home</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Configure where Libi keeps its home folder — database,
                  uploaded assets, skills, and agent files.
                </p>
              </div>
              <DataFolderTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>
        </div>
      </SidebarInset>
    </>
  );
}
