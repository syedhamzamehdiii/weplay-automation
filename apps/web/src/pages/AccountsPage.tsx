import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isWePlaySignedIn, providerLabel, weplayName } from "../accountIdentity";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import type { Account } from "../types";

export function AccountsPage() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Account[]>("/api/accounts") });
  const signedIn = (accounts.data ?? []).filter(isWePlaySignedIn);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Accounts</h1>
      <div className="mb-4 flex flex-wrap gap-3">
        <Link
          to="/accounts/import"
          className="inline-flex rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
        >
          Import identities
        </Link>
        <Link
          to="/accounts/create"
          className="inline-flex rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600"
        >
          Create WePlay Accounts
        </Link>
        <Link
          to="/jobs"
          className="inline-flex rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Create job
        </Link>
        <p className="mt-2 w-full text-xs text-zinc-500">
          This list shows identities that have signed in to WePlay at least once. Import or Create WePlay Accounts
          starts Device Farm; READY accounts appear here after the Pixel run verifies the session.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Provider</th>
              <th className="px-4 py-2">WePlay name</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {signedIn.map((account) => (
              <tr key={account.id} className="border-t border-zinc-800">
                <td className="px-4 py-2">
                  <Link className="text-sky-300 hover:underline" to={`/accounts/${account.id}`}>
                    {account.displayName}
                  </Link>
                </td>
                <td className="px-4 py-2">{providerLabel(account.loginProvider)}</td>
                <td className="px-4 py-2 font-mono text-xs">{weplayName(account)}</td>
                <td className="px-4 py-2">
                  <StatusBadge value={account.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.isLoading ? <p className="px-4 py-3 text-sm text-zinc-500">Loading accounts…</p> : null}
        {!accounts.isLoading && signedIn.length === 0 ? (
          <p className="px-4 py-3 text-sm text-zinc-500">
            No WePlay-signed-in accounts yet. Start Device Farm from Create WePlay Accounts; this table fills after a
            verified WePlay login.
          </p>
        ) : null}
      </div>
    </div>
  );
}
