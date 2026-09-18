import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../auth";

const LINKS = [
  { to: "/", label: "Dashboard" },
  { to: "/requests", label: "Requests" },
  { to: "/jobs", label: "Jobs" },
  { to: "/logs", label: "Errors / logs" },
  { to: "/disk", label: "Disk" },
  { to: "/settings", label: "Settings" },
  { to: "/wizard", label: "Wizard" },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="shell">
      <aside className={open ? "nav" : "nav collapsed"}>
        <div className="brand">
          <strong>SUB WAVE AI</strong>
          <span>Operator console</span>
        </div>
        <button className="btn menu-toggle" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide menu" : "Menu"}
        </button>
        <div className="nav-links">
          {LINKS.filter((link) => {
            if ((link.to === "/jobs" || link.to === "/logs") && user?.role !== "admin") return false;
            return true;
          }).map((link) => (
            <NavLink key={link.to} to={link.to} end={link.to === "/"} onClick={() => setOpen(false)}>
              {link.label}
            </NavLink>
          ))}
        </div>
        <div className="nav-foot">
          <div>{user?.username}</div>
          <div>{user?.role}</div>
          <button
            className="linkish"
            type="button"
            onClick={async () => {
              await signOut();
              navigate("/login");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
