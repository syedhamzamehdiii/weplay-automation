import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isWePlaySignedIn, weplayName } from "../accountIdentity";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { Account, AppSettings, Job, Run } from "../types";

export function JobsPage() {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api<Job[]>("/api/jobs") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/api/runs") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Account[]>("/api/accounts") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<AppSettings>("/api/settings") });

  const signedIn = useMemo(() => (accounts.data ?? []).filter(isWePlaySignedIn), [accounts.data]);
  const accountById = useMemo(
    () => Object.fromEntries((accounts.data ?? []).map((account) => [account.id, account])),
    [accounts.data]
  );

  const durations = settings.data?.allowedDurationsMs ?? [60_000, 180_000, 300_000, 900_000];
  const [name, setName] = useState("Join game");
  const [gameCode, setGameCode] = useState("");
  const [durationMs, setDurationMs] = useState(300_000);
  const [selected, setSelected] = useState<string[]>([]);
  const [showSupport, setShowSupport] = useState(false);
  const [personName, setPersonName] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      if (selected.length === 0) {
        throw new Error("Select at least one WePlay account");
      }
      if (!gameCode.trim()) {
        throw new Error("Enter a WePlay game code");
      }
      if (showSupport && !personName.trim()) {
        throw new Error("Enter the name of the person to support");
      }
      const allowed = durations.includes(durationMs) ? durationMs : durations[0]!;
      const run = await api<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || (showSupport ? `Support ${personName.trim()}` : `Join ${gameCode.trim()}`),
          configuration: {
            kind: showSupport ? "support" : "join_room",
            roomId: gameCode.trim(),
            supportTarget: showSupport ? personName.trim() : "",
            accountIds: selected,
            durationMs: allowed,
            intervalMs: showSupport ? (settings.data?.defaultIntervalMs ?? 0) : 0
          }
        })
      });
      await api("/api/controller/start", { method: "POST" });
      await api(`/api/runs/${run.id}/start`, { method: "POST" });
      return run;
    },
    onSuccess: () => {
      setSelected([]);
      void queryClient.invalidateQueries();
    }
  });
  const runAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api(`/api/runs/${id}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries()
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  function toggleAccount(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function selectAll() {
    setSelected(signedIn.map((account) => account.id));
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          Create a job from WePlay accounts that have already signed in. Enter the game code they should join. Optionally
          turn on support and name the person to help.
        </p>
      </div>

      <form onSubmit={onSubmit} className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 md:grid-cols-2">
        <label className="text-sm">
          Job name
          <input
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="text-sm">
          WePlay game code
          <input
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            value={gameCode}
            onChange={(e) => setGameCode(e.target.value)}
            placeholder="e.g. N518546"
            required
          />
        </label>
        <label className="text-sm">
          Keep job open
          <select
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            value={String(durations.includes(durationMs) ? durationMs : durations[0])}
            onChange={(e) => setDurationMs(Number(e.target.value))}
          >
            {durations.map((ms) => (
              <option key={ms} value={ms}>
                {ms / 60000} minute{ms === 60000 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={showSupport} onChange={(e) => setShowSupport(e.target.checked)} />
          Show support
        </label>
        {showSupport ? (
          <label className="text-sm md:col-span-2">
            Name of person
            <input
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              placeholder="Person to support in WePlay"
              required
            />
          </label>
        ) : null}
        <fieldset className="text-sm md:col-span-2">
          <legend className="mb-2">Accounts (WePlay name)</legend>
          <div className="mb-2">
            <button type="button" className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs" onClick={selectAll} disabled={signedIn.length === 0}>
              Select all
            </button>
          </div>
          <div className="max-h-48 space-y-2 overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
            {signedIn.map((account) => (
              <label key={account.id} className="flex items-center gap-2">
                <input type="checkbox" checked={selected.includes(account.id)} onChange={() => toggleAccount(account.id)} />
                <span>
                  {weplayName(account)}
                  <span className="ml-2 text-xs text-zinc-500">
                    {account.displayName} · {account.status}
                  </span>
                </span>
              </label>
            ))}
            {signedIn.length === 0 ? (
              <p className="text-zinc-500">
                No WePlay-signed-in accounts yet. Create them from{" "}
                <Link className="text-sky-300 underline" to="/accounts/create">
                  Create WePlay Accounts
                </Link>
                .
              </p>
            ) : null}
          </div>
        </fieldset>
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm" disabled={create.isPending || signedIn.length === 0}>
          {create.isPending ? "Starting…" : showSupport ? "Create support job" : "Create join job"}
        </button>
        {create.error ? <span className="text-sm text-rose-400">{(create.error as Error).message}</span> : null}
      </form>

      <section>
        <h2 className="mb-3 font-medium">Runs</h2>
        <ul className="space-y-2">
          {(runs.data ?? []).map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 text-sm">
              <StatusBadge value={run.status} />
              <span>{run.name}</span>
              <span className="text-zinc-500">code {run.configuration.roomId}</span>
              <span className="text-zinc-500">{run.configuration.kind ?? "join_room"}</span>
              {run.configuration.kind === "support" && run.configuration.supportTarget ? (
                <span className="text-zinc-500">person {run.configuration.supportTarget}</span>
              ) : null}
              <button className="text-sky-300" onClick={() => runAction.mutate({ id: run.id, action: "start" })}>
                Start
              </button>
              <button className="text-amber-300" onClick={() => runAction.mutate({ id: run.id, action: "pause" })}>
                Pause
              </button>
              <button className="text-sky-300" onClick={() => runAction.mutate({ id: run.id, action: "resume" })}>
                Resume
              </button>
              <button className="text-rose-300" onClick={() => runAction.mutate({ id: run.id, action: "stop" })}>
                Stop
              </button>
            </li>
          ))}
          {(runs.data ?? []).length === 0 ? <p className="text-sm text-zinc-500">No runs yet.</p> : null}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Job queue</h2>
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">WePlay name</th>
                <th className="px-4 py-2">Game code</th>
                <th className="px-4 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).map((job) => {
                const account = job.accountId ? accountById[job.accountId] : undefined;
                return (
                  <tr key={job.id} className="border-t border-zinc-800">
                    <td className="px-4 py-2">
                      <StatusBadge value={job.status} />
                    </td>
                    <td className="px-4 py-2">{job.configuration.kind}</td>
                    <td className="px-4 py-2">
                      {account ? (
                        <Link className="text-sky-300 hover:underline" to={`/accounts/${account.id}`}>
                          {weplayName(account)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{job.configuration.roomId ?? "—"}</td>
                    <td className="px-4 py-2 text-rose-300">{job.errorCode ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {jobs.isLoading ? <p className="px-4 py-3 text-sm text-zinc-500">Loading jobs…</p> : null}
          {!jobs.isLoading && (jobs.data ?? []).length === 0 ? (
            <p className="px-4 py-3 text-sm text-zinc-500">No jobs yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
