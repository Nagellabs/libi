import { Box, Code2, Film, Image as ImageIcon, Type, type LucideIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OverlayRow } from "@/lib/templates/details";

const KIND: Record<OverlayRow["kind"], { icon: LucideIcon; word: string }> = {
  text: { icon: Type, word: "Text" },
  image: { icon: ImageIcon, word: "Image" },
  video: { icon: Film, word: "Video" },
  code: { icon: Code2, word: "Code" },
  three: { icon: Box, word: "3D" },
};

/** Seconds, to the hundredth, without trailing zeros ("0", "2.5", "1.25"). */
const secs = (n: number) => String(Math.round(n * 100) / 100);

/**
 * A template's overlays, top-most first: kind, name (its label, with the key
 * beside it), when it shows, and whether the user fills it (its slot) or it
 * is fixed. Labels and keys are the template author's text: plain, isolated.
 */
export function OverlaysList({ rows }: { rows: OverlayRow[] }) {
  return (
    <section aria-labelledby="template-overlays-heading" className="space-y-3">
      <h2 id="template-overlays-heading" className="text-sm font-semibold">
        Overlays <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No overlays.</p>
      ) : (
        <div className="rounded-xl border border-border">
          {/* At phone width every column stays on screen (D5–D6 review M5): Kind shrinks to its
              icon (the word stays for screen readers), Time and Slot narrow, the Name truncates. */}
          <Table className="table-fixed" data-testid="overlays-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 sm:w-28">
                  <span className="sr-only sm:not-sr-only">Kind</span>
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24 sm:w-32">Time</TableHead>
                <TableHead className="w-24 sm:w-44">Slot</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const { icon: Icon, word } = KIND[r.kind];
                return (
                  <TableRow key={r.key} data-testid="overlay-row" data-key={r.key}>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="sr-only sm:not-sr-only">{word}</span>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="max-w-[70%] min-w-0 shrink-0 truncate">
                          <bdi>{r.label}</bdi>
                        </span>
                        {r.label !== r.key && <span className="min-w-0 truncate font-mono text-[0.7rem] text-muted-foreground">{r.key}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums whitespace-normal text-muted-foreground">
                      {secs(r.start)}–{secs(r.end)} s
                    </TableCell>
                    <TableCell>
                      {r.slot ? (
                        <span title={`Slot: ${r.slot}`} className="inline-block max-w-full truncate rounded-full border border-border px-2 py-0.5 align-middle text-[0.7rem]">
                          {/* A slot key is [a-z0-9-]: nothing in it to isolate. */}
                          Slot: {r.slot}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Fixed</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
