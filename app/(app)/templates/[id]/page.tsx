import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { LocalTemplateDetails } from "@/components/templates/template-details/local-template-details";

/** A local template's own page — the Templates page's card and List-view name link here. */
export default async function TemplateDetailsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <LocalTemplateDetails id={id} />
        </div>
      </SidebarInset>
    </>
  );
}
