"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  WEEKDAY_INITIALS,
  addDays,
  daysInMonth,
  describeWall,
  formatWall,
  isAfter,
  monthTitle,
  nowWall,
  parseWall,
  quickPicks,
  weekdayOf,
  type WallClock,
} from "@/lib/social/schedule-picks";

/**
 * Picking WHEN a post goes out.
 *
 * This replaced `<input type="datetime-local">`, whose picker is the browser's
 * own: a light-grey Chromium panel in a dark app, in the host's locale and
 * the host's idea of "today" — while the value being edited is a wall clock in
 * the POST'S timezone. Everything here works in that zone instead, and the
 * chosen slot is echoed back in words so a schedule can't quietly land on the
 * wrong day.
 *
 * The chips carry the weight. Almost every real schedule is "this evening",
 * "tomorrow morning" or "the weekend", and each of those is one click here
 * against a date click plus a time click in any calendar.
 */
export function SchedulePicker({
  value,
  timezone,
  disabled,
  onChange,
  idPrefix = "schedule",
}: {
  /** `YYYY-MM-DDTHH:mm` in `timezone`, or "" when nothing is chosen yet. */
  value: string;
  timezone: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  idPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const picks = useMemo(() => quickPicks(timezone), [timezone]);
  const chosen = parseWall(value);

  return (
    <div className="space-y-2" data-testid={`${idPrefix}-picker`}>
      <div className="flex flex-wrap gap-1.5">
        {picks.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            data-testid={`${idPrefix}-pick-${p.id}`}
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
            className={`cursor-pointer rounded-4xl border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
              value === p.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {p.label}
          </button>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                data-testid={`${idPrefix}-custom`}
                className={`cursor-pointer rounded-4xl border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                  chosen && !picks.some((p) => p.value === value)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                Custom…
              </button>
            }
          />
          <PopoverContent align="start" className="w-auto p-3">
            <CustomCalendar value={value} timezone={timezone} idPrefix={idPrefix} onPick={(v) => onChange(v)} />
          </PopoverContent>
        </Popover>
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-readback`}>
        {chosen ? (
          <>
            <span className="font-medium text-foreground">{describeWall(value)}</span> · {timezone}
          </>
        ) : (
          <>No time chosen yet · {timezone}</>
        )}
      </p>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A month grid plus an hour and minute list, all in `timezone`.
 *
 * Past days are disabled against the clock IN THAT ZONE, which is the whole
 * reason this is not the native control: on a machine in Europe scheduling for
 * Asia/Bangkok, the browser and the post disagree about which day "today" is,
 * and the provider rejects a schedule in its own past.
 */
function CustomCalendar({
  value,
  timezone,
  idPrefix,
  onPick,
}: {
  value: string;
  timezone: string;
  idPrefix: string;
  onPick: (next: string) => void;
}) {
  const now = useMemo(() => nowWall(timezone), [timezone]);
  const chosen = parseWall(value) ?? { ...addDays(now, 1), h: 9, mi: 0 };
  const [view, setView] = useState({ y: chosen.y, mo: chosen.mo });

  const total = daysInMonth(view.y, view.mo);
  const lead = weekdayOf({ y: view.y, mo: view.mo, d: 1 });
  const cells: Array<number | null> = [...Array.from({ length: lead }, () => null), ...Array.from({ length: total }, (_, i) => i + 1)];

  const set = (patch: Partial<WallClock>) => onPick(formatWall({ ...chosen, ...patch }));
  const shiftMonth = (by: number) => {
    const d = new Date(Date.UTC(view.y, view.mo - 1 + by, 1));
    setView({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 });
  };

  return (
    <div className="flex gap-3">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="size-7 cursor-pointer p-0" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
            ‹
          </Button>
          <span className="text-sm font-medium" data-testid={`${idPrefix}-month`}>
            {monthTitle(view.y, view.mo)}
          </span>
          <Button variant="ghost" size="sm" className="size-7 cursor-pointer p-0" aria-label="Next month" onClick={() => shiftMonth(1)}>
            ›
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {WEEKDAY_INITIALS.map((d, i) => (
            <span key={i} className="py-1 text-[10px] uppercase text-muted-foreground">
              {d}
            </span>
          ))}
          {cells.map((d, i) =>
            d === null ? (
              <span key={`pad-${i}`} />
            ) : (
              (() => {
                const cell = { y: view.y, mo: view.mo, d, h: 23, mi: 59 };
                const past = !isAfter(cell, now);
                const selected = chosen.y === view.y && chosen.mo === view.mo && chosen.d === d;
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={past}
                    data-testid={`${idPrefix}-day-${view.y}-${pad(view.mo)}-${pad(d)}`}
                    onClick={() => set({ y: view.y, mo: view.mo, d })}
                    className={`size-7 cursor-pointer rounded-md text-xs disabled:cursor-not-allowed disabled:opacity-30 ${
                      selected ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    {d}
                  </button>
                );
              })()
            ),
          )}
        </div>
      </div>

      <div className="flex gap-1.5">
        <TimeColumn
          label="Hour"
          values={HOURS}
          current={chosen.h}
          testid={`${idPrefix}-hour`}
          onPick={(h) => set({ h })}
        />
        <TimeColumn
          label="Min"
          values={MINUTES}
          current={chosen.mi}
          testid={`${idPrefix}-minute`}
          onPick={(mi) => set({ mi })}
        />
      </div>
    </div>
  );
}

function TimeColumn({
  label,
  values,
  current,
  testid,
  onPick,
}: {
  label: string;
  values: number[];
  current: number;
  testid: string;
  onPick: (v: number) => void;
}) {
  return (
    <div className="flex flex-col">
      <span className="py-1 text-center text-[10px] uppercase text-muted-foreground">{label}</span>
      <div className="max-h-52 overflow-y-auto pr-0.5">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            data-testid={`${testid}-${pad(v)}`}
            onClick={() => onPick(v)}
            className={`block w-9 cursor-pointer rounded-md py-1 text-center text-xs tabular-nums ${
              current === v ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            {pad(v)}
          </button>
        ))}
      </div>
    </div>
  );
}
