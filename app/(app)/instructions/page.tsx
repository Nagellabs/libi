import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { InstructionsPage } from "@/components/instructions/instructions-page";

export default function InstructionsRoute() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="min-h-0 flex-1">
          <InstructionsPage />
        </div>
      </SidebarInset>
    </>
  );
}
