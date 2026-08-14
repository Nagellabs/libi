"use client";

import { useMutation } from "@tanstack/react-query";

export function useResetServer() {
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/server-status/reset", { method: "POST" });
      // 202 — server will exit; we don't read a meaningful body.
      return res.status === 202;
    },
  });
}
