import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { SocialPage } from "@/components/social/social-page/social-page";

export default function SocialRoute() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <SocialPage />
        </div>
      </SidebarInset>
    </>
  );
}
