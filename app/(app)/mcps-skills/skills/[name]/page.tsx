import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { SkillDetail } from "@/components/mcps-skills/skill-detail/skill-detail";

interface Props {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ edit?: string }>;
}

export default async function SkillDetailRoute({ params, searchParams }: Props) {
  const { name } = await params;
  const { edit } = await searchParams;
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <SkillDetail name={decodeURIComponent(name)} initialEdit={edit === "1"} />
        </div>
      </SidebarInset>
    </>
  );
}
