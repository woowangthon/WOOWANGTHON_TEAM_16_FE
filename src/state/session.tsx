import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setToken, setUnauthorizedHandler } from "../api/client";
import { loadJson, removeKey, saveJson } from "../lib/storage";

interface StoredSession {
  token: string;
  username: string;
  expiresAt: string;
}

interface SessionValue {
  token: string | null;
  username: string | null;
  mockOnly: boolean;
  // 서버가 토큰을 거부해 자동으로 로그아웃된 경우(서버 재시작 등)
  expired: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  enterMock: () => void;
  exitMock: () => void;
}

const SESSION_KEY = "wm.session";
const MOCK_KEY = "wm.mockOnly";

function readSession(): StoredSession | null {
  const s = loadJson<StoredSession | null>(SESSION_KEY, null);
  if (!s || !s.token || !(Date.parse(s.expiresAt) > Date.now())) return null;
  return s;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => {
    const s = readSession();
    setToken(s?.token ?? null);
    return s;
  });
  const [mockOnly, setMockOnly] = useState<boolean>(() => loadJson(MOCK_KEY, false));
  const [expired, setExpired] = useState(false);

  const logout = useCallback(() => {
    setToken(null);
    removeKey(SESSION_KEY);
    setSession(null);
    setExpired(false);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      setExpired(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    const s = { token: res.token, username: res.username, expiresAt: res.expires_at };
    setToken(s.token);
    saveJson(SESSION_KEY, s);
    setSession(s);
    setExpired(false);
    setMockOnly(false);
    saveJson(MOCK_KEY, false);
  }, []);

  const enterMock = useCallback(() => {
    setMockOnly(true);
    saveJson(MOCK_KEY, true);
  }, []);

  const exitMock = useCallback(() => {
    setMockOnly(false);
    saveJson(MOCK_KEY, false);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      token: session?.token ?? null,
      username: session?.username ?? null,
      mockOnly,
      expired,
      login,
      logout,
      enterMock,
      exitMock,
    }),
    [session, mockOnly, expired, login, logout, enterMock, exitMock],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("SessionProvider가 필요합니다.");
  return v;
}
