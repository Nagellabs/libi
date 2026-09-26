import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { TemplatesPage } from "@/components/templates/templates-page/templates-page";

export default function TemplatesRoute() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <TemplatesPage />
        </div>
      </SidebarInset>
    </>
  );
}
