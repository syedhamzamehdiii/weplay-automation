import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useDeviceFarmStatus } from "../components/DeviceFarmStatus";
import { StatCard } from "../components/StatCard";
import type { DashboardStats } from "../types";

export function DashboardPage() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api<DashboardStats>("/api/dashboard/stats") });
  const deviceFarm = useDeviceFarmStatus();
  const data = stats.data;
  if (!data) {
    return <p className="text-zinc-400">Loading…</p>;
  }
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Amazon Device Farm" value={deviceFarm.data?.availability ?? "…"} />
        <StatCard label="Ready" value={data.readyAccounts} />
        <StatCard label="Setup required" value={data.setupRequiredAccounts} warn />
        <StatCard label="Action required" value={data.actionRequiredAccounts ?? 0} warn />
        <StatCard label="Needs re-auth" value={data.needsReauthAccounts} warn />
        <StatCard label="Processing" value={data.processingAccounts} />
        <StatCard label="Successful" value={data.successfulAccounts} />
        <StatCard label="Failed" value={data.failedAccounts} warn />
        <StatCard label="Queued jobs" value={data.queuedJobs} />
        <StatCard label="Running jobs" value={data.runningJobs} />
        <StatCard label="Completed jobs" value={data.completedJobs} />
      </div>
      <p className="mt-6 text-sm text-zinc-400">
        Import or create Workspace users from{" "}
        <Link className="text-sky-300 underline" to="/workspace">
          Google Workspace
        </Link>
        , then start WePlay provisioning from{" "}
        <Link className="text-sky-300 underline" to="/accounts/create">
          Create WePlay Accounts
        </Link>{" "}
        on AWS Device Farm.
      </p>
    </div>
  );
}
