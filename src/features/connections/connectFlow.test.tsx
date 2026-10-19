import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { connectMongoWithPrompt, connectRedisWithPrompt, connectWithPrompt, reconnectWithPrompt, resolveConnectError } from "./connectFlow";
import { Overlays } from "../../components/Overlays";
import { BackendError } from "../../lib/ipc";
import { useUi } from "../../stores/ui";
import type { ConnectionProfile } from "../../types/backend";
import { profile, session } from "../../test/fixtures";

type Call = { cmd: string; args: Record<string, unknown> };

const PASSWORD = "s3cret-Pa55";
const passwordRequired = { kind: "authentication", message: "Enter the password for Local PG", code: "password_required" };
const sshProfile = (auth: "password" | "key"): ConnectionProfile => ({
  ...profile,
  passwordMode: "ask",
  ssh: { host: "bastion.example.com", port: 2222, user: "deploy", auth, keyPath: auth === "key" ? "~/.ssh/id_ed25519" : null, secretMode: "ask" },
});
const unknownHost = (detail: string) => ({
  kind: "ssh",
  message: "The SSH host bastion.example.com:2222 is not known. Verify its fingerprint before trusting it.",
  code: "ssh_unknown_host",
  detail,
});
const HOST_DETAIL = "SHA256:Zq1fingerprint\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\nbastion.example.com:2222";

let calls: Call[] = [];
/** Answers each command in turn: an object is thrown as a backend error, anything else returned. */
let answers: Record<string, unknown[]> = {};
const fail = (e: object) => ({ __throw: e });

beforeEach(() => {
  calls = [];
  answers = {};
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const queue = answers[cmd];
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (next && typeof next === "object" && "__throw" in next) throw (next as { __throw: unknown }).__throw;
    return next ?? null;
  });
  render(<Overlays />);
});
afterEach(() => {
  cleanup();
  clearMocks();
  useUi.setState({ confirmRequest: null, promptRequest: null, toasts: [] });
  localStorage.clear();
  vi.restoreAllMocks();
});

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const requests = (cmd: string) => sent(cmd).map((a) => a.request as Record<string, unknown>);

