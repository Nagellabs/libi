import { NextResponse } from "next/server";
import { getJobManager } from "@/lib/jobs/manager";
import { JobNotFoundError } from "@/lib/jobs/types";

/** Minimal JSON `{ status }` payload — used by the in-page Playwright runner
 *  to poll for cancel signals without setting up an SSE stream from inside
 *  the page. */
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const snap = await getJobManager().getStatus(id);
    return NextResponse.json({ status: snap.status });
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return NextResponse.json({ status: "unknown" });
    }
    throw err;
  }
}
