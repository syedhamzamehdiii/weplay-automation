import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadCsv } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { StatCard } from "../components/StatCard";

interface WorkspaceConnectionStatus {
  configured: boolean;
  domain: string | null;
  adminEmailConfigured: boolean;
  credentialsConfigured: boolean;
  scope: string;
  concurrency: number;
  maxRetries: number;
  warning: string;
}

interface WorkspaceUsage {
  totalUsers: number | null;
  remainingLicenses: number | null;
  remainingUnavailableReason: string | null;
}

interface WorkspaceProvisioningStats {
  requested: number;
  valid: number;
  creating: number;
  created: number;
  alreadyExists: number;
  failed: number;
  remaining: number;
  retrying: number;
}

interface WorkspaceProvisioningBatch {
  id: string;
  name: string;
  domain: string;
  status: string;
  requestedCount: number;
  createdAt: number;
  stats?: WorkspaceProvisioningStats;
}

interface WorkspaceUserProvisioning {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  requestedUsername: string;
  fullEmail: string;
  status: string;
  googleUserId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
}

interface BatchDetail {
  batch: WorkspaceProvisioningBatch;
  users: WorkspaceUserProvisioning[];
  stats: WorkspaceProvisioningStats;
  connection: WorkspaceConnectionStatus;
}

interface ImportResponse {
  batch: WorkspaceProvisioningBatch;
  users: WorkspaceUserProvisioning[];
  stats: WorkspaceProvisioningStats;
  parseIssues: Array<{ lineNumber: number; username: string | null; message: string }>;
}

