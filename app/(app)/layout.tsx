import { SidebarProvider } from "@/components/ui/sidebar";
import { EditorStateProvider } from "@/lib/editor-state-context";
import { AppShell } from "@/components/layout/app-shell";
import { GlobalRefreshMount } from "./global-refresh-mount";
import { AnalyticsProvider } from "@/components/analytics/analytics-provider";
import { FirstRunNotice } from "@/components/analytics/first-run-notice";

// libi is a desktop app — every page is dynamic and runs against a
// localhost Next server. Static prerendering provides no value and
// breaks on client hooks like `useSearchParams` that lack a Suspense
// boundary. Force dynamic at the group layout so we don't have to
// annotate every page individually.
export const dynamic = "force-dynamic";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <EditorStateProvider>
      <AppShell>
        <div className="relative flex min-h-0 w-full flex-1">
          <SidebarProvider
            style={
              {
                "--sidebar-width": "calc(var(--spacing) * 72)",
              } as React.CSSProperties
            }
          >
            <GlobalRefreshMount />
            <FirstRunNotice />
            <AnalyticsProvider>{children}</AnalyticsProvider>
          </SidebarProvider>
        </div>
      </AppShell>
    </EditorStateProvider>
  );
}
