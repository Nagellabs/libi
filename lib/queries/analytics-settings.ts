import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const analyticsSettingsKeys = { all: ["analytics-settings"] as const };

export interface AnalyticsSettingDto {
  enabled: boolean;
  optOutAt: number | null;
}

export function useAnalyticsSettings() {
  return useQuery({
    queryKey: analyticsSettingsKeys.all,
    queryFn: async (): Promise<AnalyticsSettingDto> => {
      const res = await fetch("/api/settings/analytics");
      if (!res.ok) throw new Error("Failed to fetch analytics setting");
      return res.json();
    },
    staleTime: Infinity,
  });
}

export function useSetAnalyticsEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<AnalyticsSettingDto> => {
      const res = await fetch("/api/settings/analytics", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed to update analytics setting");
      return res.json();
    },
    onSuccess: (dto) => qc.setQueryData(analyticsSettingsKeys.all, dto),
  });
}
