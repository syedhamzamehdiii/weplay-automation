import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { Account, DeviceFarmConnectionStatus, DeviceFarmProvisioning, Job } from "../types";

interface WorkspaceCandidate {
  googleUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  loginProvider: "GOOGLE";
  workspaceStatus: "ACTIVE" | "SUSPENDED";
  weplayAccountId: string | null;
  weplayStatus: string | null;
  weplaySetupStatus: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  lastErrorMessage: string | null;
}

interface QueueResult {
  email: string;
  ok: boolean;
  error?: string;
}

function workspaceEmailFrom(account: Account): string {
  return String(account.metadata?.workspaceEmail ?? "")
    .trim()
    .toLowerCase();
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatchResults(emails: string[]): Promise<QueueResult[]> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const accounts = await api<Account[]>("/api/accounts");
    const results = emails.map((email) => {
      const account = accounts.find((row) => workspaceEmailFrom(row) === email.toLowerCase());
      const ok = account?.status === "READY";
      return {
        email,
        ok,
        error: ok ? undefined : account?.lastErrorMessage || undefined,
        pending: account?.status === "SETUP_IN_PROGRESS"
      };
    });
    if (!results.some((row) => row.pending)) {
      return results.map(({ pending: _pending, ...row }) => ({
        ...row,
        error: row.ok ? undefined : row.error || "Failed"
      }));
    }
    await wait(1000);
  }
  const accounts = await api<Account[]>("/api/accounts");
  return emails.map((email) => {
    const account = accounts.find((row) => workspaceEmailFrom(row) === email.toLowerCase());
    const ok = account?.status === "READY";
    return {
      email,
      ok,
      error: ok
        ? undefined
        : account?.lastErrorMessage ||
          (account?.status === "SETUP_IN_PROGRESS" ? "Device Farm run still finishing on the Pixel" : "Failed")
    };
  });
}

function isDeviceFarmNetworkFailure(error?: string): boolean {
  const hay = (error ?? "").toLowerCase();
  return (
    hay.includes("enotfound") ||
    hay.includes("getaddrinfo") ||
    hay.includes("eai_again") ||
    hay.includes("etimedout") ||
    hay.includes("econnreset") ||
    hay.includes("network")
  );
}

