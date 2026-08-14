import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { SkillDetail } from "@/components/mcps-skills/skill-detail/skill-detail";

export default function NewSkillRoute() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <SkillDetail create />
        </div>
      </SidebarInset>
    </>
  );
}
