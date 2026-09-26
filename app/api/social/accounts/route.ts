import { NextResponse } from "next/server";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Every connected account, decorated with its health when that read
 * succeeds. A failed health call leaves `health` as whatever `listAccounts`
 * already carried (`toAccount` synthesizes a basic one from the list row
 * itself) rather than failing the whole list over one account's blip.
 */
export async function GET(): Promise<Response> {
  return socialRoute("accounts", async () => {
    const accounts = await withAdapter(async (a) => {
      const list = await a.listAccounts();
      return Promise.all(
        list.map(async (acc) => {
          try {
            return { ...acc, health: await a.accountHealth(acc.id) };
          } catch {
            return acc;
          }
        }),
      );
    });
    return NextResponse.json({ accounts });
  });
}
