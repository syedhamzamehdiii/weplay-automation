import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { canStartDeviceFarm, deviceFarmEmail, identityLabel, progressText, providerLabel } from "../accountIdentity";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { Account, DeviceFarmProvisioning, EventLog, Job } from "../types";

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const account = useQuery({
    queryKey: ["account", id],
    queryFn: () => api<Account>(`/api/accounts/${id}`),
    refetchInterval: 2500
  });
  const history = useQuery({
    queryKey: ["account-history", id],
    queryFn: () => api<{ logs: EventLog[]; jobs: Job[] }>(`/api/accounts/${id}/history`),
    refetchInterval: 2500
  });
  const deviceFarm = useQuery({
    queryKey: ["account-devicefarm", id],
    queryFn: () => api<{ provisioning: DeviceFarmProvisioning | null }>(`/api/accounts/${id}/devicefarm`),
    refetchInterval: 2500
  });

  const email = deviceFarmEmail(account.data ?? ({ metadata: {}, loginProvider: "" } as Account));
  const startDeviceFarm = useMutation({
    mutationFn: () =>
      api<{ account: Account; provisioning: DeviceFarmProvisioning; job: Job }>("/api/devicefarm/provision", {
        method: "POST",
        body: JSON.stringify({ email })
      }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const save = useMutation({
    mutationFn: (payload: { displayName?: string }) =>
      api(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const toggleEnabled = useMutation({
    mutationFn: (path: string) => api(`/api/accounts/${id}${path}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => navigate("/accounts")
  });

  if (!account.data) {
    return <p className="text-zinc-400">Loading…</p>;
  }
  const row = account.data;
  const provisioning = deviceFarm.data?.provisioning;
  const deviceFarmJobs = (history.data?.jobs ?? []).filter((job) => job.configuration.kind === "devicefarm_provision");
  const facebookOrX = row.loginProvider === "FACEBOOK" || row.loginProvider === "X";

  return (
    <div className="space-y-6">
      <div>
        <Link to="/accounts" className="text-sm text-zinc-500">
          ← Accounts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{row.displayName}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <StatusBadge value={row.status} />
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
            {providerLabel(row.loginProvider)}
          </span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{identityLabel(row)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {canStartDeviceFarm(row) ? (
          <button
            className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm"
            disabled={startDeviceFarm.isPending}
            onClick={() => startDeviceFarm.mutate()}
          >
            {startDeviceFarm.isPending ? "Starting Device Farm…" : "Start Device Farm worker"}
          </button>
        ) : null}
        <button
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm"
          onClick={() => toggleEnabled.mutate(row.enabled ? "/disable" : "/enable")}
        >
          {row.enabled ? "Disable" : "Enable"}
        </button>
        <button
          className="rounded-lg bg-rose-800 px-3 py-1.5 text-sm"
          onClick={() => {
            if (confirm("Remove this account?")) {
              remove.mutate();
            }
          }}
        >
          Remove
        </button>
      </div>
      {startDeviceFarm.error ? (
        <p className="text-sm text-rose-400">{(startDeviceFarm.error as Error).message}</p>
      ) : null}
      {toggleEnabled.error ? <p className="text-sm text-rose-400">{(toggleEnabled.error as Error).message}</p> : null}
      {facebookOrX ? (
        <p className="text-xs text-zinc-500">
          This {providerLabel(row.loginProvider)} identity is imported and tracked. The Device Farm Pixel worker still
          signs into WePlay with Google after Play Store install. Facebook/X WePlay login on Device Farm is not wired
          yet.
        </p>
      ) : null}
      {row.status === "ACTION_REQUIRED" ? (
        <div className="rounded-xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-100">
          Human action was required on the Pixel (CAPTCHA, MFA, or similar). This dashboard does not collect passwords,
          OTP, or CAPTCHA. After you resolve it, start the Device Farm worker again.
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm">
          Display name
          <div className="mt-1 flex gap-2">
            <input
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              value={displayName ?? row.displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <button
              className="rounded-lg bg-zinc-800 px-3"
              onClick={() => save.mutate({ displayName: displayName ?? row.displayName })}
            >
              Save
            </button>
          </div>
        </label>
        <label className="text-sm">
          Identity
          <input
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            value={`${providerLabel(row.loginProvider)} · ${identityLabel(row)}`}
            readOnly
          />
        </label>
      </div>
      {provisioning ? (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-200">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Device Farm</h2>
          <dl className="mt-2 grid gap-1 font-mono text-xs text-zinc-400">
            <div>status: {provisioning.provisioningStatus}</div>
            <div>workspace: {provisioning.workspaceEmail}</div>
            <div>device: {provisioning.deviceName ?? "pending"}</div>
            <div>device id: {provisioning.deviceArn ?? "pending"}</div>
            <div>run: {provisioning.deviceFarmRunArn ?? "pending"}</div>
            <div>weplayUserId: {provisioning.weplayUserId ?? "not obtained"}</div>
            <div>joinedRoom: {row.metadata?.joinedRoom === true ? "yes" : "no"}</div>
          </dl>
        </section>
      ) : null}
      {progressText(row) !== "—" ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-200">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Progress</div>
          <p className="mt-1">{progressText(row)}</p>
          {typeof row.metadata?.setupScreen === "string" ? (
            <p className="mt-2 font-mono text-xs text-zinc-500">{String(row.metadata.setupScreen)}</p>
          ) : null}
        </div>
      ) : null}
      {row.lastErrorMessage ? (
        <div className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">
          {row.lastErrorCode}: {row.lastErrorMessage}
        </div>
      ) : null}
      <section>
        <h2 className="mb-2 font-medium">Device Farm jobs</h2>
        <ul className="space-y-1 text-sm text-zinc-300">
          {deviceFarmJobs.map((job) => (
            <li key={job.id} className="flex gap-3">
              <StatusBadge value={job.status} />
              <span className="font-mono text-xs">{job.id.slice(0, 8)}</span>
              <span>{job.configuration.kind}</span>
              <span className="text-rose-300">{job.errorCode}</span>
            </li>
          ))}
        </ul>
        {deviceFarmJobs.length === 0 ? <p className="text-sm text-zinc-500">No Device Farm jobs yet.</p> : null}
      </section>
      <section>
        <h2 className="mb-2 font-medium">History</h2>
        <ul className="space-y-1 text-sm text-zinc-400">
          {(history.data?.logs ?? []).map((log) => (
            <li key={log.id}>
              <span className="font-mono text-xs">{new Date(log.timestamp).toLocaleString()}</span> {log.event}{" "}
              {log.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
