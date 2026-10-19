import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { AiSettings } from "./AiSettings";
import { Overlays } from "../../components/Overlays";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../../stores/settings";
import { useUi } from "../../stores/ui";
import type { AiStatus } from "../../types/backend";

type Call = { cmd: string; args: Record<string, unknown> };

const SECRET = "sk-ant-secret-123";
let calls: Call[] = [];
let keyStored = false;
let keyPersistent = true;
let failStatus = false;
let failSetKey = false;

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd);

function status(): AiStatus {
  const s = useSettings.getState().settings;
  return {
    config: { enabled: s["ai.enabled"], provider: s["ai.provider"], model: s["ai.model"], baseUrl: s["ai.baseUrl"] },
    keyStored,
    keyPersistent,
  };
}

beforeEach(() => {
  calls = [];
  keyStored = false;
  keyPersistent = true;
  failStatus = false;
  failSetKey = false;
  useUi.setState({ toasts: [], confirmRequest: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "ai_status") {
      if (failStatus) throw { kind: "internal", message: "store locked" };
      return status();
    }
    if (cmd === "ai_set_key") {
      if (failSetKey) throw { kind: "credentialStore", message: "Keyring refused the key" };
      keyStored = (a.request as { key: string | null }).key !== null;
      return null;
    }
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

function setup(settings: Partial<Settings> = {}) {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...settings } });
  return render(
    <>
      <AiSettings />
      <Overlays />
    </>,
  );
}

const toggle = () => screen.getByRole("switch", { name: /Offer AI help in query tabs/ });
const keyInput = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;

