"use client";

import { useCallback } from "react";
import { useLatestScript, useScriptJob } from "@/lib/queries/scripts";
import { useCancelJob } from "@/lib/queries/jobs";
import { useEditorState } from "@/lib/editor-state-context";
import { useDispatchToAgent } from "@/hooks/agent/use-dispatch-to-agent";
import { DispatchToAgentDialog } from "@/components/agent/dispatch-to-agent-dialog";
import { ScriptPanel } from "./script-panel";
import {
  ScriptEmpty,
  ScriptInProgress,
  ScriptFailed,
} from "./script-empty-state";

interface Props {
  fileId: string;
  /** Display name of the asset — included in the agent prompt so the agent
   *  can identify the file unambiguously. */
  fileName: string;
  onSeek: (t: number) => void;
  currentTime: number;
}

function isInflight(status: string | undefined): boolean {
  return status === "running" || status === "queued" || status === "cancel-requested";
}

/** The exact prompt handed to the agent (or copied for BYO-CLI). Specific to
 *  the script-analysis flow: names the tool, the file, and the approval step. */
function buildScriptPrompt(
  fileId: string,
  fileName: string,
  mode: "generate" | "regenerate" | "retry",
): string {
  const intro =
    mode === "regenerate"
      ? `A script analysis already exists for the video "${fileName}" (file id: ${fileId}). Regenerate it from scratch, replacing the existing one.`
      : mode === "retry"
        ? `The last script-analysis job for the video "${fileName}" (file id: ${fileId}) failed. Check why if the cause is obvious, then run it again.`
        : `Run the AI script analysis for the video "${fileName}" (file id: ${fileId}).`;
  return [
    intro,
    `Use libi.extra_analysis_model on this exact file. It runs a Gemini-powered video-understanding model that watches the full video and produces a detailed breakdown — a shot-by-shot script plus music and sound-design notes — which you can use for generation and editing decisions.`,
    `This is a paid fal.ai tool: check the expected cost first and confirm it with me before running. When the job completes, the result appears in the asset's "Extra analysis" tab.`,
  ].join("\n\n");
}

export function ScriptTabContent({ fileId, fileName, onSeek, currentTime }: Props) {
  const { data: latest } = useLatestScript(fileId);
  const { data: job } = useScriptJob(fileId);
  const cancel = useCancelJob();
  const { chatVisible, toggleChat } = useEditorState();
  const dispatch = useDispatchToAgent();

  const { openWith } = dispatch;
  const onGenerate = useCallback(
    () => openWith(buildScriptPrompt(fileId, fileName, "generate")),
    [openWith, fileId, fileName],
  );
  const onRegenerate = useCallback(
    () => openWith(buildScriptPrompt(fileId, fileName, "regenerate")),
    [openWith, fileId, fileName],
  );
  const onRetry = useCallback(
    () => openWith(buildScriptPrompt(fileId, fileName, "retry")),
    [openWith, fileId, fileName],
  );
  const onOpenChat = useCallback(() => {
    if (!chatVisible) toggleChat();
  }, [chatVisible, toggleChat]);
  const onCancel = useCallback(() => {
    if (job) cancel.mutate(job.id);
  }, [cancel, job]);

  const inflight = isInflight(job?.status);

  let body: React.ReactNode;
  if (latest) {
    // Populated — script exists.
    body = (
      <ScriptPanel
        persisted={latest}
        onSeek={onSeek}
        currentTime={currentTime}
        onRegenerate={onRegenerate}
        regeneratingJob={inflight ? job : undefined}
        onCancel={inflight ? onCancel : undefined}
      />
    );
  } else if (inflight) {
    body = (
      <ScriptInProgress
        done={job!.progressDone}
        total={job!.progressTotal}
        onCancel={onCancel}
      />
    );
  } else if (job?.status === "failed") {
    body = (
      <ScriptFailed
        error={job.error ?? "Unknown error"}
        onRetry={onRetry}
        onOpenChat={onOpenChat}
      />
    );
  } else {
    body = <ScriptEmpty onGenerate={onGenerate} />;
  }

  return (
    <>
      {body}
      <DispatchToAgentDialog
        open={dispatch.open}
        setOpen={dispatch.setOpen}
        prompt={dispatch.prompt}
        send={dispatch.send}
        copy={dispatch.copy}
        sending={dispatch.sending}
        title="Generate AI analysis"
      />
    </>
  );
}
