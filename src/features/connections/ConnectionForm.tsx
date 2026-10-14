import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AppInfo, ConnectionProfile, Driver, ServerInfo, SshConfig } from "../../types/backend";
import { withoutPassword } from "../../lib/url";
import { radioKeyDown } from "../../lib/radio";
import { api, toError, type BackendError } from "../../lib/ipc";
import { DRIVERS, ENVIRONMENTS, SAFETY_MODES, envStyle, isFileDriver } from "../../lib/env";
import { Icon } from "../../components/Icon";
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

export function ConnectionForm({ initial, initialUrl, appInfo, onClose, onSaved }: Props) {
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

  // Switching engine (by click or by arrowing through the tiles) must not lose what was typed:
  // each engine keeps its own port, and the server settings come back after a file engine.
  const ports = useRef<Partial<Record<Driver, number | null>>>({});
  const network = useRef<Pick<ConnectionProfile, "host" | "ssh" | "passwordMode"> | null>(null);
  const setDriver = (driver: Driver) => {
    const fresh = newProfile(driver);
    ports.current[p.driver] = p.port;
    if (!isFileDriver(p.driver)) network.current = { host: p.host, ssh: p.ssh, passwordMode: p.passwordMode };
    const net = network.current;
    set({
      driver,
      port: ports.current[driver] !== undefined ? ports.current[driver]! : fresh.port,
      host: isFileDriver(driver) ? "" : net?.host || p.host || "localhost",
      ssh: isFileDriver(driver) ? null : (net?.ssh ?? p.ssh),
      passwordMode: isFileDriver(driver)
        ? "none"
        : (net?.passwordMode ?? p.passwordMode) === "none"
          ? keychainAvailable
            ? "keychain"
            : "ask"
          : (net?.passwordMode ?? p.passwordMode),
    });
  };

  const importFrom = async (source: string): Promise<boolean> => {
    setError(null);
    try {
      const parsed = await api.parseUrl(source);
      setP(fixMode({ ...parsed.profile, id: p.id, name: p.name || parsed.profile.name, environment: p.environment, safetyMode: p.safetyMode }));
      if (parsed.password) setPassword(parsed.password);
      setUrl("");
      return true;
    } catch (e) {
      setError(toError(e));
      return false;
    }
  };
  const importUrl = () => importFrom(url);

  // A URL pasted on the home screen is parsed straight away. If it cannot be read, the URL field
  // gets it back for editing, but without its password, which never reaches the screen.
  useEffect(() => {
    if (initialUrl) void importFrom(initialUrl).then((ok) => !ok && setUrl(withoutPassword(initialUrl)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const passwordStorage = (value: ConnectionProfile["passwordMode"] | SshConfig["secretMode"], onChange: (v: string) => void, label: string, noneLabel: string) => (
    <select className="select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="keychain" disabled={!keychainAvailable}>
        {keychainAvailable ? `In ${appInfo?.credentialStore ?? "system keychain"}` : "In system keychain (unavailable)"}
      </option>
      <option value="ask">Ask every time</option>
      <option value="none">{noneLabel}</option>
    </select>
  );

  return (
    <Dialog
      title={isEdit ? `Edit ${initial.name}` : "New connection"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={test} disabled={busy !== null}>
            <Icon name="speed" size={15} /> {busy === "test" ? "Testing…" : "Test"}
          </button>
          <span className={tested ? "hint test-ok" : "hint"} role="status">
            {tested ? `Connected to ${tested.product} ${tested.version}` : "Test before saving — nothing is stored until you save."}
          </span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button className="btn" onClick={() => submit(false)} disabled={busy !== null || !validName}>
            Save
          </button>
          <button className="btn btn-primary" onClick={() => submit(true)} disabled={busy !== null || !validName}>
            Save &amp; connect
          </button>
        </>
      }
    >
      {!isEdit && (
        <div className="field">
          <div className="field-row url-field">
            <Icon name="open_in_new" size={15} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-faint)" }} />
            <input
              className="input mono"
              style={{ flex: 1, paddingLeft: 32 }}
              placeholder="Paste a URL — postgres://user:pass@host:5432/db"
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
          <span className="hint">Optional — or fill the fields by hand.</span>
        </div>
      )}

      <div role="radiogroup" aria-label="Database type" className="engine-tiles">
        {DRIVERS.map((d) => (
          <button
            key={d.value}
            role="radio"
            aria-checked={p.driver === d.value}
            tabIndex={p.driver === d.value ? 0 : -1}
            disabled={isEdit && p.driver !== d.value}
            onClick={() => d.value !== p.driver && setDriver(d.value)}
            onKeyDown={(e) =>
              radioKeyDown(
                e,
                DRIVERS.map((x) => x.value),
                p.driver,
                (v) => v !== p.driver && setDriver(v),
                (v) => !(isEdit && v !== p.driver),
              )
            }
          >
            <span className="driver-mark">{d.short}</span>
            {d.label}
          </button>
        ))}
      </div>

      <h3 className="form-section">General</h3>
      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input className="input" value={p.name} placeholder={validName || "e.g. Billing staging"} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Group · optional</span>
          <input className="input" value={p.group ?? ""} placeholder="e.g. Billing" onChange={(e) => set({ group: e.target.value || null })} />
        </label>
      </div>
      <div className="field">
        <span className="hint">Environment — colours the window so you always know where you are</span>
        <div role="radiogroup" aria-label="Environment" className="env-chips">
          {ENVIRONMENTS.map((e) => (
            <button
              key={e.value}
              role="radio"
              aria-checked={p.environment === e.value}
              tabIndex={p.environment === e.value ? 0 : -1}
              style={envStyle(e.value)}
              onClick={() => set({ environment: e.value })}
              onKeyDown={(k) =>
                radioKeyDown(
                  k,
                  ENVIRONMENTS.map((x) => x.value),
                  p.environment,
                  (v) => set({ environment: v }),
                )
              }
            >
              <span className="env-dot" />
              {e.label}
            </button>
          ))}
        </div>
      </div>

      {sqlite ? (
        <>
          <h3 className="form-section">File</h3>
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
        </>
      ) : (
        <>
          <h3 className="form-section">Server</h3>
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
            <div className="field">
              <span>Remember password</span>
              {passwordStorage(p.passwordMode, (v) => set({ passwordMode: v as ConnectionProfile["passwordMode"] }), "Remember password", "No password")}
            </div>
          </div>
          {!keychainAvailable && (
            <div className="notice notice-warning">
              No system credential store was found, so passwords cannot be saved. You will be asked for the password when connecting; it is kept in memory until the app closes.
            </div>
          )}

          <h3 className="form-section">Security</h3>
          <div className="field-row">
            <div className="field">
              <span>TLS</span>
              <select className="select" aria-label="TLS" value={p.tls.mode} onChange={(e) => set({ tls: { ...p.tls, mode: e.target.value as ConnectionProfile["tls"]["mode"] } })}>
                <option value="prefer">Prefer — use TLS if offered (certificate verified)</option>
                <option value="require">Require and verify the certificate</option>
                <option value="require_insecure">Require, skip certificate verification</option>
                <option value="disable">Disable</option>
              </select>
            </div>
            <label className="field">
              <span>CA certificate · optional</span>
              <div className="field-row">
                <input className="input mono" style={{ flex: 1 }} placeholder="None" value={p.tls.caCertPath ?? ""} onChange={(e) => set({ tls: { ...p.tls, caCertPath: e.target.value || null } })} />
                <button className="btn" onClick={browseCa}>
                  Choose…
                </button>
              </div>
            </label>
          </div>
          {p.tls.mode === "require_insecure" && (
            <div className="notice notice-warning">Traffic is encrypted, but the server's identity is not checked. Anyone able to intercept the connection could impersonate the server.</div>
          )}

          <label className="toggle-card">
            <Icon name="key" size={16} />
            <span>
              <strong>Connect through an SSH tunnel</strong>
              <span className="hint">For databases inside a private network</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={!!p.ssh}
              onChange={(e) =>
                set({
                  ssh: e.target.checked
                    ? { host: "", port: 22, user: "", auth: "password", keyPath: null, secretMode: keychainAvailable ? "keychain" : "ask" }
                    : null,
                })
              }
            />
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
                <div className="field">
                  <span>Remember SSH secret</span>
                  {passwordStorage(p.ssh.secretMode, (v) => setSsh({ secretMode: v as SshConfig["secretMode"] }), "Remember SSH secret", "None (unencrypted key)")}
                </div>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                Host and port above are resolved from the SSH server. Host keys are checked against ~/.ssh/known_hosts; new hosts must be confirmed by fingerprint.
              </p>
            </>
          )}
        </>
      )}

      <details
        className="form-collapse"
        open={
          !!initial &&
          ((["safetyMode", "connectTimeoutSecs", "queryTimeoutSecs", "keepaliveSecs"] as const).some((k) => initial[k] !== newProfile(initial.driver)[k]) || initial.restorePoints === false)
        }
      >
        <summary>Safety &amp; timeouts</summary>
        <div className="field-row">
          <label className="field">
            <span>Query safety</span>
            <select className="select" aria-label="Query safety" value={p.safetyMode} onChange={(e) => set({ safetyMode: e.target.value as ConnectionProfile["safetyMode"] })}>
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
        {p.driver !== "redis" && (
          <label className="toggle-card">
            <Icon name="history" size={16} />
            <span>
              <strong>Keep restore points</strong>
              <span className="hint">Before a statement or a grid commit changes rows, a copy of them is kept on this computer for a few days, so the change can be put back.</span>
            </span>
            <input type="checkbox" className="switch" checked={p.restorePoints !== false} onChange={(e) => set({ restorePoints: e.target.checked })} />
          </label>
        )}
      </details>
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
