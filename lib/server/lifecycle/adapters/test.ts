import type { LifecycleAdapter, LifecycleEvent } from "../types";

export interface TestAdapter extends LifecycleAdapter {
  captured(): LifecycleEvent[];
}

export function testAdapter(): TestAdapter {
  const events: LifecycleEvent[] = [];
  return {
    onEvent: (e) => events.push(e),
    captured: () => events,
  };
}
