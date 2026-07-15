import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { setBaseUrl } from "./api";
import { KEYS, storage } from "./storage";

export interface StoredUser {
  username: string;
  role: string;
}

interface AppConfig {
  /** False until the persisted server/user have loaded from storage. */
  ready: boolean;
  serverUrl: string | null;
  user: StoredUser | null;
  /** Persist + activate a validated server address. */
  saveServer: (url: string) => Promise<void>;
  /** Forget the server (and user) — sends the user back to onboarding. */
  changeServer: () => Promise<void>;
  /** Persist the signed-in user after a successful login. */
  setUser: (user: StoredUser) => Promise<void>;
  /** Forget the user (keep the server) — back to the login screen. */
  signOut: () => Promise<void>;
}

const Ctx = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
  const value = useContext(Ctx);
  if (!value) throw new Error("useConfig must be used within <ConfigProvider>");
  return value;
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [user, setUserState] = useState<StoredUser | null>(null);

  useEffect(() => {
    (async () => {
      const [url, rawUser] = await Promise.all([
        storage.get(KEYS.serverUrl),
        storage.get(KEYS.user),
      ]);
      if (url) {
        setBaseUrl(url);
        setServerUrl(url);
      }
      if (rawUser) {
        try {
          setUserState(JSON.parse(rawUser) as StoredUser);
        } catch {
          // ignore corrupt value
        }
      }
      setReady(true);
    })();
  }, []);

  const saveServer = async (url: string) => {
    const clean = url.replace(/\/+$/, "");
    await storage.set(KEYS.serverUrl, clean);
    setBaseUrl(clean);
    setServerUrl(clean);
  };

  const changeServer = async () => {
    await Promise.all([storage.remove(KEYS.serverUrl), storage.remove(KEYS.user)]);
    setServerUrl(null);
    setUserState(null);
  };

  const setUser = async (next: StoredUser) => {
    await storage.set(KEYS.user, JSON.stringify(next));
    setUserState(next);
  };

  const signOut = async () => {
    await storage.remove(KEYS.user);
    setUserState(null);
  };

  return (
    <Ctx.Provider value={{ ready, serverUrl, user, saveServer, changeServer, setUser, signOut }}>
      {children}
    </Ctx.Provider>
  );
}
