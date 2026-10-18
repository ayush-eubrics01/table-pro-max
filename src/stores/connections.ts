import { create } from "zustand";
import { api } from "../lib/ipc";
import type { ConnectionProfile, StoredConnection } from "../types/backend";
import { uid } from "../lib/text";

interface ConnectionsState {
  connections: StoredConnection[];
  loading: boolean;
  load: () => Promise<void>;
  save: (profile: ConnectionProfile, password: string | null, sshSecret?: string | null) => Promise<ConnectionProfile>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  byId: (id: string) => ConnectionProfile | undefined;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  loading: false,
  load: async () => {
    set({ loading: true });
    try {
      set({ connections: await api.listConnections() });
    } finally {
      set({ loading: false });
    }
  },
  save: async (profile, password, sshSecret = null) => {
    const saved = await api.saveConnection(profile, password, sshSecret);
    await get().load();
    return saved;
  },
  remove: async (id) => {
    await api.deleteConnection(id);
    await get().load();
  },
  duplicate: async (id) => {
    await api.duplicateConnection(id);
    await get().load();
  },
  byId: (id) => get().connections.find((c) => c.profile.id === id)?.profile,
}));

export function newProfile(driver: ConnectionProfile["driver"] = "postgres"): ConnectionProfile {
  const sqlite = driver === "sqlite" || driver === "duckdb";
  return {
    id: uid(),
    name: "",
    driver,
    host: sqlite ? "" : "localhost",
    port: driver === "postgres" ? 5432 : driver === "redis" ? 6379 : driver === "mssql" ? 1433 : sqlite ? null : 3306,
    user: "",
    database: "",
    filePath: null,
    tls: { mode: driver === "redis" ? "disable" : "prefer", caCertPath: null },
    passwordMode: sqlite || driver === "redis" ? "none" : "keychain",
    environment: "local",
    safetyMode: "confirm_destructive",
    color: null,
    group: null,
    tags: [],
    connectTimeoutSecs: 10,
    queryTimeoutSecs: 0,
    keepaliveSecs: 60,
    ssh: null,
    restorePoints: true,
  };
}
