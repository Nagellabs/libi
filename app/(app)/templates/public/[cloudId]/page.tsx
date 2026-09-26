import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { PublicTemplateDetails } from "@/components/templates/template-details/public-template-details";

/** A public catalog entry's own page, read without installing it — the Public tab's card and List-view name link here. */
export default async function PublicTemplateDetailsRoute({ params }: { params: Promise<{ cloudId: string }> }) {
  const { cloudId } = await params;
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <div className="flex-1 overflow-y-auto">
          <PublicTemplateDetails cloudId={cloudId} />
        </div>
      </SidebarInset>
    </>
  );
}
