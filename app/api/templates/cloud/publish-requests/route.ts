import { NextResponse } from "next/server";
import { parseLoopbackAuthority } from "@/lib/security/request-guard";
import { listPublishRequestRows, settlePublishRequest, sweepStalePublishRequestMedia, toView } from "@/lib/templates/cloud/publish-requests";

export const dynamic = "force-dynamic";

/**
 * The Templates page's review panels: every publish an agent prepared
 * (`libi.publish_template`) that the user has not yet published or discarded.
 *
 *   GET → { requests: PublishRequestView[] }
 *
 * A request whose publish ended is settled first (gone once published,
 * `failed` otherwise — a restart mid-publish included). Each view carries its
 * `confirmCode` only when the page itself asked: a same-origin browser fetch
 * (`Sec-Fetch-Site: same-origin`, which no web page can forge and a browser
 * sets itself) to a loopback Host — the proxy lets a loopback GET through
 * whatever its origin, and checks the Host again here because a page
 * DNS-rebound to 127.0.0.1 is "same-origin" under its own Host name. A
 * tool, a curl or a script gets the review without it.
 *
 * Also removes request folders (example + poster) no request owns any more —
 * left by a run that died, or by a request removed some other way.
 */
export async function GET(req: Request): Promise<Response> {
  for (const row of listPublishRequestRows()) if (row.status === "publishing") settlePublishRequest(row.id);
  sweepStalePublishRequestMedia();
  const withConfirmCode = req.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin" && parseLoopbackAuthority(req.headers.get("host")) !== null;
  const requests = await Promise.all(listPublishRequestRows().map((row) => toView(row, { withConfirmCode })));
  return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } });
}
