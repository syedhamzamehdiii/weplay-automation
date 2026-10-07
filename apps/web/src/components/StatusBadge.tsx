const COLORS: Record<string, string> = {
  READY: "bg-emerald-500/15 text-emerald-300",
  SUCCESS: "bg-emerald-500/15 text-emerald-300",
  SUCCEEDED: "bg-emerald-500/15 text-emerald-300",
  IDLE: "bg-emerald-500/15 text-emerald-300",
  RUNNING: "bg-sky-500/15 text-sky-300",
  PROCESSING: "bg-sky-500/15 text-sky-300",
  BUSY: "bg-sky-500/15 text-sky-300",
  ACTIVE: "bg-emerald-500/15 text-emerald-300",
  SUSPENDED: "bg-rose-500/15 text-rose-300",
  QUEUED: "bg-zinc-500/20 text-zinc-300",
  ASSIGNED: "bg-indigo-500/15 text-indigo-300",
  CREATING: "bg-sky-500/15 text-sky-300",
  CREATION_FAILED: "bg-rose-500/15 text-rose-300",
  ACTION_REQUIRED: "bg-amber-500/15 text-amber-300",
  SETUP_REQUIRED: "bg-amber-500/15 text-amber-300",
  SETUP_IN_PROGRESS: "bg-amber-500/15 text-amber-300",
  NEEDS_REAUTH: "bg-orange-500/20 text-orange-300",
  FAILED: "bg-rose-500/15 text-rose-300",
  ERROR: "bg-rose-500/15 text-rose-300",
  OFFLINE: "bg-zinc-700 text-zinc-400",
  DISABLED: "bg-zinc-700 text-zinc-400",
  STOPPED: "bg-zinc-700 text-zinc-400",
  PAUSED: "bg-amber-500/15 text-amber-300",
  CANCELLED: "bg-zinc-700 text-zinc-400",
  RETRYING: "bg-amber-500/15 text-amber-300",
  PENDING: "bg-zinc-500/20 text-zinc-300",
  VALIDATING: "bg-indigo-500/15 text-indigo-300",
  CREATED: "bg-emerald-500/15 text-emerald-300",
  ALREADY_EXISTS: "bg-sky-500/15 text-sky-300",
  DRAFT: "bg-zinc-500/20 text-zinc-300",
  INACTIVE: "bg-zinc-700 text-zinc-400",
  Inactive: "bg-zinc-700 text-zinc-400",
  Active: "bg-emerald-500/15 text-emerald-300",
  Running: "bg-sky-500/15 text-sky-300",
  COMPLETED: "bg-emerald-500/15 text-emerald-300"
};

export function StatusBadge({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${COLORS[value] ?? "bg-zinc-800 text-zinc-300"}`}>
      {value}
    </span>
  );
}
