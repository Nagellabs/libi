import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { McpsSkillsPage } from "@/components/mcps-skills/mcps-skills-page";

export default function McpsSkillsRoute() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <McpsSkillsPage />
        </div>
      </SidebarInset>
    </>
  );
}