describe("AiSettings", () => {
  it("is off by default and shows no provider, endpoint or key fields", async () => {
    expect(DEFAULT_SETTINGS["ai.enabled"]).toBe(false);
    setup();
    await waitFor(() => expect(sent("ai_status")).toHaveLength(1));
    expect(toggle()).not.toBeChecked();
    expect(screen.getByText(/Every request is shown to you before it is sent/)).toBeInTheDocument();
    expect(screen.getByText(/never run automatically/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Endpoint/ })).not.toBeInTheDocument();
    expect(keyInput()).toBeNull();
  });

  it("turns on only after the user confirms what will be sent", async () => {
    setup();
    fireEvent.click(toggle());
    expect(await screen.findByText("Turn on AI assistance?")).toBeInTheDocument();
    expect(screen.getByText(/Row data is never sent/)).toBeInTheDocument();
    expect(screen.getByText(/only inserted into the editor, never run/)).toBeInTheDocument();
    expect(useSettings.getState().settings["ai.enabled"]).toBe(false);
    expect(sent("set_setting")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(useSettings.getState().settings["ai.enabled"]).toBe(true));
    expect(sent("set_setting").at(-1)!.args).toEqual({ key: "ai.enabled", value: true });
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("anthropic");
  });

  it("stays off when the confirmation is cancelled", async () => {
    setup();
    fireEvent.click(toggle());
    await screen.findByText("Turn on AI assistance?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Turn on AI assistance?")).not.toBeInTheDocument());
    expect(useSettings.getState().settings["ai.enabled"]).toBe(false);
    expect(sent("set_setting")).toHaveLength(0);
    expect(toggle()).not.toBeChecked();
  });

  it("turns off at once, without asking", async () => {
    setup({ "ai.enabled": true });
    fireEvent.click(toggle());
    await waitFor(() => expect(useSettings.getState().settings["ai.enabled"]).toBe(false));
    expect(screen.queryByText("Turn on AI assistance?")).not.toBeInTheDocument();
    expect(sent("set_setting").at(-1)!.args).toEqual({ key: "ai.enabled", value: false });
    expect(keyInput()).toBeNull();
  });

  it("shows the Anthropic defaults as placeholders and saves a trimmed model and endpoint on blur", async () => {
    setup({ "ai.enabled": true });
    const model = screen.getByRole("textbox", { name: /Model/ });
    const endpoint = screen.getByRole("textbox", { name: /Endpoint/ });
    expect(model).toHaveAttribute("placeholder", "claude-opus-5-5");
    expect(endpoint).toHaveAttribute("placeholder", "https://api.anthropic.com");
    expect(screen.getByText("Leave empty for the default.")).toBeInTheDocument();
    expect(screen.getByText(/Plain http is only accepted for a server on this computer/)).toBeInTheDocument();

    fireEvent.change(model, { target: { value: "  claude-sonnet  " } });
    expect(sent("set_setting")).toHaveLength(0);
    fireEvent.blur(model);
    fireEvent.change(endpoint, { target: { value: "https://proxy.example.com " } });
    fireEvent.blur(endpoint);
    await waitFor(() => expect(sent("set_setting")).toHaveLength(2));
    expect(sent("set_setting").map((c) => c.args)).toEqual([
      { key: "ai.model", value: "claude-sonnet" },
      { key: "ai.baseUrl", value: "https://proxy.example.com" },
    ]);
    expect(useSettings.getState().settings["ai.model"]).toBe("claude-sonnet");
  });

  it("does not save a field that was left unchanged", () => {
    setup({ "ai.enabled": true, "ai.model": "claude-x" });
    const model = screen.getByRole("textbox", { name: /Model/ });
    expect(model).toHaveValue("claude-x");
    fireEvent.change(model, { target: { value: " claude-x " } });
    fireEvent.blur(model);
    expect(sent("set_setting")).toHaveLength(0);
  });

  it("switching to a local server changes the defaults, labels and re-reads the key status", async () => {
    setup({ "ai.enabled": true });
    await waitFor(() => expect(sent("ai_status")).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openai_compatible" } });
    expect(useSettings.getState().settings["ai.provider"]).toBe("openai_compatible");
    expect(screen.getByRole("textbox", { name: /Model/ })).toHaveAttribute("placeholder", "for example qwen2.5-coder");
    expect(screen.getByRole("textbox", { name: /Endpoint/ })).toHaveAttribute("placeholder", "http://127.0.0.1:11434/v1");
    expect(screen.getByText("Required.")).toBeInTheDocument();
    expect(screen.getByText("API key (optional)")).toBeInTheDocument();
    await waitFor(() => expect(sent("ai_status")).toHaveLength(2));
  });

  it("saves the key to the credential store, clears the field and never writes it to settings", async () => {
    setup({ "ai.enabled": true });
    expect(screen.getByText("Anthropic API key")).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("type", "password");
    expect(keyInput()).toHaveAttribute("autocomplete", "off");
    expect(keyInput()).toHaveAttribute("placeholder", "Not set");
    const save = screen.getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();
    fireEvent.change(keyInput(), { target: { value: "   " } });
    expect(save).toBeDisabled();

    fireEvent.change(keyInput(), { target: { value: SECRET } });
    fireEvent.click(save);
    await waitFor(() => expect(sent("ai_set_key")).toHaveLength(1));
    expect(sent("ai_set_key")[0]!.args).toEqual({ request: { provider: "anthropic", key: SECRET } });
    expect(await screen.findByText("API key saved")).toBeInTheDocument();
    await waitFor(() => expect(keyInput()).toHaveAttribute("placeholder", "Saved. Type a new key to replace it"));
    expect(keyInput()).toHaveValue("");

    // The key appears nowhere on screen, in the settings store or in any settings write.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(JSON.stringify(useSettings.getState().settings)).not.toContain(SECRET);
    expect(sent("set_setting")).toHaveLength(0);
    expect(screen.getByText("Stored in the system credential store, never in the app's files.")).toBeInTheDocument();
  });

  it("removes a stored key", async () => {
    keyStored = true;
    setup({ "ai.enabled": true });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sent("ai_set_key")).toHaveLength(1));
    expect(sent("ai_set_key")[0]!.args).toEqual({ request: { provider: "anthropic", key: null } });
    expect(await screen.findByText("API key removed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument());
    expect(keyInput()).toHaveAttribute("placeholder", "Not set");
  });

  it("saves the key for the selected local provider", async () => {
    setup({ "ai.enabled": true, "ai.provider": "openai_compatible" });
    fireEvent.change(keyInput(), { target: { value: "local-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(sent("ai_set_key")).toHaveLength(1));
    expect(sent("ai_set_key")[0]!.args).toEqual({ request: { provider: "openai_compatible", key: "local-key" } });
  });

  it("says the key is kept only in memory when there is no credential store", async () => {
    keyPersistent = false;
    setup({ "ai.enabled": true });
    expect(await screen.findByText(/No system credential store is available, so the key is kept in memory until the app closes/)).toBeInTheDocument();
  });

  it("reports a failed key save and keeps the typed key so it can be retried", async () => {
    failSetKey = true;
    setup({ "ai.enabled": true });
    fireEvent.change(keyInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/Could not save the API key/)).toBeInTheDocument();
    expect(screen.queryByText("API key saved")).not.toBeInTheDocument();
    expect(keyInput()).toHaveValue(SECRET);
    // Shown only as a masked password field.
    expect(keyInput()).toHaveAttribute("type", "password");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("reports when the AI status cannot be read", async () => {
    failStatus = true;
    setup({ "ai.enabled": true });
    expect(await screen.findByText(/Could not read AI settings/)).toBeInTheDocument();
    expect(keyInput()).toHaveAttribute("placeholder", "Not set");
  });
});
