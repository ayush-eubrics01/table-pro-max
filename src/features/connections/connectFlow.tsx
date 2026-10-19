import { api, toError, type BackendError } from "../../lib/ipc";
import { confirmAction, promptText } from "../../stores/ui";
import type { ConnectionProfile, SessionInfo } from "../../types/backend";

export interface Secrets {
  password: string | null;
  sshSecret: string | null;
}

/**
 * Turns a recoverable connection error into user input: asks for a missing password or
 * SSH secret, or asks the user to confirm an unknown SSH host key. Returns updated
 * secrets to retry with, or null when the user cancelled or the error is not recoverable.
 */
export async function resolveConnectError(err: BackendError, profile: ConnectionProfile, secrets: Secrets): Promise<Secrets | null> {
  if (err.code === "ssh_unknown_host") {
    const [fingerprint, key, hostPort] = (err.detail ?? "").split("\n");
    const sep = hostPort?.lastIndexOf(":") ?? -1;
    const host = hostPort && sep > 0 ? hostPort.slice(0, sep) : (profile.ssh?.host ?? "");
    const port = hostPort && sep > 0 ? Number(hostPort.slice(sep + 1)) : (profile.ssh?.port ?? 22);
    const ok = await confirmAction({
      title: "Trust this SSH host?",
      confirmLabel: "Trust and connect",
      body: (
        <>
          <p style={{ margin: 0 }}>
            This is the first connection to <strong className="mono">{host}:{port}</strong>. Compare this fingerprint with the one
            your server administrator gives you before continuing.
          </p>
          <pre className="code-block">{fingerprint}</pre>
          <p className="hint" style={{ margin: 0 }}>
            The key is saved in this app's known-hosts file. If it ever changes, the connection will be refused.
          </p>
        </>
      ),
    });
    if (!ok || !key) return null;
    await api.trustSshHost(host, port, key);
    return secrets;
  }
  if (err.code === "ssh_secret_required" || (err.kind === "authentication" && err.message.startsWith("SSH"))) {
    const keyAuth = profile.ssh?.auth === "key";
    const value = await promptText({
      title: `Connect to ${profile.name}`,
      label: keyAuth ? `Passphrase for ${profile.ssh?.keyPath ?? "SSH key"}` : `SSH password for ${profile.ssh?.user || "user"}@${profile.ssh?.host}`,
      description: err.code === "ssh_secret_required" ? "Kept in memory until the app closes." : `${err.message}. Try again.`,
      confirmLabel: "Continue",
      secret: true,
    });
    return value === null ? null : { ...secrets, sshSecret: value };
  }
  if (err.code === "password_required" || err.kind === "authentication") {
    const value = await promptText({
      title: `Connect to ${profile.name}`,
      label: `Password for ${profile.user || "user"}@${profile.host}`,
      description: err.code === "password_required" ? "This password is kept in memory until the app closes." : `${err.message}. Try again.`,
      confirmLabel: "Connect",
      secret: true,
    });
    return value === null ? null : { ...secrets, password: value };
  }
  return null;
}

/**
 * Opens a session, asking for passwords and host-key trust as needed. Secrets typed here
 * are remembered in memory for this app run only (never on disk).
 */
export async function connectWithPrompt(
  profile: ConnectionProfile,
  database?: string | null,
  options: {
    readOnly?: boolean;
    lockProduction?: boolean;
    connectId?: string;
    /** Stops asking for passwords once the attempt was cancelled. */
    cancelled?: () => boolean;
    /** Called before each try (the first, and each retry after a prompt). */
    onAttempt?: () => void;
  } = {},
): Promise<SessionInfo | null> {
  let secrets: Secrets = { password: null, sshSecret: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      options.onAttempt?.();
      return await api.connect(profile.id, {
        password: secrets.password,
        sshSecret: secrets.sshSecret,
        database,
        rememberForSession: secrets.password !== null || secrets.sshSecret !== null,
        readOnly: options.readOnly ?? false,
        lockProduction: options.lockProduction,
        connectId: options.connectId,
      });
    } catch (e) {
      const err = toError(e);
      if (options.cancelled?.()) throw err;
      const next = await resolveConnectError(err, profile, secrets);
      if (!next) {
        if (err.code === "password_required" || err.code === "ssh_secret_required" || err.code === "ssh_unknown_host") return null;
        throw err;
      }
      secrets = next;
    }
  }
  return null;
}

export async function reconnectWithPrompt(sessionId: string, profile: ConnectionProfile): Promise<SessionInfo | null> {
  let secrets: Secrets = { password: null, sshSecret: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await api.reconnect(sessionId, secrets.password, secrets.sshSecret);
    } catch (e) {
      const err = toError(e);
      const next = await resolveConnectError(err, profile, secrets);
      if (!next) throw err;
      secrets = next;
    }
  }
  return null;
}

/** MongoDB counterpart of `connectWithPrompt`: production opens read-only unless `lockProduction` is false. */
export async function connectMongoWithPrompt(profile: ConnectionProfile, opts: { lockProduction?: boolean } = {}) {
  let secrets: Secrets = { password: null, sshSecret: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await api.mongoConnect(profile.id, {
        password: secrets.password,
        sshSecret: secrets.sshSecret,
        rememberForSession: secrets.password !== null || secrets.sshSecret !== null,
        lockProduction: opts.lockProduction,
      });
    } catch (e) {
      const err = toError(e);
      const next = await resolveConnectError(err, profile, secrets);
      if (!next) {
        if (err.code === "password_required" || err.code === "ssh_secret_required" || err.code === "ssh_unknown_host") return null;
        throw err;
      }
      secrets = next;
    }
  }
  return null;
}

/** Redis counterpart of `connectWithPrompt`. */
export async function connectRedisWithPrompt(profile: ConnectionProfile) {
  let secrets: Secrets = { password: null, sshSecret: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await api.redisConnect(profile.id, {
        password: secrets.password,
        sshSecret: secrets.sshSecret,
        rememberForSession: secrets.password !== null || secrets.sshSecret !== null,
      });
    } catch (e) {
      const err = toError(e);
      const next = await resolveConnectError(err, profile, secrets);
      if (!next) {
        if (err.code === "password_required" || err.code === "ssh_secret_required" || err.code === "ssh_unknown_host") return null;
        throw err;
      }
      secrets = next;
    }
  }
  return null;
}
