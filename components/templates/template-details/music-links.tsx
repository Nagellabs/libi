"use client";

import type { MusicLinkRow } from "@/lib/templates/details";
import { OpensOutside } from "@/components/templates/templates-page/opens-outside";

/**
 * "Music: Title — Artist · not included" per template music link
 * (social-music spec §7). `label` is the template author's text — a
 * stranger's for an installed or public template — rendered as plain text
 * only, matching how the rest of this page treats author text.
 */
export function MusicLinks({ rows }: { rows: MusicLinkRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Music" className="space-y-1">
      {rows.map((r) => (
        <p key={r.ref} data-testid="template-music-link" className="text-sm text-muted-foreground">
          Music: <bdi>{r.label}</bdi> · not included
          {r.source && (
            <>
              {" · "}
              <a
                data-testid="template-music-source"
                href={r.source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer underline"
              >
                {r.source.host}
                <OpensOutside />
              </a>
            </>
          )}
        </p>
      ))}
    </section>
  );
}
