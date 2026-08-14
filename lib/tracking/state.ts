export type TrackState = "idle" | "queued" | "running" | "ready" | "failed";
export type TrackEvent = { type: "enqueue" | "start" | "success" | "error" | "drop" };

const TABLE: Record<TrackState, Partial<Record<TrackEvent["type"], TrackState>>> = {
  idle:    { enqueue: "queued" },
  queued:  { start: "running", drop: "idle" },
  running: { success: "ready", error: "failed" },
  ready:   { enqueue: "queued", drop: "idle" },
  failed:  { enqueue: "queued", drop: "idle" },
};

export function nextTrackState(current: TrackState, event: TrackEvent): TrackState {
  const next = TABLE[current]?.[event.type];
  if (!next) throw new Error(`invalid transition: ${current} + ${event.type}`);
  return next;
}
