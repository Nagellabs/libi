import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { AgentsPage } from "@/components/agents-page/agents-page";
import { PersonaModal } from "@/components/onboarding/persona-modal";

export default function AgentsRoute() {
  return (
    <>
      {/* A first launch lands here (see FirstLaunchGate): the question sits on top of the Agents tab. */}
      <PersonaModal />
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <AgentsPage />
        </div>
      </SidebarInset>
    </>
  );
}
