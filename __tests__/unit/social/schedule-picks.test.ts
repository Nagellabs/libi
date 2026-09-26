import { describe, it, expect } from "vitest";
import { addDays, daysInMonth, describeWall, formatWall, isAfter, nowWall, quickPicks, weekdayOf } from "@/lib/social/schedule-picks";

describe("wall-clock arithmetic", () => {
  it("reads the clock in the POST'S zone, not the host's", () => {
    // 2026-09-21T20:30Z is already the 22nd in Bangkok (+07) and still the
    // 21st in New York (-04). A picker that used the host's clock would offer
    // the wrong "tomorrow" to one of them.
    const at = new Date("2026-09-21T20:30:00.000Z");
    expect(formatWall(nowWall("Asia/Bangkok", at))).toBe("2026-09-22T03:30");
    expect(formatWall(nowWall("America/New_York", at))).toBe("2026-09-21T16:30");
  });

  it("rolls days across month and year boundaries", () => {
    expect(formatWall(addDays({ y: 2026, mo: 12, d: 31, h: 9, mi: 0 }, 1))).toBe("2027-01-01T09:00");
    expect(formatWall(addDays({ y: 2028, mo: 2, d: 28, h: 9, mi: 0 }, 1))).toBe("2028-02-29T09:00");
  });

  it("counts a leap February", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 9)).toBe(30);
  });

  it("knows the weekday of a wall-clock date", () => {
    // 2026-09-21 is a Monday.
    expect(weekdayOf({ y: 2026, mo: 9, d: 21 })).toBe(1);
  });

  it("compares two wall clocks without ever building an instant", () => {
    expect(isAfter({ y: 2026, mo: 9, d: 21, h: 19, mi: 0 }, { y: 2026, mo: 9, d: 21, h: 18, mi: 30 })).toBe(true);
    expect(isAfter({ y: 2026, mo: 9, d: 21, h: 9, mi: 0 }, { y: 2026, mo: 9, d: 21, h: 9, mi: 0 })).toBe(false);
  });

  it("reads a slot back in plain words", () => {
    expect(describeWall("2026-09-22T09:00")).toBe("Tue 22 Sep, 09:00");
    expect(describeWall("")).toBe("");
  });
});

describe("quickPicks", () => {
  const at = (iso: string) => new Date(iso);

  it("offers tonight only while tonight is still ahead", () => {
    // 10:00 Bangkok — 19:00 has not happened yet.
    const morning = quickPicks("Asia/Bangkok", at("2026-09-21T03:00:00.000Z"));
    expect(morning.find((p) => p.id === "tonight")?.value).toBe("2026-09-21T19:00");

    // 21:00 Bangkok — "Tonight 7pm" would mean tomorrow, which is worse than
    // not offering it.
    const night = quickPicks("Asia/Bangkok", at("2026-09-21T14:00:00.000Z"));
    expect(night.find((p) => p.id === "tonight")).toBeUndefined();
  });

  it("computes every pick in the post's zone", () => {
    // 20:30Z on Monday the 21st = 03:30 on TUESDAY the 22nd in Bangkok, so
    // "tomorrow" is the 23rd and "next Monday" is the 28th.
    const picks = quickPicks("Asia/Bangkok", at("2026-09-21T20:30:00.000Z"));
    expect(picks.find((p) => p.id === "tomorrow")?.value).toBe("2026-09-23T09:00");
    expect(picks.find((p) => p.id === "saturday")?.value).toBe("2026-09-26T11:00");
    expect(picks.find((p) => p.id === "monday")?.value).toBe("2026-09-28T09:00");
  });

  it("never returns today for a weekday pick, even when today IS that weekday", () => {
    // 2026-09-26 is a Saturday: "Saturday 11am" must mean the NEXT one, not a
    // time that may already have passed today.
    const picks = quickPicks("UTC", at("2026-09-26T12:00:00.000Z"));
    expect(picks.find((p) => p.id === "saturday")?.value).toBe("2026-10-03T11:00");
  });

  it("every pick is in the future", () => {
    const now = at("2026-09-21T03:00:00.000Z");
    const here = formatWall(nowWall("Asia/Bangkok", now));
    for (const p of quickPicks("Asia/Bangkok", now)) expect(p.value > here).toBe(true);
  });
});
