import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function LoginPage() {
  const { user, signIn, setup, ready } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && setup && !setup.configured) {
    return <Navigate to="/setup" replace />;
  }
  if (user) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <strong style={{ color: "var(--amber)", letterSpacing: "0.12em", fontSize: "0.78rem" }}>SUB WAVE AI</strong>
      <h1>Sign in</h1>
      <p className="lede">Operator console. Credentials come from the secrets directory — nothing is hard-coded.</p>
      {error ? <div className="error">{error}</div> : null}
      <form onSubmit={onSubmit}>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="muted" style={{ marginTop: "1rem" }}>
        First run? <Link to="/setup">Open the configuration wizard</Link>
      </p>
    </div>
  );
}
