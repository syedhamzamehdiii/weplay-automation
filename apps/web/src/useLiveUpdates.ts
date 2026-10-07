import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "./api";

export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const token = getToken();
    if (!token) {
      return;
    }
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    let timer: number | undefined;
    const invalidate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void queryClient.invalidateQueries();
      }, 400);
    };
    source.addEventListener("changed", invalidate);
    source.addEventListener("stats", invalidate);
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [queryClient]);
}
