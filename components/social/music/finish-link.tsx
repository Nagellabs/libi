"use client";

import QRCode from "qrcode";
import { useQuery } from "@tanstack/react-query";
import type { FinishLink as Link } from "@/lib/social/finish-links";

/** A finish link; TikTok's also shows a QR code of the app link (scan with the phone). */
export function FinishLink({ link }: { link: Link }) {
  const qrText = link.kind === "tiktok-inbox" ? link.qr : "";
  // Local work, not a fetch: the QR's SVG is derived from a constant URL, so it
  // is cached forever under that URL.
  const qr = useQuery({
    queryKey: ["finish-link-qr", qrText],
    enabled: qrText !== "",
    staleTime: Infinity,
    queryFn: async () => `data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(qrText, { type: "svg", margin: 1 }))}`,
  });
  return (
    <div className="flex items-center gap-3">
      <a
        data-testid={`finish-link-${link.kind}`}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="cursor-pointer text-xs text-primary hover:underline"
      >
        {link.label} ↗
      </a>
      {link.kind === "tiktok-inbox" && (
        <>
          {qr.data && (
            // A data: URL of a locally drawn SVG — nothing for next/image to optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img data-testid="tiktok-qr" src={qr.data} alt="QR code: open TikTok on your phone" className="size-20 rounded bg-white p-1" />
          )}
          <span className="text-xs text-muted-foreground">{link.instruction}</span>
        </>
      )}
    </div>
  );
}