/** Types into the open secret prompt and submits it. */
async function answerPrompt(value: string, confirmLabel = "Connect") {
  const dialog = await screen.findByRole("dialog");
  const input = dialog.querySelector("input")!;
  expect(input).toHaveAttribute("type", "password");
  fireEvent.change(input, { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: confirmLabel }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

async function dismissDialog() {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("connectWithPrompt", () => {
  it("connects without asking when the keychain has the password, sending no secrets", async () => {
    answers.connect = [session];
    const result = await connectWithPrompt(profile, "analytics");
    expect(result).toEqual(session);
    expect(requests("connect")).toEqual([
      {
        connectionId: "conn-1",
        password: null,
        sshSecret: null,
        database: "analytics",
        rememberForSession: false,
        readOnly: false,
        lockProduction: null,
        connectId: null,
      },
    ]);
    expect(useUi.getState().promptRequest).toBeNull();
  });

  it("asks for a missing password in a masked field and retries with it, remembered for this run only", async () => {
    answers.connect = [fail(passwordRequired), session];
    const attempt = connectWithPrompt({ ...profile, passwordMode: "ask" });
    const dialog = await screen.findByRole("dialog", { name: "Connect to Local PG" });
    expect(dialog).toHaveTextContent("Password for app@localhost");
    expect(dialog).toHaveTextContent("This password is kept in memory until the app closes.");
    await answerPrompt(PASSWORD);
    expect(await attempt).toEqual(session);
    expect(requests("connect").map((r) => [r.password, r.rememberForSession])).toEqual([
      [null, false],
      [PASSWORD, true],
    ]);
  });

  it("keeps the typed password out of app state, browser storage and the console", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    answers.connect = [fail(passwordRequired), session];
    const attempt = connectWithPrompt({ ...profile, passwordMode: "ask" });
    await answerPrompt(PASSWORD);
    await attempt;
    // Only the connect request carries it, and no other command is sent.
    expect(calls.map((c) => c.cmd)).toEqual(["connect", "connect"]);
    expect(JSON.stringify(useUi.getState())).not.toContain(PASSWORD);
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "");
    const session_ = Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? "");
    expect([...stored, ...session_].join("\n")).not.toContain(PASSWORD);
    for (const spy of logged) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it("names a generic user when the profile has none", async () => {
    answers.connect = [fail(passwordRequired), session];
    const attempt = connectWithPrompt({ ...profile, user: "" });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Password for user@localhost");
    await answerPrompt("x");
    await attempt;
  });

  it("opens nothing and shows no error when the password prompt is cancelled", async () => {
    answers.connect = [fail(passwordRequired)];
    const attempt = connectWithPrompt(profile);
    await dismissDialog();
    expect(await attempt).toBeNull();
    expect(sent("connect")).toHaveLength(1);
  });

  it("asks again after a wrong password, saying why", async () => {
    answers.connect = [fail(passwordRequired), fail({ kind: "authentication", message: 'password authentication failed for user "app"' }), session];
    const attempt = connectWithPrompt(profile);
    await answerPrompt("wrong");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('password authentication failed for user "app". Try again.');
    await answerPrompt(PASSWORD);
    expect(await attempt).toEqual(session);
    expect(requests("connect").map((r) => r.password)).toEqual([null, "wrong", PASSWORD]);
  });

  it("passes on the error when a wrong password is followed by Cancel", async () => {
    answers.connect = [fail({ kind: "authentication", message: "password authentication failed" })];
    const failed = expect(connectWithPrompt(profile)).rejects.toMatchObject({ message: "password authentication failed" });
    await dismissDialog();
    await failed;
  });

  it("gives up after five attempts and says why", async () => {
    answers.connect = [fail({ kind: "authentication", message: "password authentication failed" })];
    // Handled from the start: it rejects while the prompts are still being answered.
    const attempt = expect(connectWithPrompt(profile)).rejects.toMatchObject({ kind: "authentication" });
    for (let i = 0; i < 5; i++) await answerPrompt(`try${i}`);
    await attempt;
    expect(sent("connect")).toHaveLength(5);
  });

  it("opens production read-only or writable as asked, and passes the read-only flag and progress id", async () => {
    answers.connect = [session];
    await connectWithPrompt(profile, null, { lockProduction: true });
    await connectWithPrompt(profile, null, { lockProduction: false, readOnly: true, connectId: "c-9" });
    expect(requests("connect").map((r) => [r.lockProduction, r.readOnly, r.connectId, r.database])).toEqual([
      [true, false, null, null],
      [false, true, "c-9", null],
    ]);
  });

  it("calls onAttempt before the first try and before each retry", async () => {
    answers.connect = [fail(passwordRequired), session];
    const onAttempt = vi.fn();
    const attempt = connectWithPrompt(profile, null, { onAttempt });
    await screen.findByRole("dialog");
    expect(onAttempt).toHaveBeenCalledTimes(1);
    await answerPrompt(PASSWORD);
    await attempt;
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it("asks nothing once the attempt was cancelled and passes the error on", async () => {
    answers.connect = [fail(passwordRequired)];
    await expect(connectWithPrompt(profile, null, { cancelled: () => true })).rejects.toMatchObject({ code: "password_required" });
    expect(useUi.getState().promptRequest).toBeNull();
    expect(sent("connect")).toHaveLength(1);
  });

  it("passes on errors it cannot resolve without asking", async () => {
    answers.connect = [fail({ kind: "network", message: "Connection refused" })];
    await expect(connectWithPrompt(profile)).rejects.toBeInstanceOf(BackendError);
    expect(useUi.getState().promptRequest).toBeNull();
    expect(useUi.getState().confirmRequest).toBeNull();
  });

  describe("SSH", () => {
    it("asks to trust an unknown host key, showing host, port and fingerprint, then saves it and connects", async () => {
      answers.connect = [fail(unknownHost(HOST_DETAIL)), session];
      const attempt = connectWithPrompt(sshProfile("password"));
      const dialog = await screen.findByRole("dialog", { name: "Trust this SSH host?" });
      expect(dialog).toHaveTextContent("first connection to bastion.example.com:2222");
      expect(dialog).toHaveTextContent("SHA256:Zq1fingerprint");
      fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
      expect(await attempt).toEqual(session);
      expect(sent("trust_ssh_host")).toEqual([{ host: "bastion.example.com", port: 2222, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA" }]);
      expect(calls.map((c) => c.cmd)).toEqual(["connect", "trust_ssh_host", "connect"]);
    });

    it("trusts nothing and opens nothing when the host key is refused", async () => {
      answers.connect = [fail(unknownHost(HOST_DETAIL))];
      const attempt = connectWithPrompt(sshProfile("password"));
      await dismissDialog();
      expect(await attempt).toBeNull();
      expect(sent("trust_ssh_host")).toEqual([]);
      expect(sent("connect")).toHaveLength(1);
    });

    it("falls back to the profile's SSH host when the error does not name one, and trusts nothing without a key", async () => {
      answers.connect = [fail(unknownHost("SHA256:only"))];
      const attempt = connectWithPrompt(sshProfile("password"));
      const dialog = await screen.findByRole("dialog", { name: "Trust this SSH host?" });
      expect(dialog).toHaveTextContent("bastion.example.com:2222");
      fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
      expect(await attempt).toBeNull();
      expect(sent("trust_ssh_host")).toEqual([]);
    });

    it("asks for the SSH password and retries with it, keeping the database password unset", async () => {
      answers.connect = [fail({ kind: "authentication", message: "Enter the SSH password for Local PG", code: "ssh_secret_required" }), session];
      const attempt = connectWithPrompt(sshProfile("password"));
      const dialog = await screen.findByRole("dialog", { name: "Connect to Local PG" });
      expect(dialog).toHaveTextContent("SSH password for deploy@bastion.example.com");
      expect(dialog).toHaveTextContent("Kept in memory until the app closes.");
      await answerPrompt("tunnel-pw", "Continue");
      expect(await attempt).toEqual(session);
      expect(requests("connect")[1]).toMatchObject({ password: null, sshSecret: "tunnel-pw", rememberForSession: true });
    });

    it("asks for the key passphrase with key authentication", async () => {
      answers.connect = [fail({ kind: "ssh", message: "The SSH key is encrypted; enter its passphrase", code: "ssh_secret_required" }), session];
      const attempt = connectWithPrompt(sshProfile("key"));
      expect(await screen.findByRole("dialog")).toHaveTextContent("Passphrase for ~/.ssh/id_ed25519");
      await answerPrompt("phrase", "Continue");
      await attempt;
      expect(requests("connect")[1]!.sshSecret).toBe("phrase");
    });

    it("asks for the SSH password again after the tunnel refused it", async () => {
      answers.connect = [fail({ kind: "authentication", message: "SSH authentication failed for deploy@bastion.example.com" }), session];
      const attempt = connectWithPrompt(sshProfile("password"));
      expect(await screen.findByRole("dialog")).toHaveTextContent("SSH authentication failed for deploy@bastion.example.com. Try again.");
      await answerPrompt("again", "Continue");
      await attempt;
      expect(requests("connect")[1]).toMatchObject({ sshSecret: "again", password: null });
    });

    it("opens nothing when the SSH secret prompt is cancelled", async () => {
      answers.connect = [fail({ kind: "authentication", message: "Enter the SSH password", code: "ssh_secret_required" })];
      const attempt = connectWithPrompt(sshProfile("password"));
      await dismissDialog();
      expect(await attempt).toBeNull();
    });

    it("keeps an SSH secret typed earlier when the database password is asked next", async () => {
      answers.connect = [fail({ kind: "authentication", message: "Enter the SSH password", code: "ssh_secret_required" }), fail(passwordRequired), session];
      const attempt = connectWithPrompt(sshProfile("password"));
      await answerPrompt("tunnel-pw", "Continue");
      await answerPrompt(PASSWORD);
      await attempt;
      expect(requests("connect").map((r) => [r.sshSecret, r.password])).toEqual([
        [null, null],
        ["tunnel-pw", null],
        ["tunnel-pw", PASSWORD],
      ]);
    });
  });
});

describe("resolveConnectError", () => {
  it("returns nothing for errors that no answer can fix", async () => {
    const err = new BackendError({ kind: "database", message: "relation does not exist" });
    expect(await resolveConnectError(err, profile, { password: null, sshSecret: null })).toBeNull();
    expect(useUi.getState().promptRequest).toBeNull();
  });
});

describe("reconnectWithPrompt", () => {
  it("reconnects the session without secrets when none are needed", async () => {
    answers.reconnect = [session];
    expect(await reconnectWithPrompt("sess-1", profile)).toEqual(session);
    expect(sent("reconnect")).toEqual([{ sessionId: "sess-1", password: null, sshSecret: null }]);
  });

  it("asks for the password and reconnects with it", async () => {
    answers.reconnect = [fail(passwordRequired), session];
    const attempt = reconnectWithPrompt("sess-1", profile);
    expect(await screen.findByRole("dialog", { name: "Connect to Local PG" })).toHaveTextContent("Password for app@localhost");
    await answerPrompt(PASSWORD);
    expect(await attempt).toEqual(session);
    expect(sent("reconnect")[1]).toEqual({ sessionId: "sess-1", password: PASSWORD, sshSecret: null });
  });

  it("asks to trust a new SSH host key before reconnecting", async () => {
    answers.reconnect = [fail(unknownHost(HOST_DETAIL)), session];
    const attempt = reconnectWithPrompt("sess-1", sshProfile("password"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Trust this SSH host?" })).getByRole("button", { name: "Trust and connect" }));
    expect(await attempt).toEqual(session);
    expect(sent("trust_ssh_host")).toHaveLength(1);
  });

  it("returns nothing when the password prompt is cancelled, as a connect does", async () => {
    answers.reconnect = [fail(passwordRequired)];
    const attempt = reconnectWithPrompt("sess-1", profile);
    await dismissDialog();
    expect(await attempt).toBeNull();
    expect(sent("reconnect")).toHaveLength(1);
  });

  it("gives up after five attempts and says why", async () => {
    answers.reconnect = [fail({ kind: "authentication", message: "password authentication failed" })];
    // Handled from the start: it rejects while the prompts are still being answered.
    const attempt = expect(reconnectWithPrompt("sess-1", profile)).rejects.toMatchObject({ kind: "authentication" });
    for (let i = 0; i < 5; i++) await answerPrompt(`try${i}`);
    await attempt;
    expect(sent("reconnect")).toHaveLength(5);
  });
});

describe("connectMongoWithPrompt", () => {
  const mongo = { ...profile, driver: "mongodb" as const };
  const opened = { sessionId: "m-1", info: { version: "7.0" } };

  it("connects without secrets, leaving production locking to the setting unless asked", async () => {
    answers.mongo_connect = [opened];
    expect(await connectMongoWithPrompt(mongo)).toEqual(opened);
    await connectMongoWithPrompt(mongo, { lockProduction: true });
    await connectMongoWithPrompt(mongo, { lockProduction: false });
    expect(requests("mongo_connect")).toEqual([
      { connectionId: "conn-1", password: null, sshSecret: null, rememberForSession: false, lockProduction: null },
      { connectionId: "conn-1", password: null, sshSecret: null, rememberForSession: false, lockProduction: true },
      { connectionId: "conn-1", password: null, sshSecret: null, rememberForSession: false, lockProduction: false },
    ]);
  });

  it("asks for the password and retries with it, keeping the production lock", async () => {
    answers.mongo_connect = [fail(passwordRequired), opened];
    const attempt = connectMongoWithPrompt(mongo, { lockProduction: true });
    await answerPrompt(PASSWORD);
    expect(await attempt).toEqual(opened);
    expect(requests("mongo_connect")[1]).toEqual({ connectionId: "conn-1", password: PASSWORD, sshSecret: null, rememberForSession: true, lockProduction: true });
  });

  it("opens nothing when the prompt is cancelled and passes other errors on", async () => {
    answers.mongo_connect = [fail(passwordRequired)];
    const attempt = connectMongoWithPrompt(mongo);
    await dismissDialog();
    expect(await attempt).toBeNull();

    answers.mongo_connect = [fail({ kind: "network", message: "Server selection timed out" })];
    await expect(connectMongoWithPrompt(mongo)).rejects.toMatchObject({ message: "Server selection timed out" });
  });

  it("gives up after five attempts and says why", async () => {
    answers.mongo_connect = [fail({ kind: "authentication", message: "Authentication failed." })];
    // Handled from the start: it rejects while the prompts are still being answered.
    const attempt = expect(connectMongoWithPrompt(mongo)).rejects.toMatchObject({ kind: "authentication" });
    for (let i = 0; i < 5; i++) await answerPrompt(`try${i}`);
    await attempt;
    expect(sent("mongo_connect")).toHaveLength(5);
  });
});

describe("connectRedisWithPrompt", () => {
  const redis = { ...profile, driver: "redis" as const };
  const opened = { sessionId: "r-1", info: { version: "7.2" } };

  it("connects without secrets", async () => {
    answers.redis_connect = [opened];
    expect(await connectRedisWithPrompt(redis)).toEqual(opened);
    expect(requests("redis_connect")).toEqual([{ connectionId: "conn-1", password: null, sshSecret: null, rememberForSession: false }]);
  });

  it("asks for the password and retries with it", async () => {
    answers.redis_connect = [fail({ kind: "authentication", message: "WRONGPASS invalid username-password pair" }), opened];
    const attempt = connectRedisWithPrompt(redis);
    expect(await screen.findByRole("dialog")).toHaveTextContent("WRONGPASS invalid username-password pair. Try again.");
    await answerPrompt(PASSWORD);
    expect(await attempt).toEqual(opened);
    expect(requests("redis_connect")[1]).toEqual({ connectionId: "conn-1", password: PASSWORD, sshSecret: null, rememberForSession: true });
  });

  it("asks to trust an unknown SSH host and opens nothing when refused", async () => {
    answers.redis_connect = [fail(unknownHost(HOST_DETAIL))];
    const attempt = connectRedisWithPrompt({ ...redis, ssh: sshProfile("password").ssh });
    expect(await screen.findByRole("dialog", { name: "Trust this SSH host?" })).toBeInTheDocument();
    await dismissDialog();
    expect(await attempt).toBeNull();
    expect(sent("trust_ssh_host")).toEqual([]);
  });

  it("passes other errors on", async () => {
    answers.redis_connect = [fail({ kind: "network", message: "Connection refused" })];
    await expect(connectRedisWithPrompt(redis)).rejects.toMatchObject({ message: "Connection refused" });
  });

  it("gives up after five attempts and says why", async () => {
    answers.redis_connect = [fail({ kind: "authentication", message: "WRONGPASS" })];
    // Handled from the start: it rejects while the prompts are still being answered.
    const attempt = expect(connectRedisWithPrompt(redis)).rejects.toMatchObject({ kind: "authentication" });
    for (let i = 0; i < 5; i++) await answerPrompt(`try${i}`);
    await attempt;
    expect(sent("redis_connect")).toHaveLength(5);
  });
});
