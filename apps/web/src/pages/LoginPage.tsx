import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api";

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setToken(result.token);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold">WePlay Automation</h1>
        <p className="text-sm text-zinc-400">Operator sign-in</p>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <label className="block text-sm">
          Username
          <input className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block text-sm">
          Password
          <input type="password" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium">Sign in</button>
      </form>
    </div>
  );
}
