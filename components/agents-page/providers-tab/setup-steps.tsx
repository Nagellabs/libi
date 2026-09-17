"use client";

import { useId, type ComponentProps } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SetupStepStatus } from "@/lib/providers/setup-steps";
import { cn } from "@/lib/utils";

/**
 * An ordered setup of more than one step, drawn the same way for every
 * provider that needs one: a numbered circle per step joined to the next by a
 * thin line, the step's title, one description line, and its action under it.
 * Which steps there are and where each stands comes from
 * `lib/providers/setup-steps.ts`; this only draws them.
 */

export interface SetupStepActionView {
  label: string;
  /** Past tense, on the disabled button a done step keeps. */
  doneLabel: string;
  /** False while no command can be built (the tab says why). */
  enabled: boolean;
  onClick: () => void;
  /** A line under the action while the step is still to do. */
  caption?: string;
}

export interface SetupStepView {
  id: string;
  status: SetupStepStatus;
  title: string;
  description: string;
  /** More muted lines under the description. */
  details?: string[];
  /** Absent: the step has no action here (its description says what to do instead). */
  action?: SetupStepActionView;
  /** While `running`: what is left to do outside libi, above the action that types the command again. */
  runningText?: string;
}

export interface CombinedActionView {
  /** The steps this one action performs, by id, in order. */
  stepIds: string[];
  label: string;
  enabled: boolean;
  onClick: () => void;
  /** The one line saying what the action does. */
  caption: string;
}

/**
 * A step button. The base button drops pointer events while disabled, so a
 * disabled one never lights up on hover; the wrapper shows the not-allowed cursor.
 */
export function StepButton({ className, disabled, ...props }: ComponentProps<typeof Button>) {
  return (
    <span className={cn("inline-flex", disabled && "cursor-not-allowed")}>
      <Button size="sm" className={cn("cursor-pointer", className)} disabled={disabled} {...props} />
    </span>
  );
}

export function SetupSteps({
  testIdPrefix,
  steps,
  combined,
}: {
  /** Each step is `<testIdPrefix>-<stepId>`. */
  testIdPrefix: string;
  steps: SetupStepView[];
  /** One action that performs several steps at once: those steps and the action are drawn as one block. */
  combined?: CombinedActionView;
}) {
  const current = steps.findIndex((s) => s.status === "current" || s.status === "running");
  const last = steps.length - 1;
  const covered = (i: number) => Boolean(combined && i >= 0 && i <= last && combined.stepIds.includes(steps[i].id));
  const lastCovered = steps.findLastIndex((_, i) => covered(i));
  // A stable id per covered step's running line, so the combined action below
  // can list them in its `aria-describedby` the same way a single step lists
  // its own (see `StepAction`'s `runningId`).
  const runningLineIdBase = useId();
  const runningLineId = (stepId: string) => `${runningLineIdBase}-running-${stepId}`;
  const coveredRunningIds = steps
    .filter((step, i) => covered(i) && step.status === "running" && step.runningText)
    .map((step) => runningLineId(step.id));
  return (
    <ol className="pt-1">
      {steps.map((step, i) => {
        const inGroup = covered(i);
        const groupStart = inGroup && !covered(i - 1);
        const groupEnd = inGroup && !covered(i + 1);
        return (
          <li
            key={step.id}
            data-testid={`${testIdPrefix}-${step.id}`}
            data-status={step.status}
            aria-current={i === current ? "step" : undefined}
            className={cn(
              inGroup && "border-x border-border/60 bg-muted/20 px-2.5",
              groupStart && "rounded-t-md border-t pt-2.5",
              groupEnd && "rounded-b-md border-b pb-2.5",
              // Room between a group and a step outside it.
              groupEnd && i < last && "mb-3",
            )}
          >
            <div className={cn("relative pl-7", i < last && !groupEnd && "pb-3")}>
              {i < last && !groupEnd ? (
                <span
                  aria-hidden
                  // Steps one action performs together are joined in the current color.
                  className={cn("absolute top-6 bottom-1 left-2.5 w-px", inGroup ? "bg-primary" : "bg-border")}
                />
              ) : null}
              <StepMarker number={i + 1} status={step.status} />
              <div
                className={cn(
                  "text-xs leading-5 font-medium",
                  step.status === "current" || step.status === "running" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.title}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{step.description}</p>
              {step.details?.map((line) => (
                <p key={line} className="text-[11px] leading-relaxed text-muted-foreground">
                  {line}
                </p>
              ))}
              {inGroup ? (
                step.status === "running" && step.runningText ? (
                  <RunningLine id={runningLineId(step.id)} text={step.runningText} />
                ) : null
              ) : (
                <StepAction step={step} previousNumber={i} />
              )}
            </div>
            {combined && i === lastCovered ? <CombinedAction action={combined} runningIds={coveredRunningIds} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepMarker({ number, status }: { number: number; status: SetupStepStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-0 left-0 flex size-5 items-center justify-center rounded-full border text-[10px] font-medium",
        status === "done" && "border-emerald-500/60 bg-emerald-500/15 text-emerald-500",
        (status === "current" || status === "running") && "border-primary text-primary",
        (status === "locked" || status === "blocked") && "border-border text-muted-foreground",
      )}
    >
      {status === "done" ? <Check className="size-3" /> : number}
    </span>
  );
}

function RunningLine({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 pt-1 text-[11px] leading-relaxed text-muted-foreground">
      <span aria-hidden className="mt-[5px] size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      <span>{text}</span>
    </p>
  );
}

/**
 * The one action at the bottom of the block of steps it performs, then the
 * line saying what it does. While a covered step is running, its running
 * line is announced too (in step order, before the caption) — the same as a
 * single-step action already does for its own running line.
 */
function CombinedAction({ action, runningIds }: { action: CombinedActionView; runningIds: string[] }) {
  const captionId = useId();
  const describedBy = [...runningIds, captionId].join(" ");
  return (
    <div className="space-y-1 pt-2.5">
      <StepButton disabled={!action.enabled} aria-describedby={describedBy} onClick={() => action.onClick()}>
        {action.label}
      </StepButton>
      <p id={captionId} className="text-[11px] leading-relaxed text-muted-foreground">
        {action.caption}
      </p>
    </div>
  );
}

function StepAction({ step, previousNumber }: { step: SetupStepView; previousNumber: number }) {
  const reasonId = useId();
  const captionId = useId();
  const runningId = useId();
  const { action, status } = step;
  const running = status === "running" && step.runningText;
  if (!action) return running ? <RunningLine text={step.runningText!} /> : null;
  if (status === "done") {
    return (
      <div className="pt-1.5">
        <StepButton variant="outline" disabled>
          <Check />
          {action.doneLabel}
        </StepButton>
      </div>
    );
  }
  if (status === "locked") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
        <StepButton variant="outline" disabled aria-describedby={reasonId}>
          {action.label}
        </StepButton>
        <span id={reasonId} className="text-[11px] text-muted-foreground">
          After step {previousNumber}
        </span>
      </div>
    );
  }
  if (status === "blocked") return null;
  // Current, or running: the action stays, since libi can't see the command finish.
  const describedBy = [running ? runningId : null, action.caption ? captionId : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1 pt-1.5">
      {running ? <RunningLine id={runningId} text={step.runningText!} /> : null}
      <StepButton disabled={!action.enabled} aria-describedby={describedBy || undefined} onClick={() => action.onClick()}>
        {action.label}
      </StepButton>
      {action.caption ? (
        <p id={captionId} className="text-[11px] leading-relaxed text-muted-foreground">
          {action.caption}
        </p>
      ) : null}
    </div>
  );
}
