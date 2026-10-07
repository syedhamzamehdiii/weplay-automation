import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { clearToken } from "../api";
import { DeviceFarmStatus } from "./DeviceFarmStatus";
import { useLiveUpdates } from "../useLiveUpdates";

const LINKS = [
  ["/", "Dashboard"],
  ["/workspace", "Google Workspace"],
  ["/accounts", "Accounts"],
  ["/jobs", "Jobs"],
  ["/settings", "Settings"]
] as const;

export function Layout() {
  useLiveUpdates();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <aside className="fixed inset-y-0 left-0 w-56 border-r border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-8 font-semibold tracking-tight">WePlay Ops</div>
        <nav className="space-y-1">
          {LINKS.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm ${isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-white"}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-8">
          <DeviceFarmStatus compact />
        </div>
        <button
          className="mt-8 text-xs text-zinc-500 hover:text-zinc-300"
          onClick={() => {
            clearToken();
            navigate("/login");
          }}
        >
          Sign out
        </button>
      </aside>
      <div className="ml-56">
        <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <DeviceFarmStatus />
        </header>
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
