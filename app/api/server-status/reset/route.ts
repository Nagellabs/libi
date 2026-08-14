import { NextResponse } from "next/server";
import { requestRelaunch } from "@/lib/server/lifecycle/relaunch";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true, restarting: true }, { status: 202 });
  requestRelaunch();
  return res;
}
