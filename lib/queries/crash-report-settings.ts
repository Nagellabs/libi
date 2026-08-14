import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCrashReportChoiceRevision,
  reconcileCrashReportChoice,
  setCrashReportChoice,
  writeStoredCrashReportChoice,
  type CrashReportChoice,
} from "@/lib/sentry/enabled";

export const crashReportSettingsKeys = { all: ["crash-report-settings"] as const };

export interface CrashReportSettingDto {
  choice: CrashReportChoice;
  decidedAt: number | null;
}

export function useCrashReportSettings() {
  return useQuery({
    queryKey: crashReportSettingsKeys.all,
    queryFn: async (): Promise<CrashReportSettingDto> => {
      // Snapshot BEFORE the request: if the user flips the switch while this
      // read is in flight, the PUT's onSuccess bumps the revision and the
      // reconcile below declines rather than resurrecting the stale value.
      const revision = getCrashReportChoiceRevision();
      const res = await fetch("/api/settings/crash-reports");
      if (!res.ok) throw new Error("Failed to fetch crash report setting");
      const dto: CrashReportSettingDto = await res.json();
      // RECONCILE — the DB is authoritative over the localStorage mirror the
      // gate was seeded from at init. Without this, a renderer whose mirror is
      // absent or stale (privacy-mode write failure, cleared site data, a
      // server port change re-keying the origin) reads "unset" = reporting,
      // and this very component would render the switch OFF from `dto` while
      // the same renderer kept shipping envelopes. Two-way on purpose: it can
      // close the gate AND re-open it. Covers only sessions that open
      // Settings; instrumentation-client.ts reconciles every session.
      reconcileCrashReportChoice(dto.choice, revision);
      return dto;
    },
    staleTime: Infinity,
  });
}

/** Mutation takes a boolean (what a <Switch> gives Task 4) and converts it to
 *  the wire "on"/"off" choice. */
export function useSetCrashReportsEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<CrashReportSettingDto> => {
      const choice: CrashReportChoice = enabled ? "on" : "off";
      const res = await fetch("/api/settings/crash-reports", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice }),
      });
      if (!res.ok) throw new Error("Failed to update crash report setting");
      return res.json();
    },
    onSuccess: (dto) => {
      qc.setQueryData(crashReportSettingsKeys.all, dto);
      // Move the LIVE browser gate, not only its persisted mirror. The PUT above
      // updated the SERVER's copy of `cachedChoice` (in the route handler's
      // process); this renderer has its own, seeded ONCE in
      // instrumentation-client.ts at init. Without this call an opt-out would
      // not take effect in the browser until a hard reload — and an Electron
      // renderer lives for days — so the renderer would keep shipping unhandled
      // render errors, browser-tracing transactions, release-health sessions,
      // and INP standalone spans whose span name is a DOM tree path. That is
      // exactly the leak lib/sentry/gated-transport.ts exists to close, and the
      // privacy policy promises the opt-out "takes effect immediately,
      // mid-session, with no restart". Cheap and synchronous: the gate is read
      // per envelope at send time, so this single assignment is enough.
      setCrashReportChoice(dto.choice);
      // Keep the browser localStorage mirror in sync too, so the gate is also
      // correct on the NEXT launch (it is read synchronously at Sentry init,
      // before any server round-trip is possible).
      writeStoredCrashReportChoice(dto.choice);
    },
  });
}
