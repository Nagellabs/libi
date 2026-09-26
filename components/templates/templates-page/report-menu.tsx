"use client";

import { useId, useState } from "react";
import { Flag } from "lucide-react";
import { toast } from "sonner";
import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";
import { useLegalLinks } from "@/lib/queries/templates-catalog";
import { useReportTemplate } from "@/lib/queries/templates-cloud";
import { REPORT_DETAILS_MAX, type ReportReason } from "@/lib/templates/cloud/constants";

/** The catalog's fixed reasons (lib/templates/cloud/constants.ts#REPORT_REASONS), in menu order. */
export const REPORT_REASON_LABELS: ReadonlyArray<readonly [ReportReason, string]> = [
  ["spam", "Spam"],
  ["offensive", "Offensive"],
  ["broken", "Broken"],
  ["copyright", "Copyright"],
  ["other", "Other"],
];
const STORAGE_KEY = "libi:template-reports";

function readReported(): string[] {
  const list: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

export function wasReported(cloudId: string): boolean {
  try {
    return readReported().includes(cloudId);
  } catch {
    return false;
  }
}

export function rememberReported(cloudId: string): void {
  try {
    const list = readReported();
    if (!list.includes(cloudId)) localStorage.setItem(STORAGE_KEY, JSON.stringify([...list, cloudId]));
  } catch {
    // Storage unavailable: the menu comes back next time, and the site counts
    // distinct reporters anyway, so a second report changes nothing.
  }
}

/**
 * Report a public template: pick one of the fixed reasons, then confirm in a
 * dialog that says what a report does, with an optional box for the
 * reporter's own words (sent as `details`). It goes to libi's server, which
 * sends it to the catalog — the renderer never talks to the site. Once the
 * catalog has taken it, this install remembers it and shows "Reported"
 * instead. A copyright report also points at the site's web form, where a
 * formal notice (contact details, the claimant's statements) can be sent —
 * the in-app report carries neither.
 */
export function ReportMenu({ cloudId }: { cloudId: string }) {
  const [done, setDone] = useState(() => wasReported(cloudId));
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const report = useReportTemplate();
  const links = useLegalLinks();
  const detailsId = useId();
  const counterId = useId();
  if (done)
    return (
      <span className="text-xs text-muted-foreground" data-testid="report-done">
        Reported
      </span>
    );
  const label = REPORT_REASON_LABELS.find(([r]) => r === reason)?.[1];
  const close = () => {
    setReason(null);
    setDetails("");
  };
  const send = () => {
    if (!reason) return;
    const text = details.trim();
    report.mutate(
      { cloudId, reason, ...(text ? { details: text } : {}) },
      {
        onSuccess: (r) => {
          rememberReported(cloudId);
          setDone(true);
          close();
          // `hidden` also answers a template that was already out of the
          // catalog, so it is not read as "your report hid it".
          toast.success(r.hidden ? "Thanks — reported. It's no longer in the public catalog." : "Thanks — reported.");
        },
      },
    );
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" className="cursor-pointer text-muted-foreground" data-testid="report-trigger" />}
        >
          <Flag className="size-3.5" />
          Report
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {REPORT_REASON_LABELS.map(([r, text]) => (
            <DropdownMenuItem key={r} className="cursor-pointer" data-testid={`report-reason-${r}`} onClick={() => setReason(r)}>
              {text}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={reason !== null} onOpenChange={(open) => !open && !report.isPending && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Report this template: {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The report goes to the libi catalog without your name or creator key. When five different people report
              a template within 24 hours, it is hidden from the public catalog until it is reviewed. Details you add go
              to the libi team with the report.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <label htmlFor={detailsId} className="text-sm font-medium">
              Add details (optional)
            </label>
            <textarea
              id={detailsId}
              // The counter is read with the box, so reaching the cap (where typing silently stops) is heard.
              aria-describedby={counterId}
              placeholder="What's wrong with it?"
              rows={3}
              maxLength={REPORT_DETAILS_MAX}
              value={details}
              disabled={report.isPending}
              onChange={(e) => setDetails(e.target.value)}
              data-testid="report-details"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
            <p id={counterId} data-testid="report-details-counter" className="text-right text-xs text-muted-foreground">
              {details.length}/{REPORT_DETAILS_MAX}
            </p>
          </div>
          {reason === "copyright" && (
            <p className="text-sm text-muted-foreground" data-testid="report-copyright-form">
              Sending a formal copyright notice?{" "}
              <a
                href={links.templateReportForm(cloudId)}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer text-foreground underline underline-offset-2"
              >
                Use the web form
                <OpensOutside />
              </a>
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer" disabled={report.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
              data-testid="report-confirm"
              focusableWhenDisabled={report.isPending}
              disabled={report.isPending}
              onClick={send}
            >
              {report.isPending ? <BusyLabel>Reporting…</BusyLabel> : "Report"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