export function CreateWePlayAccountPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeEmail, setActiveEmail] = useState("");
  const [queueTotal, setQueueTotal] = useState(0);
  const [results, setResults] = useState<QueueResult[]>([]);
  const handledStatusRef = useRef<string | null>(null);
  const queueTotalRef = useRef(0);
  const batchEmailsRef = useRef<string[]>([]);
  const queueActive = Boolean(pendingId) || Boolean(activeEmail);
  const deviceFarm = useQuery({
    queryKey: ["devicefarm-status"],
    queryFn: () => api<DeviceFarmConnectionStatus>("/api/devicefarm/status"),
    refetchInterval: 4000
  });
  const candidates = useQuery({
    queryKey: ["workspace-candidates"],
    queryFn: () => api<WorkspaceCandidate[]>("/api/accounts/workspace-candidates"),
    refetchInterval: queueActive ? 4000 : false
  });

  const eligible = useMemo(() => (candidates.data ?? []).filter((row) => row.eligible), [candidates.data]);
  const allEligibleSelected = eligible.length > 0 && eligible.every((row) => selectedEmails.includes(row.email));
  const someEligibleSelected = eligible.some((row) => selectedEmails.includes(row.email));
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someEligibleSelected && !allEligibleSelected;
    }
  }, [allEligibleSelected, someEligibleSelected]);

  const selected = useMemo(
    () => (candidates.data ?? []).filter((row) => selectedEmails.includes(row.email)),
    [candidates.data, selectedEmails]
  );

  const pendingAccount = useQuery({
    queryKey: ["account", pendingId],
    queryFn: () => api<Account>(`/api/accounts/${pendingId}`),
    enabled: Boolean(pendingId),
    refetchInterval: pendingId ? 2000 : false
  });
  const pendingFarm = useQuery({
    queryKey: ["account-devicefarm", pendingId],
    queryFn: () => api<{ provisioning: DeviceFarmProvisioning | null }>(`/api/accounts/${pendingId}/devicefarm`),
    enabled: Boolean(pendingId),
    refetchInterval: pendingId ? 2000 : false
  });

  const startDeviceFarm = useMutation({
    mutationFn: (emails: string[]) =>
      api<{ account: Account; accounts?: Account[]; provisioning: DeviceFarmProvisioning; job: Job }>(
        "/api/devicefarm/provision",
        {
          method: "POST",
          body: JSON.stringify(emails.length === 1 ? { email: emails[0] } : { emails })
        }
      ),
    onSuccess: (result, emails) => {
      setCreateError(null);
      setPendingId(result.account.id);
      setActiveEmail(emails.length === 1 ? emails[0]! : `${emails.length} accounts on one Pixel`);
    },
    onError: (error) => {
      setCreateError((error as Error).message);
      setPendingId(null);
      if (isDeviceFarmNetworkFailure((error as Error).message)) {
        setActiveEmail("");
      }
    }
  });

  useEffect(() => {
    const provisioning = pendingFarm.data?.provisioning;
    const inFlight = deviceFarm.data?.inFlight ?? 0;
    if (!pendingId || !provisioning || !activeEmail) {
      return;
    }
    const terminal =
      provisioning.provisioningStatus === "SUCCEEDED" ||
      provisioning.provisioningStatus === "FAILED" ||
      provisioning.provisioningStatus === "ACTION_REQUIRED";
    if (!terminal || inFlight > 0) {
      return;
    }
    const key = `${pendingId}:${provisioning.provisioningStatus}:${inFlight}`;
    if (handledStatusRef.current === key) {
      return;
    }
    handledStatusRef.current = key;
    const emails = batchEmailsRef.current;
    void (async () => {
      setResults(await fetchBatchResults(emails));
      setPendingId(null);
      setActiveEmail("");
      void queryClient.invalidateQueries({ queryKey: ["workspace-candidates"] });
      void queryClient.invalidateQueries({ queryKey: ["devicefarm-status"] });
      const accounts = await api<Account[]>("/api/accounts");
      if (
        emails.length <= 1 &&
        accounts.some((row) => workspaceEmailFrom(row) === emails[0]?.toLowerCase() && row.status === "READY")
      ) {
        navigate("/accounts");
      }
    })();
  }, [
    activeEmail,
    deviceFarm.data?.inFlight,
    navigate,
    pendingFarm.data?.provisioning,
    pendingId,
    queryClient
  ]);

  const creating = Boolean(pendingId) || startDeviceFarm.isPending || Boolean(activeEmail);
  const progress =
    typeof pendingAccount.data?.metadata?.setupProgress === "string"
      ? pendingAccount.data.metadata.setupProgress
      : pendingFarm.data?.provisioning?.provisioningStatus
        ? `Device Farm ${pendingFarm.data.provisioning.provisioningStatus}`
        : startDeviceFarm.isPending
          ? "Queuing one Pixel run…"
          : "";

  function toggleEmail(email: string) {
    setSelectedEmails((current) =>
      current.includes(email) ? current.filter((item) => item !== email) : [...current, email]
    );
  }

  function toggleSelectAll() {
    if (allEligibleSelected) {
      setSelectedEmails([]);
      return;
    }
    setSelectedEmails(eligible.map((row) => row.email));
  }

  function startSelected() {
    const emails = selected.filter((row) => row.eligible).map((row) => row.email);
    if (emails.length === 0) {
      return;
    }
    setCreateError(null);
    setResults([]);
    setQueueTotal(emails.length);
    queueTotalRef.current = emails.length;
    batchEmailsRef.current = emails;
    handledStatusRef.current = null;
    startDeviceFarm.mutate(emails);
  }

  const failed = results.filter((row) => !row.ok);
  const succeeded = results.filter((row) => row.ok);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/accounts" className="text-sm text-zinc-500">
          ← Accounts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Create WePlay Accounts</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          This is the locked Pixel flow: Play identity (kabeer) once → Play Store install WePlay once → then each
          selected Workspace account is added with Add another Google account and signed into WePlay on the same Pixel.
          One Device Farm run for the whole selection. Join a room later from Jobs.
        </p>
      </div>

      {candidates.error ? <p className="text-sm text-rose-400">{(candidates.error as Error).message}</p> : null}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded-lg bg-zinc-800 px-3 py-2 text-sm"
            disabled={creating || eligible.length === 0}
            onClick={toggleSelectAll}
          >
            {allEligibleSelected ? "Clear selection" : `Select all eligible (${eligible.length})`}
          </button>
          <button
            type="button"
            className="rounded-lg bg-sky-700 px-4 py-2 text-sm"
            disabled={creating || selected.length === 0 || !deviceFarm.data?.configured || (deviceFarm.data.inFlight ?? 0) > 0}
            onClick={startSelected}
          >
            {creating
              ? `One Pixel run (${queueTotal} account${queueTotal === 1 ? "" : "s"})…`
              : selected.length <= 1
                ? "Start Device Farm worker (1 account)"
                : `Start one Pixel run (${selected.length} accounts)`}
          </button>
        </div>
        {creating && progress ? (
          <p className="text-sm text-sky-300">
            {queueTotal > 1 ? `${queueTotal} accounts, one Pixel. ` : ""}
            {progress}
          </p>
        ) : null}
        {startDeviceFarm.error ? (
          <p className="text-sm text-rose-400">{(startDeviceFarm.error as Error).message}</p>
        ) : null}
        {createError ? <p className="text-sm text-rose-400">{createError}</p> : null}
        {deviceFarm.data && !deviceFarm.data.configured ? (
          <p className="text-sm text-zinc-500">
            {deviceFarm.data.warning || "AWS Device Farm is not configured on the API yet."}
          </p>
        ) : null}
        {deviceFarm.data?.configured && (deviceFarm.data.inFlight ?? 0) > 0 && !creating ? (
          <p className="text-sm text-amber-300">
            A Pixel worker is already running. Wait for this run to finish, then start the next selection.
          </p>
        ) : null}
        {deviceFarm.data?.configured && selectedEmails.length === 0 && !creating ? (
          <p className="text-sm text-zinc-500">Select eligible Workspace accounts, then start the Device Farm worker.</p>
        ) : null}
        {!creating && queueTotal > 0 && results.length === queueTotal ? (
          <p className="text-sm text-zinc-300">
            Finished {succeeded.length} of {queueTotal} WePlay account{queueTotal === 1 ? "" : "s"}.
            {failed.length ? ` ${failed.length} failed.` : ""}{" "}
            <Link className="text-sky-300 underline" to="/accounts">
              View Accounts
            </Link>
          </p>
        ) : null}
        {failed.length > 0 ? (
          <ul className="space-y-1 text-sm text-rose-400">
            {failed.map((row) => (
              <li key={row.email}>
                {row.email}: {row.error || "Failed"}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-4 py-2">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label="Select all eligible Workspace accounts"
                    disabled={creating || eligible.length === 0}
                    checked={allEligibleSelected}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Workspace email</th>
                <th className="px-4 py-2">Workspace</th>
                <th className="px-4 py-2">WePlay</th>
              </tr>
            </thead>
            <tbody>
              {(candidates.data ?? []).map((row) => (
                <tr key={row.email} className="border-t border-zinc-800">
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      disabled={!row.eligible || creating}
                      checked={selectedEmails.includes(row.email)}
                      onChange={() => toggleEmail(row.email)}
                      aria-label={`Select ${row.email}`}
                    />
                  </td>
                  <td className="px-4 py-2">{row.displayName}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
                  <td className="px-4 py-2">
                    <StatusBadge value={row.workspaceStatus} />
                  </td>
                  <td className="px-4 py-2">
                    {row.weplayStatus ? <StatusBadge value={row.weplayStatus} /> : <span className="text-zinc-500">Not started</span>}
                    {row.ineligibleReason ? <p className="mt-1 text-xs text-zinc-500">{row.ineligibleReason}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {candidates.isLoading ? <p className="px-4 py-3 text-sm text-zinc-500">Loading Workspace users…</p> : null}
          {!candidates.isLoading && (candidates.data ?? []).length === 0 ? (
            <p className="px-4 py-3 text-sm text-zinc-500">No Google Workspace users found.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
