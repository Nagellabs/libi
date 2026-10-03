import { getJobStatus, listJobs, cancelJob } from "@/mcp/tools/job-tools";
import { GetJobStatusSchema, ListJobsSchema, CancelJobSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const jobTool: ActionToolDef = {
  name: "libi.job",
  description:
    "Check on or cancel background jobs (exports, tracking, analysis, downloads, installs, copies): list, read one job's status/progress/ETA by id, or cancel. Use before telling the user nothing is happening. Actions: list, status, cancel.",
  actions: {
    list: action({
      describe:
        "jobs newest-first WITHOUT a jobId, filtered by `status` ('running' answers \"is anything still working?\") and/or `kind`. Jobs run on the SERVER and keep going when the call that started them is interrupted or declined, so check before saying work stopped. `etaMs: null` = unknown, not nearly done; a large `msSinceProgress` is normal mid-transfer",
      schema: ListJobsSchema,
      run: (params) => listJobs(params),
    }),
    status: action({
      describe: "one job's { status, progressDone/Total/Unit, etaMs, error }; poll long work with it",
      schema: GetJobStatusSchema,
      run: (params) => getJobStatus(params),
    }),
    cancel: action({
      describe: "cancel a running job gracefully (partial results are kept; a re-run with the same params resumes)",
      schema: CancelJobSchema,
      run: (params) => cancelJob(params),
    }),
  },
};
