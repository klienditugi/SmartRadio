import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, login as loginRequest, logout as logoutRequest, setToken } from "./api";
import type { PublicUser, SetupStatus } from "./types";

type AuthState = {
  user: PublicUser | null;
  ready: boolean;
  setup: SetupStatus | null;
  refreshSetup: () => Promise<SetupStatus | null>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [ready, setReady] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);

  const refreshSetup = useCallback(async () => {
    try {
      const next = await api<SetupStatus>("/setup");
      setSetup(next);
      return next;
    } catch {
      setSetup(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshSetup();
      if (!getToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      try {
        const res = await api<{ user: PublicUser }>("/auth/me");
        if (!cancelled) setUser(res.user);
      } catch {
        setToken(null);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSetup]);

  const signIn = useCallback(async (username: string, password: string) => {
    const res = await loginRequest(username, password);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, ready, setup, refreshSetup, signIn, signOut }),
    [user, ready, setup, refreshSetup, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
