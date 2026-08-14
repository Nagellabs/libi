import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The top-of-app announcement banner (components/layout/announcement-banner.tsx)
 * is the only consumer. The server (app/api/announcements) does all the
 * eligibility work — 3-day window on the SITE's clock, seen-filtering against
 * the local seen_announcements table; the client just renders what it is
 * handed and reports back what it displayed.
 */

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  kind: "feature" | "issue";
  url: string | null;
  createdAt: string;
}

export interface AnnouncementResponseDto {
  /** Newest live announcement this install has not seen, or null. */
  announcement: AnnouncementDto | null;
  /** Every currently-live id — marking ALL of them seen when one banner is
   *  shown is what implements "show only the newest, drop the rest". */
  liveIds: string[];
}

export const announcementKeys = { all: ["announcements"] as const };

export function useAnnouncement() {
  return useQuery<AnnouncementResponseDto>({
    queryKey: announcementKeys.all,
    queryFn: async () => {
      const response = await fetch("/api/announcements");
      if (!response.ok) throw new Error("Failed to load announcements");
      return response.json();
    },
    staleTime: 60 * 60 * 1000,
    // A long-running editor session should still learn about an issue notice.
    refetchInterval: 6 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useMarkAnnouncementsSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const response = await fetch("/api/announcements/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) throw new Error("Failed to mark announcements seen");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: announcementKeys.all });
    },
  });
}