function formatCount(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function isFailedBatch(item: WorkspaceProvisioningBatch): boolean {
  return (item.stats?.failed ?? 0) > 0 || item.status === "CANCELLED";
}

export function WorkspaceUsersPage() {
  const queryClient = useQueryClient();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const usage = useQuery({
    queryKey: ["workspace-usage"],
    queryFn: () => api<WorkspaceUsage>("/api/workspace/usage"),
    refetchInterval: 30_000
  });
  const status = useQuery({
    queryKey: ["workspace-status"],
    queryFn: () => api<WorkspaceConnectionStatus>("/api/workspace/status")
  });
  const batches = useQuery({
    queryKey: ["workspace-batches"],
    queryFn: () => api<WorkspaceProvisioningBatch[]>("/api/workspace/batches")
  });
  const detail = useQuery({
    queryKey: ["workspace-batch", selectedId],
    queryFn: () => api<BatchDetail>(`/api/workspace/batches/${selectedId}`),
    enabled: Boolean(selectedId)
  });

  const importCsv = useMutation({
    mutationFn: () =>
      api<ImportResponse>("/api/workspace/batches/import", {
        method: "POST",
        body: JSON.stringify({ csv: csvText, name: fileName || undefined })
      }),
    onSuccess: (result) => {
      setSelectedId(result.batch.id);
      void queryClient.invalidateQueries();
    }
  });
  const validate = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}/validate`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const start = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}/start`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const pause = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}/pause`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const resume = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}/resume`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });
  const deleteBatch = useMutation({
    mutationFn: (id: string) => api(`/api/workspace/batches/${id}`, { method: "DELETE" }),
    onSuccess: (_result, id) => {
      if (selectedId === id) {
        setSelectedId(null);
      }
      void queryClient.invalidateQueries();
    }
  });
  const deleteFailedUser = useMutation({
    mutationFn: ({ batchId, userId }: { batchId: string; userId: string }) =>
      api(`/api/workspace/batches/${batchId}/users/${userId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries()
  });

  const batch = detail.data?.batch;
  const stats = detail.data?.stats;
  const users = detail.data?.users ?? [];
  const failed = useMemo(() => users.filter((user) => user.status === "FAILED"), [users]);
  const domain = status.data?.domain ?? batch?.domain ?? "your-domain";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    importCsv.mutate();
  }

  async function onFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setFileName(file.name.replace(/\.csv$/i, ""));
    setCsvText(await file.text());
  }

  function confirmDeleteBatch(item: WorkspaceProvisioningBatch) {
    if (!window.confirm(`Delete batch "${item.name}" from this dashboard? Google Workspace accounts will not be deleted.`)) {
      return;
    }
    deleteBatch.mutate(item.id);
  }

  function confirmDeleteUser(user: WorkspaceUserProvisioning) {
    if (!window.confirm(`Remove failed user ${user.fullEmail} from this batch?`)) {
      return;
    }
    if (!batch) {
      return;
    }
    deleteFailedUser.mutate({ batchId: batch.id, userId: user.id });
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Google Workspace Users</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Import and create Workspace accounts here. WePlay login on a Pixel is started from Accounts → Create WePlay
          Accounts.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatCard
          label="Total accounts created in Google Workspace"
          value={usage.isLoading ? "…" : formatCount(usage.data?.totalUsers)}
        />
        <StatCard
          label="Remaining account limit of Google Workspace"
          value={usage.isLoading ? "…" : formatCount(usage.data?.remainingLicenses)}
        />
      </div>
      {usage.isError && !usage.data ? <p className="text-sm text-rose-400">{(usage.error as Error).message}</p> : null}
      {!usage.isLoading && usage.data && usage.data.remainingLicenses === null ? (
        <p className="text-sm text-zinc-500">
          {usage.data.remainingUnavailableReason ??
            "Remaining license count is unavailable. Open Google Admin → Billing → Subscriptions for the live seat limit."}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="font-medium">Import CSV</h2>
        <p className="text-sm text-zinc-400">
          Required columns: <span className="font-mono">firstName,lastName,username</span>. Optional:{" "}
          <span className="font-mono">displayName</span>. Emails become{" "}
          <span className="font-mono">username@{domain}</span>.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          className="block text-sm"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
        <textarea
          className="h-40 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm"
          placeholder={"firstName,lastName,username\nHamza,Ahmed,user001"}
          value={csvText}
          onChange={(event) => setCsvText(event.target.value)}
        />
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm" disabled={importCsv.isPending || !csvText.trim()}>
          {importCsv.isPending ? "Importing…" : "Import and preview"}
        </button>
        {importCsv.error ? <p className="text-sm text-rose-400">{(importCsv.error as Error).message}</p> : null}
      </form>

      <section>
        <h2 className="mb-3 font-medium">Batches</h2>
        <ul className="space-y-2">
          {(batches.data ?? []).map((item) => (
            <li key={item.id} className="flex items-stretch gap-2">
              <button
                className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left text-sm ${
                  selectedId === item.id ? "border-sky-700 bg-sky-950/40" : "border-zinc-800 hover:bg-zinc-900"
                }`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="mr-2">
                  <StatusBadge value={item.status} />
                </span>
                {isFailedBatch(item) ? (
                  <span className="mr-2">
                    <StatusBadge value="FAILED" />
                  </span>
                ) : null}
                {item.name}{" "}
                <span className="text-zinc-500">
                  ({item.requestedCount} users @ {item.domain}
                  {(item.stats?.failed ?? 0) > 0 ? `, ${item.stats?.failed} failed` : ""})
                </span>
              </button>
              {isFailedBatch(item) && item.status !== "RUNNING" ? (
                <button
                  className="rounded-lg bg-rose-800 px-3 py-2 text-sm"
                  disabled={deleteBatch.isPending}
                  onClick={() => confirmDeleteBatch(item)}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
          {(batches.data ?? []).length === 0 ? <p className="text-sm text-zinc-500">No imports yet.</p> : null}
        </ul>
        {deleteBatch.error ? <p className="mt-2 text-sm text-rose-400">{(deleteBatch.error as Error).message}</p> : null}
      </section>

      {batch && stats ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-xl font-medium">{batch.name}</h2>
            <StatusBadge value={batch.status} />
            {stats.failed > 0 ? <StatusBadge value="FAILED" /> : null}
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard label="Requested" value={stats.requested} />
            <StatCard label="Valid" value={stats.valid} />
            <StatCard label="Creating" value={stats.creating} />
            <StatCard label="Created" value={stats.created} />
            <StatCard label="Already exists" value={stats.alreadyExists} />
            <StatCard label="Failed" value={stats.failed} warn />
            <StatCard label="Retrying" value={stats.retrying} />
            <StatCard label="Remaining" value={stats.remaining} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm" onClick={() => validate.mutate(batch.id)}>
              Validate
            </button>
            <button className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm" onClick={() => start.mutate(batch.id)}>
              Start
            </button>
            <button className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm" onClick={() => pause.mutate(batch.id)}>
              Pause
            </button>
            <button className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm" onClick={() => resume.mutate(batch.id)}>
              Resume
            </button>
            <button className="rounded-lg bg-rose-700 px-3 py-1.5 text-sm" onClick={() => cancel.mutate(batch.id)}>
              Cancel
            </button>
            {isFailedBatch(batch) && batch.status !== "RUNNING" ? (
              <button
                className="rounded-lg bg-rose-800 px-3 py-1.5 text-sm"
                disabled={deleteBatch.isPending}
                onClick={() => confirmDeleteBatch(batch)}
              >
                Delete batch
              </button>
            ) : null}
            <button
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm"
              onClick={() => void downloadCsv(`/api/workspace/batches/${batch.id}/export`, `workspace-${batch.id}.csv`)}
            >
              Export result
            </button>
          </div>
          {(validate.error || start.error || pause.error || resume.error || cancel.error || deleteFailedUser.error) && (
            <p className="text-sm text-rose-400">
              {(validate.error as Error | undefined)?.message ||
                (start.error as Error | undefined)?.message ||
                (pause.error as Error | undefined)?.message ||
                (resume.error as Error | undefined)?.message ||
                (cancel.error as Error | undefined)?.message ||
                (deleteFailedUser.error as Error | undefined)?.message}
            </p>
          )}

          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Google user ID</th>
                  <th className="px-4 py-2">Error</th>
                  <th className="px-4 py-2"> </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-zinc-800">
                    <td className="px-4 py-2">
                      <StatusBadge value={user.status} />
                    </td>
                    <td className="px-4 py-2">
                      {user.firstName} {user.lastName}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{user.fullEmail}</td>
                    <td className="px-4 py-2 font-mono text-xs">{user.googleUserId ?? "—"}</td>
                    <td className="px-4 py-2 text-rose-300">{user.errorMessage ?? "—"}</td>
                    <td className="px-4 py-2">
                      {user.status === "FAILED" ? (
                        <button
                          className="rounded bg-rose-800 px-2 py-1 text-xs"
                          disabled={deleteFailedUser.isPending}
                          onClick={() => confirmDeleteUser(user)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {failed.length > 0 ? (
            <div>
              <h3 className="mb-2 font-medium text-rose-300">Failed users</h3>
              <ul className="space-y-1 text-sm">
                {failed.map((user) => (
                  <li key={user.id} className="flex items-center justify-between gap-3">
                    <span>
                      <span className="font-mono">{user.fullEmail}</span>: {user.errorCode} — {user.errorMessage}
                    </span>
                    <button
                      className="shrink-0 rounded bg-rose-800 px-2 py-1 text-xs"
                      disabled={deleteFailedUser.isPending}
                      onClick={() => confirmDeleteUser(user)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
