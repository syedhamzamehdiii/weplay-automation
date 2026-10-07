export function StatCard({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 ${warn && Number(value) > 0 ? "border-orange-500/40" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-2 font-mono text-2xl ${warn && Number(value) > 0 ? "text-orange-300" : "text-zinc-50"}`}>{value}</div>
    </div>
  );
}
