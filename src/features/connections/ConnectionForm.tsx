import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AppInfo, ConnectionProfile, Driver, ServerInfo, SshConfig } from "../../types/backend";
import { api, toError, type BackendError } from "../../lib/ipc";
import { DRIVERS, ENVIRONMENTS, SAFETY_MODES, isFileDriver } from "../../lib/env";
import { Dialog } from "../../components/Dialog";
import { newProfile, useConnections } from "../../stores/connections";
import { resolveConnectError } from "./connectFlow";

interface Props {
  initial?: ConnectionProfile;
  /** A connection URL to parse into the form as soon as it opens (from the home screen). */
  initialUrl?: string;
  appInfo: AppInfo | null;
  onClose: () => void;
  onSaved: (profile: ConnectionProfile, connect: boolean) => void;
}

export function ConnectionForm({ initial, appInfo, onClose, onSaved }: Props) {
  const isEdit = !!initial;
  const keychainAvailable = appInfo?.credentialStoreAvailable ?? true;
  // Without a credential store, "save password" is impossible: default to asking.
  const fixMode = (x: ConnectionProfile): ConnectionProfile =>
    !keychainAvailable && x.passwordMode === "keychain" ? { ...x, passwordMode: "ask" } : x;
  const [p, setP] = useState<ConnectionProfile>(() => fixMode(initial ?? newProfile("postgres")));
  const [password, setPassword] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const [tested, setTested] = useState<ServerInfo | null>(null);
  const save = useConnections((s) => s.save);
  const sqlite = isFileDriver(p.driver);

  const set = (patch: Partial<ConnectionProfile>) => {
    setP((x) => ({ ...x, ...patch }));
    setTested(null);
  };

  const setDriver = (driver: Driver) => {
    const fresh = newProfile(driver);
    set({
      driver,
      port: fresh.port,
      host: isFileDriver(driver) ? "" : p.host || "localhost",
      ssh: isFileDriver(driver) ? null : p.ssh,
      passwordMode: isFileDriver(driver) ? "none" : p.passwordMode === "none" ? (keychainAvailable ? "keychain" : "ask") : p.passwordMode,
    });
  };

  const importUrl = async () => {
    setError(null);
    try {
      const parsed = await api.parseUrl(url);
      setP(fixMode({ ...parsed.profile, id: p.id, name: p.name || parsed.profile.name, environment: p.environment, safetyMode: p.safetyMode }));
      if (parsed.password) setPassword(parsed.password);
      setUrl("");
    } catch (e) {
      setError(toError(e));
    }
  };

  const validName = p.name.trim() || (sqlite ? p.filePath?.split(/[\\/]/).pop() : `${p.database || p.host}`) || "";
  const profileToSave = (): ConnectionProfile => ({
    ...p,
    name: validName,
    passwordMode: !keychainAvailable && p.passwordMode === "keychain" ? "ask" : p.passwordMode,
    ssh: p.ssh
      ? { ...p.ssh, secretMode: !keychainAvailable && p.ssh.secretMode === "keychain" ? "ask" : p.ssh.secretMode }
      : null,
  });

  const setSsh = (patch: Partial<SshConfig>) => p.ssh && set({ ssh: { ...p.ssh, ...patch } });
  const browseKey = async () => {
    const path = await openDialog({ multiple: false });
    if (typeof path === "string") setSsh({ keyPath: path });
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setTested(null);
    let secrets = { password: password || null, sshSecret: sshSecret || null };
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          setTested(await api.testConnection(profileToSave(), secrets.password, secrets.sshSecret));
          return;
        } catch (e) {
          const err = toError(e);
          const next = await resolveConnectError(err, profileToSave(), secrets);
          if (!next) throw err;
          secrets = next;
          if (next.password) setPassword(next.password);
          if (next.sshSecret) setSshSecret(next.sshSecret);
        }
      }
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (connect: boolean) => {
    setBusy("save");
    setError(null);
    try {
      const profile = profileToSave();
      const saved = await save(profile, password || null, profile.ssh ? sshSecret || null : null);
      onSaved(saved, connect);
    } catch (e) {
      setError(toError(e));
      setBusy(null);
    }
  };

  const browseFile = async () => {
    const filters =
      p.driver === "duckdb"
        ? [{ name: "DuckDB database", extensions: ["duckdb", "ddb", "db"] }, { name: "All files", extensions: ["*"] }]
        : [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "All files", extensions: ["*"] }];
    const path = await openDialog({ multiple: false, directory: false, filters });
    if (typeof path === "string") set({ filePath: path, name: p.name || path.split(/[\\/]/).pop() || "" });
  };

  const createFile = async () => {
    const duck = p.driver === "duckdb";
    const path = await saveDialog({
      defaultPath: duck ? "database.duckdb" : "database.sqlite",
      filters: [{ name: duck ? "DuckDB database" : "SQLite database", extensions: duck ? ["duckdb"] : ["sqlite", "db"] }],
    });
    if (!path) return;
    try {
      await api.createDatabaseFile(p.driver, path);
      set({ filePath: path, name: p.name || path.split(/[\\/]/).pop() || "" });
    } catch (e) {
      setError(toError(e));
    }
  };

  const browseCa = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "PEM certificate", extensions: ["pem", "crt", "cer"] }] });
    if (typeof path === "string") set({ tls: { ...p.tls, caCertPath: path } });
  };

  return (
    <Dialog
      title={isEdit ? `Edit ${initial.name}` : "New connection"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={test} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          {tested && (
            <span className="hint" role="status">
              Connected to {tested.product} {tested.version}
            </span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button className="btn" onClick={() => submit(false)} disabled={busy !== null || !validName}>
            Save
          </button>
          <button className="btn btn-primary" onClick={() => submit(true)} disabled={busy !== null || !validName}>
            Save and connect
          </button>
        </>
      }
    >
      {!isEdit && (
        <div className="field">
          <span className="hint">Paste a connection URL to fill the form</span>
          <div className="field-row">
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder="postgres://user:password@host:5432/database"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && url && importUrl()}
              aria-label="Connection URL"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn" onClick={importUrl} disabled={!url.trim()}>
              Fill from URL
            </button>
          </div>
        </div>
      )}

      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input className="input" value={p.name} placeholder={validName || "My database"} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Database type</span>
          <select className="select" value={p.driver} onChange={(e) => setDriver(e.target.value as Driver)} disabled={isEdit}>
            {DRIVERS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span>Environment</span>
          <select className="select" value={p.environment} onChange={(e) => set({ environment: e.target.value as ConnectionProfile["environment"] })}>
            {ENVIRONMENTS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Group</span>
          <input className="input" value={p.group ?? ""} placeholder="Optional, e.g. Billing" onChange={(e) => set({ group: e.target.value || null })} />
        </label>
      </div>

      {sqlite ? (
        <label className="field">
          <span>Database file</span>
          <div className="field-row">
            <input className="input mono" style={{ flex: 1 }} value={p.filePath ?? ""} onChange={(e) => set({ filePath: e.target.value || null })} />
            <button className="btn" onClick={browseFile}>
              Choose file…
            </button>
            <button className="btn" onClick={createFile}>
              Create new…
            </button>
          </div>
        </label>
      ) : (
        <>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Host</span>
              <input className="input mono" value={p.host} onChange={(e) => set({ host: e.target.value })} spellCheck={false} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Port</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={p.port ?? ""}
                onChange={(e) => set({ port: e.target.value ? Math.min(65535, Number(e.target.value.replace(/\D/g, "")) || 0) : null })}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>User</span>
              <input className="input mono" value={p.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>{p.driver === "redis" ? "Database number (0–15)" : "Database"}</span>
              <input className="input mono" value={p.database} onChange={(e) => set({ database: e.target.value })} spellCheck={false} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                placeholder={isEdit && p.passwordMode === "keychain" ? "Unchanged" : ""}
                disabled={p.passwordMode === "none"}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Password storage</span>
              <select className="select" value={p.passwordMode} onChange={(e) => set({ passwordMode: e.target.value as ConnectionProfile["passwordMode"] })}>
                <option value="keychain" disabled={!keychainAvailable}>
                  {keychainAvailable ? `Save in ${appInfo?.credentialStore ?? "system keychain"}` : "Save in system keychain (unavailable)"}
                </option>
                <option value="ask">Ask every time</option>
                <option value="none">No password</option>
              </select>
            </label>
          </div>
          {!keychainAvailable && (
            <div className="notice notice-warning">
              No system credential store was found, so passwords cannot be saved. You will be asked for the password when connecting; it is kept in memory until the app closes.
            </div>
          )}
          <div className="field-row">
            <label className="field">
              <span>TLS</span>
              <select className="select" value={p.tls.mode} onChange={(e) => set({ tls: { ...p.tls, mode: e.target.value as ConnectionProfile["tls"]["mode"] } })}>
                <option value="prefer">Prefer (use TLS when offered, verify certificate)</option>
                <option value="require">Require and verify certificate</option>
                <option value="require_insecure">Require, skip certificate verification</option>
                <option value="disable">Disable</option>
              </select>
            </label>
            <label className="field">
              <span>CA certificate (optional)</span>
              <div className="field-row">
                <input className="input mono" style={{ flex: 1 }} value={p.tls.caCertPath ?? ""} onChange={(e) => set({ tls: { ...p.tls, caCertPath: e.target.value || null } })} />
                <button className="btn" onClick={browseCa}>
                  Choose…
                </button>
              </div>
            </label>
          </div>
          {p.tls.mode === "require_insecure" && (
            <div className="notice notice-warning">Traffic is encrypted, but the server's identity is not checked. Anyone able to intercept the connection could impersonate the server.</div>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!p.ssh}
              onChange={(e) =>
                set({
                  ssh: e.target.checked
                    ? { host: "", port: 22, user: "", auth: "password", keyPath: null, secretMode: keychainAvailable ? "keychain" : "ask" }
                    : null,
                })
              }
            />
            Connect through an SSH tunnel
          </label>
          {p.ssh && (
            <>
              <div className="field-row">
                <label className="field" style={{ flex: 3 }}>
                  <span>SSH host (or ~/.ssh/config alias)</span>
                  <input className="input mono" value={p.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} spellCheck={false} />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span>SSH port</span>
                  <input
                    className="input mono"
                    inputMode="numeric"
                    value={p.ssh.port}
                    onChange={(e) => setSsh({ port: Math.min(65535, Number(e.target.value.replace(/\D/g, "")) || 22) })}
                  />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  <span>SSH user</span>
                  <input className="input mono" value={p.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} spellCheck={false} />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>SSH authentication</span>
                  <select className="select" value={p.ssh.auth} onChange={(e) => setSsh({ auth: e.target.value as SshConfig["auth"] })}>
                    <option value="password">Password</option>
                    <option value="key">Private key</option>
                  </select>
                </label>
                {p.ssh.auth === "key" && (
                  <label className="field" style={{ flex: 2 }}>
                    <span>Private key file</span>
                    <div className="field-row">
                      <input className="input mono" style={{ flex: 1 }} value={p.ssh.keyPath ?? ""} onChange={(e) => setSsh({ keyPath: e.target.value || null })} />
                      <button className="btn" onClick={browseKey}>
                        Choose…
                      </button>
                    </div>
                  </label>
                )}
              </div>
              <div className="field-row">
                <label className="field">
                  <span>{p.ssh.auth === "key" ? "Key passphrase (if any)" : "SSH password"}</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={sshSecret}
                    placeholder={isEdit && p.ssh.secretMode === "keychain" ? "Unchanged" : ""}
                    disabled={p.ssh.secretMode === "none"}
                    onChange={(e) => setSshSecret(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>SSH secret storage</span>
                  <select className="select" value={p.ssh.secretMode} onChange={(e) => setSsh({ secretMode: e.target.value as SshConfig["secretMode"] })}>
                    <option value="keychain" disabled={!keychainAvailable}>
                      {keychainAvailable ? `Save in ${appInfo?.credentialStore ?? "system keychain"}` : "Save in system keychain (unavailable)"}
                    </option>
                    <option value="ask">Ask every time</option>
                    <option value="none">None (unencrypted key)</option>
                  </select>
                </label>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                Host and port above are resolved from the SSH server. Host keys are checked against ~/.ssh/known_hosts; new hosts must be confirmed by fingerprint.
              </p>
            </>
          )}
        </>
      )}

      <div className="field-row">
        <label className="field">
          <span>Query safety</span>
          <select className="select" value={p.safetyMode} onChange={(e) => set({ safetyMode: e.target.value as ConnectionProfile["safetyMode"] })}>
            {SAFETY_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="hint">{SAFETY_MODES.find((m) => m.value === p.safetyMode)?.help}</span>
        </label>
        <label className="field">
          <span>Query timeout (seconds, 0 for none)</span>
          <input className="input" inputMode="numeric" value={p.queryTimeoutSecs} onChange={(e) => set({ queryTimeoutSecs: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        </label>
        {!sqlite && (
          <label className="field">
            <span>Connect timeout (seconds)</span>
            <input
              className="input"
              inputMode="numeric"
              value={p.connectTimeoutSecs}
              onChange={(e) => set({ connectTimeoutSecs: Math.max(1, Math.min(600, Number(e.target.value.replace(/\D/g, "")) || 1)) })}
            />
          </label>
        )}
      </div>
      {p.environment === "production" && p.safetyMode === "normal" && (
        <div className="notice notice-warning">This production connection runs statements without confirmation. Consider confirming destructive statements or read-only mode.</div>
      )}

      {error && (
        <div className="notice notice-error" role="alert">
          {error.message}
          {error.detail && <pre>{error.detail}</pre>}
        </div>
      )}
    </Dialog>
  );
}
