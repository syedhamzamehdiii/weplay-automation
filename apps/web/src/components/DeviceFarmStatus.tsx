import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { StatusBadge } from "./StatusBadge";
import type { DeviceFarmConnectionStatus } from "../types";

export function useDeviceFarmStatus() {
  return useQuery({
    queryKey: ["devicefarm-status"],
    queryFn: () => api<DeviceFarmConnectionStatus>("/api/devicefarm/status"),
    refetchInterval: 4000
  });
}

export function DeviceFarmStatus({ compact = false }: { compact?: boolean }) {
  const status = useDeviceFarmStatus();
  const availability = status.data?.availability ?? "…";
  if (compact) {
    return (
      <div className="rounded-lg border border-zinc-800 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">Amazon Device Farm</div>
        <div className="mt-1">
          <StatusBadge value={availability} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-zinc-500">Amazon Device Farm</span>
      <StatusBadge value={availability} />
    </div>
  );
}
