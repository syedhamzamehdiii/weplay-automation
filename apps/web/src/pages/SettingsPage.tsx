import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { AppSettings } from "../types";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<AppSettings>("/api/settings") });
  const [form, setForm] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings.data) {
      setForm(settings.data);
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          maxJobRetries: form?.maxJobRetries,
          heartbeatTimeoutMs: form?.heartbeatTimeoutMs,
          defaultIntervalMs: form?.defaultIntervalMs,
          allowedDurationsMs: form?.allowedDurationsMs,
          jobStaleMs: form?.jobStaleMs,
          controllerTickMs: form?.controllerTickMs
        })
      }),
    onSuccess: () => queryClient.invalidateQueries()
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  if (!form) {
    return <p className="text-zinc-400">Loading…</p>;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
      <form onSubmit={onSubmit} className="max-w-lg space-y-4">
        {(
          [
            ["maxJobRetries", "Max job retries"],
            ["heartbeatTimeoutMs", "Heartbeat timeout (ms)"],
            ["defaultIntervalMs", "Default interval (ms)"],
            ["jobStaleMs", "Stale job timeout (ms)"],
            ["controllerTickMs", "Controller tick (ms)"]
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="block text-sm">
            {label}
            <input
              type="number"
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <label className="block text-sm">
          Allowed durations (ms, comma-separated)
          <input
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            value={form.allowedDurationsMs.join(",")}
            onChange={(e) =>
              setForm({
                ...form,
                allowedDurationsMs: e.target.value
                  .split(",")
                  .map((part) => Number(part.trim()))
                  .filter((n) => Number.isFinite(n) && n > 0)
              })
            }
          />
        </label>
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm">Save</button>
      </form>
    </div>
  );
}
