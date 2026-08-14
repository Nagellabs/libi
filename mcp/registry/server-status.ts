export type ServerStatus = "unknown" | "starting" | "up" | "down";

export type ServerStatusEvent =
  | { type: "retry" }
  | { type: "probe_success" }
  | { type: "probe_fail" }
  | { type: "reset" };

export function nextServerStatus(
  current: ServerStatus,
  event: ServerStatusEvent,
): ServerStatus {
  if (event.type === "reset") return "unknown";
  if (event.type === "retry") return "starting";
  if (current === "starting" && event.type === "probe_success") return "up";
  if (current === "starting" && event.type === "probe_fail") return "down";
  return current;
}
