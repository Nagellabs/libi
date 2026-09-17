// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * `McpServersView` took an `active` prop — "false while another tab is
 * showing — stops the detector poll" — and `McpsSkillsPage` passed
 * `active={tab === "mcp"}`. It could never be false: base-ui's `Tabs.Panel`
 * defaults to `keepMounted: false`, so the panel's whole subtree is UNMOUNTED
 * while the other tab shows. A component that is not rendered cannot receive a
 * `false`, so the prop read as a visibility gate while doing nothing — exactly
 * the shape that invites the next person to rely on it.
 *
 * The prop is gone; the poll is gated on document visibility alone. This test
 * pins the base-ui behaviour that removal rests on — if `Tabs.Panel` ever
 * starts keeping panels mounted by default, the poll silently starts running
 * behind a hidden tab and this fails first.
 *
 * (The same unmount is load-bearing elsewhere in that file: the parked
 * `libi.show_extension` scroll intent exists precisely because the live
 * event has nobody to reach while the Skills tab is up.)
 */

function Probe({ onMount }: { onMount: (n: number) => void }) {
  const [n] = useState(() => Date.now());
  useEffect(() => {
    onMount(n);
    return () => onMount(-1);
  }, [n, onMount]);
  return <div data-testid="probe">panel body</div>;
}

describe("Tabs.Panel — the inactive panel unmounts", () => {
  it("does not render the inactive panel's subtree at all", () => {
    const events: number[] = [];
    render(
      <Tabs defaultValue="skills">
        <TabsList>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">Providers</TabsTrigger>
        </TabsList>
        <TabsContent value="skills">
          <div data-testid="skills">skills body</div>
        </TabsContent>
        <TabsContent value="mcp">
          <Probe onMount={(n) => events.push(n)} />
        </TabsContent>
      </Tabs>,
    );

    // Not hidden — absent. A `hidden` node would still be queryable.
    expect(screen.getByTestId("skills")).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
    expect(events).toEqual([]);

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(screen.getByTestId("probe")).toBeInTheDocument();
    expect(events).toHaveLength(1);

    // …and back: the panel unmounts again rather than re-rendering with a
    // falsy visibility prop.
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
    expect(events[events.length - 1]).toBe(-1);
  });
});
