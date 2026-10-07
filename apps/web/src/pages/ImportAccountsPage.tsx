import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { OAUTH_PROVIDERS, providerLabel, type OauthProvider } from "../accountIdentity";
import { api } from "../api";
import type { Account } from "../types";

interface IdentityRow {
  displayName: string;
  loginProvider: OauthProvider;
  email: string;
  handle: string;
}

function emptyRow(loginProvider: OauthProvider = "GOOGLE"): IdentityRow {
  return { displayName: "", loginProvider, email: "", handle: "" };
}

function identifierPlaceholder(provider: OauthProvider): string {
  if (provider === "X") {
    return "Handle (e.g. @name)";
  }
  if (provider === "FACEBOOK") {
    return "Facebook email or username";
  }
  return "Google email";
}

export function ImportAccountsPage() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<OauthProvider>("GOOGLE");
  const [rows, setRows] = useState<IdentityRow[]>([emptyRow("GOOGLE")]);

  const importIdentities = useMutation({
    mutationFn: () =>
      api<{ accounts: Account[] }>("/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          startSetup: false,
          identities: rows
            .filter((row) => row.displayName.trim())
            .map((row) => ({
              displayName: row.displayName.trim(),
              loginProvider: row.loginProvider,
              email: row.email.trim() || undefined,
              handle: row.handle.trim() || undefined
            }))
        })
      }),
    onSuccess: () => navigate("/accounts")
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    importIdentities.mutate();
  }

  function updateRow(index: number, patch: Partial<IdentityRow>) {
    setRows((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link to="/accounts" className="text-sm text-zinc-500">
          ← Accounts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Import identities</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Register existing Google, Facebook, or X logins you already own. All three providers use the same account
          record. After import, open the account and start the Device Farm worker to create or sign in to the matching
          WePlay account on a fresh Amazon Pixel. This form never asks for passwords, OTP, or CAPTCHA.
        </p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <fieldset>
          <legend className="text-sm font-medium">Default provider for new rows</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {OAUTH_PROVIDERS.map((option) => (
              <button
                key={option}
                type="button"
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  provider === option ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-300"
                }`}
                onClick={() => setProvider(option)}
              >
                {providerLabel(option)}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-2 rounded-lg border border-zinc-800 p-3 md:grid-cols-[1fr_140px_1fr_auto]">
              <input
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                placeholder={`Display name ${index + 1}`}
                value={row.displayName}
                onChange={(e) => updateRow(index, { displayName: e.target.value })}
              />
              <select
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={row.loginProvider}
                onChange={(e) => updateRow(index, { loginProvider: e.target.value as OauthProvider })}
              >
                {OAUTH_PROVIDERS.map((option) => (
                  <option key={option} value={option}>
                    {providerLabel(option)}
                  </option>
                ))}
              </select>
              {row.loginProvider === "X" ? (
                <input
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  placeholder={identifierPlaceholder(row.loginProvider)}
                  value={row.handle}
                  onChange={(e) => updateRow(index, { handle: e.target.value })}
                />
              ) : (
                <input
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  placeholder={identifierPlaceholder(row.loginProvider)}
                  type={row.loginProvider === "GOOGLE" ? "email" : "text"}
                  value={row.email}
                  onChange={(e) => updateRow(index, { email: e.target.value })}
                />
              )}
              <button
                type="button"
                className="rounded-lg bg-zinc-800 px-3 py-2 text-sm"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          Google identities with a Workspace email can start Device Farm immediately. Facebook and X are stored the same
          way; the current Pixel worker still signs into WePlay with Google after Play Store install.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm"
            onClick={() => setRows((current) => [...current, emptyRow(provider)])}
          >
            Add identity
          </button>
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm" disabled={importIdentities.isPending}>
            {importIdentities.isPending ? "Importing…" : "Import identities"}
          </button>
        </div>
        {importIdentities.error ? <p className="text-sm text-rose-400">{(importIdentities.error as Error).message}</p> : null}
      </form>
    </div>
  );
}
